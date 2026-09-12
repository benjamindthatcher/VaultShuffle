#!/usr/bin/env python3
"""Exercise M2 quota idempotency and full/pinned observation fencing.

The harness uses only the local/portable psql client and Python's standard
library. It deliberately opens two independent PostgreSQL connections for
each interleaving. The explicitly supplied setup login is also the session
login for those connections; every runtime call uses transaction-local
``SET LOCAL ROLE`` and no cluster role membership is changed. All synthetic
account data is deleted in finally blocks; quota rows are adjusted only by the
number of calls made by this harness.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class PsqlConfig:
    executable: str
    host: str
    port: str
    database: str
    admin_user: str

    def command(self) -> list[str]:
        return [
            self.executable,
            "-h", self.host,
            "-p", self.port,
            "-U", self.admin_user,
            "-d", self.database,
            "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        ]


def run(config: PsqlConfig, sql: str, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        config.command(), input=sql, text=True, capture_output=True,
        check=False, timeout=timeout,
    )


def scalar(config: PsqlConfig, sql: str) -> str:
    result = run(config, sql)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "psql scalar query failed")
    values = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not values:
        raise RuntimeError("psql scalar query returned no value")
    return values[-1]


def json_scalar(config: PsqlConfig, sql: str) -> dict[str, object]:
    try:
        value = json.loads(scalar(config, sql))
    except (json.JSONDecodeError, RuntimeError) as error:
        raise RuntimeError(f"expected JSON query result: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError("expected JSON object query result")
    return value


def pg_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def assert_runtime_roles(config: PsqlConfig) -> None:
    """Verify the supplied setup login can switch roles transaction-locally."""
    result = run(config, """
begin;
set local role vault_app;
reset role;
set local role vault_worker;
rollback;
""")
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or "--admin-user must be able to SET LOCAL ROLE vault_app and vault_worker"
        )


def fixture_provider(config: PsqlConfig) -> dict[str, object]:
    original = json_scalar(config, """
select json_build_object('mode', mode, 'reason', reason)
  from ops.provider_controls where provider = 'steam';
""")
    result = run(config, """
update ops.provider_controls
   set mode = 'fixture', reason = 'M2 two-connection rollback harness',
       updated_at = clock_timestamp()
 where provider = 'steam';
""")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "could not enable fixture provider mode")
    return original


def restore_provider(config: PsqlConfig, original: dict[str, object]) -> None:
    mode = original.get("mode")
    reason = original.get("reason")
    if not isinstance(mode, str) or not isinstance(reason, str):
        raise RuntimeError("invalid saved provider control")
    result = run(config, f"""
update ops.provider_controls
   set mode = {pg_text(mode)}, reason = {pg_text(reason)}, updated_at = clock_timestamp()
 where provider = 'steam';
""")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "could not restore provider mode")


def run_duplicate_attempt(config: PsqlConfig) -> dict[str, object]:
    """Two transactions race the same pre-session attempt UUID."""
    attempt = "00000000-0000-4000-8000-000000004001"
    first = subprocess.Popen(
        config.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, bufsize=1,
    )
    assert first.stdin is not None and first.stdout is not None
    first.stdin.write(f"""
begin;
set local role vault_app;
set local app.m2_fixture = 'on';
set local app.account_id = '';
select * from app.consume_provider_attempt(
  'profile', 1, {pg_text(attempt)}::uuid, 120
);
select 'READY';
select pg_sleep(1.5);
commit;
""")
    first.stdin.close()
    ready = False
    first_output: list[str] = []
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        line = first.stdout.readline()
        if line == "":
            break
        line = line.strip()
        if line:
            first_output.append(line)
        if line == "READY":
            ready = True
            break
    if not ready:
        first.kill()
        first.wait(timeout=5)
        stderr = first.stderr.read().strip() if first.stderr else ""
        raise RuntimeError(f"first duplicate-attempt transaction did not reach barrier: {first_output} {stderr}")

    second = run(config, f"""
begin;
set local role vault_app;
set local app.m2_fixture = 'on';
set local app.account_id = '';
select * from app.consume_provider_attempt(
  'profile', 1, {pg_text(attempt)}::uuid, 120
);
commit;
""", timeout=15.0)
    first.wait(timeout=15)
    first_stderr = first.stderr.read().strip() if first.stderr else ""
    if first.returncode != 0:
        raise RuntimeError(f"first duplicate-attempt transaction failed: {first_stderr}")
    if second.returncode != 0:
        raise RuntimeError(second.stderr.strip() or "second duplicate-attempt transaction failed")
    second_rows = [line.strip() for line in second.stdout.splitlines() if line.strip()]
    if len(second_rows) != 1 or "attempt_already_charged" not in second_rows[0]:
        raise RuntimeError(f"duplicate attempt was not rejected safely: {second_rows}")
    if "|" not in second_rows[0] or not second_rows[0].split("|")[3] == "":
        raise RuntimeError("duplicate attempt returned a reusable bearer token")

    count = int(scalar(config, f"select count(*) from ops.provider_call_charges where attempt_id = {pg_text(attempt)}::uuid;"))
    if count != 1:
        raise RuntimeError(f"duplicate attempt produced {count} charge rows")
    cleanup = run(config, f"""
