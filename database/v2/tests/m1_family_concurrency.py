#!/usr/bin/env python3
"""Exercise the five-member family cap with concurrent PostgreSQL writers.

The harness uses only the local/portable psql client and standard-library
subprocesses. It intentionally opens separate connections so READ COMMITTED,
REPEATABLE READ, and SERIALIZABLE behavior is observable. Every synthetic
account is deleted in a finally block.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class PsqlConfig:
    executable: str
    host: str
    port: str
    user: str
    database: str

    def command(self) -> list[str]:
        return [
            self.executable,
            "-h",
            self.host,
            "-p",
            self.port,
            "-U",
            self.user,
            "-d",
            self.database,
            "-X",
            "-q",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
        ]


def run(config: PsqlConfig, sql: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        config.command(),
        input=sql,
        text=True,
        capture_output=True,
        check=False,
    )


def account_id(config: PsqlConfig) -> int:
    result = run(config, "insert into app.accounts(account_kind) values ('manual') returning id;")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return int(result.stdout.strip())


def delete_account(config: PsqlConfig, account: int) -> None:
    result = run(config, f"delete from app.accounts where id = {account};")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def run_level(config: PsqlConfig, isolation: str) -> dict[str, object]:
    account = account_id(config)
    writer_a: subprocess.Popen[str] | None = None
    try:
        setup = run(
            config,
            f"insert into app.family_members(account_id, steam_id) "
            f"select {account}, 76561198000000000 + n from generate_series(1, 4) as g(n);",
        )
        if setup.returncode != 0:
            raise RuntimeError(setup.stderr.strip())

        writer_a = subprocess.Popen(
            config.command(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert writer_a.stdin is not None
        assert writer_a.stdout is not None
        writer_a.stdin.write(
            f"begin isolation level {isolation}; "
            f"insert into app.family_members(account_id, steam_id) values ({account}, 76561198000000005); "
            "select 'writer-a-ready'; select pg_sleep(1.5); commit;\n"
        )
        writer_a.stdin.close()
        ready = writer_a.stdout.readline().strip()
        if ready != "writer-a-ready":
            stderr = writer_a.stderr.read().strip() if writer_a.stderr else ""
            raise RuntimeError(f"writer A did not reach the synchronization point: {ready!r} {stderr}")

        writer_b = run(
            config,
            f"begin isolation level {isolation}; "
            f"select count(*) from app.family_members where account_id = {account}; "
            f"insert into app.family_members(account_id, steam_id) values ({account}, 76561198000000006); "
            "commit;",
        )
        writer_a.wait(timeout=10)
        a_stderr = writer_a.stderr.read().strip() if writer_a.stderr else ""
        after = run(config, f"select count(*) from app.family_members where account_id = {account};")
        if after.returncode != 0:
            raise RuntimeError(after.stderr.strip())
        members = int(after.stdout.strip())

        serialisation_error = "could not serialize access" in writer_b.stderr.lower()
        return {
            "isolation": isolation,
            "writer_a_exit": writer_a.returncode,
            "writer_b_exit": writer_b.returncode,
            "members_after": members,
            "limit_preserved": members == 5,
            "writer_a_error": a_stderr.splitlines()[0] if a_stderr else None,
            "writer_b_error": writer_b.stderr.strip().splitlines()[0] if writer_b.stderr else None,
            "writer_b_serialization_error": serialisation_error,
        }
    finally:
        if writer_a is not None and writer_a.poll() is None:
            writer_a.kill()
            writer_a.wait(timeout=5)
        delete_account(config, account)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--psql", default=os.environ.get("M1_PSQL", "psql"))
    parser.add_argument("--host", default=os.environ.get("PGHOST", "/tmp/vaultshuffle-pg17-socket"))
    parser.add_argument("--port", default=os.environ.get("PGPORT", "55432"))
    parser.add_argument("--user", default=os.environ.get("PGUSER", "postgres"))
    parser.add_argument("--database", default=os.environ.get("PGDATABASE", "vaultshuffle_m1"))
    args = parser.parse_args()
    config = PsqlConfig(args.psql, args.host, args.port, args.user, args.database)

    reports: list[dict[str, object]] = []
    for isolation in ("read committed", "repeatable read", "serializable"):
        report = run_level(config, isolation)
        if report["writer_a_exit"] != 0:
            raise RuntimeError(f"writer A failed under {isolation}: {report}")
        if not report["limit_preserved"] or report["writer_b_exit"] == 0:
            raise RuntimeError(f"family cap was not preserved under {isolation}: {report}")
        if isolation != "read committed" and not report["writer_b_serialization_error"]:
            raise RuntimeError(f"expected a serialization failure under {isolation}: {report}")
        reports.append(report)

    for report in reports:
        print(report)
    print("m1 family concurrency assertions passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        print(f"m1 family concurrency assertions failed: {error}", file=sys.stderr)
        raise SystemExit(1)