delete from ops.provider_call_charges where attempt_id = {pg_text(attempt)}::uuid;
update ops.provider_quota_daily
   set charged_units = greatest(0, charged_units - 1), updated_at = clock_timestamp()
 where provider = 'steam'
   and usage_date = (clock_timestamp() at time zone 'UTC')::date
   and lane_scope = 'all';
update ops.provider_token_buckets
   set tokens = least(capacity, tokens + 1), last_refilled_at = clock_timestamp(),
       updated_at = clock_timestamp()
 where provider = 'steam' and bucket_scope = 'global';
""")
    if cleanup.returncode != 0:
        raise RuntimeError(cleanup.stderr.strip() or "duplicate-attempt cleanup failed")
    return {"attempt_id": attempt, "charge_rows": count, "second_row": second_rows[0]}


def create_account_and_game(config: PsqlConfig, key: str) -> tuple[int, int]:
    public_id = str(uuid.uuid4())
    account = int(scalar(config, f"""
insert into app.accounts(public_id, account_kind, display_name)
values ({pg_text(public_id)}::uuid, 'manual', {pg_text('M2 concurrency ' + key)})
returning id;
"""))
    result = run(config, f"""
insert into app.steam_profiles(account_id, steam_id, verified, display_name)
values ({account}, {76561198000004000 + account}, false, {pg_text('M2 concurrency ' + key)});
""")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "could not create concurrency profile")
    game = int(scalar(config, f"""
insert into catalog.games(steam_app_id, title, normalized_sort_title)
values ({4000 + account}, {pg_text('M2 concurrency ' + key + ' Game')}, {pg_text('m2 concurrency ' + key + ' game')})
returning id;
"""))
    return account, game


def app_request(config: PsqlConfig, account: int, request_key: str) -> dict[str, object]:
    return json_scalar(config, f"""
begin;
set local role vault_app;
set local app.m2_fixture = 'on';
set local app.account_id = {pg_text(str(account))};
select row_to_json(r) from app.request_owned_snapshot({pg_text(request_key)}::uuid, 'interactive') as r;
commit;
""")


def worker_claim(config: PsqlConfig) -> dict[str, object]:
    return json_scalar(config, """
begin;
set local role vault_worker;
set local app.m2_fixture = 'on';
set local app.account_id = '';
select row_to_json(r) from ops.claim_job('interactive', 120) as r where r.claimed;
commit;
""")


def begin_pin(config: PsqlConfig, account: int, game: int) -> dict[str, object]:
    return json_scalar(config, f"""
begin;
set local role vault_app;
set local app.m2_fixture = 'on';
set local app.account_id = {pg_text(str(account))};
select row_to_json(r) from app.begin_pinned_owned_refresh({game}) as r;
commit;
""")


def run_observation_fence(config: PsqlConfig) -> dict[str, object]:
    """A pinned writer waits on an account sync lock, then beats full sweep."""
    account, game = create_account_and_game(config, "fence")
    charges = 0
    writer: subprocess.Popen[str] | None = None
    try:
        setup = run(config, f"""
insert into app.library_games(account_id, game_id, playtime_minutes)
values ({account}, {game}, 30);
insert into app.pins(account_id, scope, slot, game_id, personal_minutes_baseline)
values ({account}, 'library', 1, {game}, 30);
""")
        if setup.returncode != 0:
            raise RuntimeError(setup.stderr.strip() or "could not seed observation fixture")
        request_key = str(uuid.uuid4())
        request = app_request(config, account, request_key)
        if request.get("status") not in {"enqueued", "queued"}:
            raise RuntimeError(f"observation request did not enqueue: {request}")
        claim = worker_claim(config)
        if claim.get("job_kind") != "owned_snapshot":
            raise RuntimeError(f"observation request claim was not owned_snapshot: {claim}")
        pin = begin_pin(config, account, game)
        if pin.get("allowed") is not True:
            raise RuntimeError(f"pinned observation attempt was not allowed: {pin}")
        charges = 2

        writer = subprocess.Popen(
            config.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        assert writer.stdin is not None and writer.stdout is not None
        writer.stdin.write(f"""
begin;
select 1 from app.library_sync_state where account_id = {account} for update;
select 'READY';
select pg_sleep(1.5);
commit;
""")
        writer.stdin.close()
        ready = False
        while True:
            line = writer.stdout.readline()
            if line == "":
                break
            if line.strip() == "READY":
                ready = True
                break
        if not ready:
            raise RuntimeError("observation lock holder did not reach barrier")

        pinned = json_scalar(config, f"""
begin;
set local role vault_app;
set local app.m2_fixture = 'on';
set local app.account_id = {pg_text(str(account))};
select row_to_json(r) from app.record_pinned_owned_observation(
  {pg_text(str(pin['attempt_id']))}::uuid,
  {pg_text(str(pin['attempt_token']))}::uuid,
  jsonb_build_object('status','complete','provider','steam','appId',{pg_text(str(4000 + account))},
    'playtimeMinutes',null,'lastPlayedAtEpochSeconds',null,'lastPlayedSource','not_provided')
) as r;
commit;
""")
        if pinned.get("accepted") is not True:
            raise RuntimeError(f"pinned observation lost after sync lock wait: {pinned}")
        writer.wait(timeout=10)
        if writer.returncode != 0:
            stderr = writer.stderr.read().strip() if writer.stderr else ""
            raise RuntimeError(f"observation lock holder failed: {stderr}")

        canonical = '{"provider":"steam","protocolVersion":1,"gameCount":0,"games":[]}'
        publish = json_scalar(config, f"""
begin;
set local role vault_worker;
set local app.m2_fixture = 'on';
set local app.account_id = '';
select row_to_json(r) from ops.publish_owned_snapshot(
  {pg_text(str(claim['job_id']))}::uuid,
  {pg_text(str(claim['lease_token']))}::uuid,
  jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
    'scope','complete_owned','includeAppInfo',true,'includePlayedFreeGames',true,
    'skipUnvettedApps',false,'httpStatus',200,'gameCount',0,
    'bodyBytes',octet_length(convert_to({pg_text(canonical)},'UTF8'))),
  {pg_text(canonical)}, sha256(convert_to({pg_text(canonical)},'UTF8')),
  clock_timestamp(), {claim['message_id']}) as r;
commit;
""")
        if publish.get("result") != "applied" or int(publish.get("sweep_deferred_count", 0)) < 1:
            raise RuntimeError(f"newer pinned observation did not defer full sweep: {publish}")
        remaining = int(scalar(config, f"select count(*) from app.library_games where account_id = {account} and game_id = {game};"))
        if remaining != 1:
            raise RuntimeError("full sweep removed the newer pinned library row")
        return {
            "account_id": account,
            "game_id": game,
            "pinned": pinned,
            "publish": publish,
            "remaining_library_rows": remaining,
        }
    finally:
        if writer is not None and writer.poll() is None:
            writer.kill()
            writer.wait(timeout=5)
        cleanup = run(config, f"""
delete from app.accounts where id = {account};
delete from catalog.games where id = {game};
update ops.provider_quota_daily
   set charged_units = greatest(0, charged_units - {charges}), updated_at = clock_timestamp()
 where provider = 'steam'
   and usage_date = (clock_timestamp() at time zone 'UTC')::date
   and lane_scope = 'all';
update ops.provider_token_buckets
   set tokens = least(capacity, tokens + {charges}), last_refilled_at = clock_timestamp(),
       updated_at = clock_timestamp()
 where provider = 'steam' and bucket_scope = 'global';
""")
        if cleanup.returncode != 0:
            raise RuntimeError(cleanup.stderr.strip() or "observation fixture cleanup failed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--psql", default=os.environ.get("M2_PSQL", "/tmp/vaultshuffle-pg17/bin/psql"))
    parser.add_argument("--host", default=os.environ.get("PGHOST", "/tmp/vaultshuffle-pg17-socket"))
    parser.add_argument("--port", default=os.environ.get("PGPORT", "55432"))
    parser.add_argument("--database", default=os.environ.get("PGDATABASE", "vaultshuffle_m2_development"))
    parser.add_argument("--admin-user", default=os.environ.get("M2_ADMIN_USER"))
    args = parser.parse_args()
    if not args.admin_user:
        parser.error("--admin-user or M2_ADMIN_USER is required; it must be able to SET LOCAL ROLE")
    config = PsqlConfig(args.psql, args.host, args.port, args.database, args.admin_user)

    original: dict[str, object] | None = None
    try:
        assert_runtime_roles(config)
        original = fixture_provider(config)
        duplicate = run_duplicate_attempt(config)
        fence = run_observation_fence(config)
        print({"duplicate_attempt": duplicate, "observation_fence": fence})
        print("m2 quota and observation concurrency assertions passed")
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        print(f"m2 concurrency assertions failed: {error}", file=sys.stderr)
        return 1
    finally:
        if original is not None:
            try:
                restore_provider(config, original)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                print(f"m2 provider restore failed: {error}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
