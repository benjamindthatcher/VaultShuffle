#!/usr/bin/env python3
"""Replay the public M3 probes against a disposable synthetic PostgreSQL DB.

This is deliberately separate from the source audit. It creates every relation
and column in the exact 44-relation inventory, inserts a small set of synthetic
rows covering NULLs, domain drift, duplicate keys, stale staging and malformed
digests, runs the public probe bundle in a read-only transaction, and drops the
database in a ``finally`` block.

The fixture never connects to the source project. It uses only the local PG17
cluster documented by the M3 checkpoint. Run it explicitly with an escalated
local command when the cluster socket is sandbox-protected, for example:

    python3 database/v2/migration/tests/run_probe_fixture.py

The schema is created by the local admin, then the public probe bundle and its
assertions run as a temporary non-superuser reader with SELECT-only grants.
The script prints aggregate pass/fail markers and assertion counts only; it
does not print the probe result stream.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


HERE = Path(__file__).resolve().parent
MIGRATION_ROOT = HERE.parent
V2_ROOT = MIGRATION_ROOT.parent
INVENTORY_PATH = V2_ROOT / "source-schema-inventory-20260909.json"
PROBES_DIR = MIGRATION_ROOT / "probes"

PSQL = os.environ.get("M3_PSQL_BIN", "/tmp/vaultshuffle-pg17/bin/psql")
PGHOST = os.environ.get("M3_PGHOST", "/tmp/vaultshuffle-pg17-socket")
PGPORT = os.environ.get("M3_PGPORT", "55432")
PGUSER = os.environ.get("M3_PGUSER", "vault_local_admin")
PROBE_ROLE = "vault_m3_probe_reader"
FIXTURE_DB = os.environ.get(
    "M3_FIXTURE_DB", "vaultshuffle_m3_probe_fixture_20260910"
)

EXPECTED_RELATIONS = 44
EXPECTED_COLUMNS = 486
FIXTURE_PREFIX = "vaultshuffle_m3_probe_fixture_"
EXPECTED_FINDINGS = {
    "playtime_divergent_rows": 1,
    "null_minutes_rows": 3,
    "collection_duplicate_rows": 1,
    "family_over_cap_accounts": 1,
    "decoded_digest_collisions": 1,
    "snapshot_decreases": 1,
    "json_documents_without_key_output": 2,
}


@dataclass(frozen=True)
class Raw:
    sql: str


def ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def literal(value: object) -> str:
    if isinstance(value, Raw):
        return value.sql
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    raise TypeError(f"unsupported SQL fixture value: {value!r}")


def ts(value: str) -> Raw:
    return Raw(f"TIMESTAMPTZ {literal(value)}")


def date(value: str) -> Raw:
    return Raw(f"DATE {literal(value)}")


def array(values: list[object], pg_type: str) -> Raw:
    if not values:
        return Raw(f"ARRAY[]::{pg_type}")
    return Raw(f"ARRAY[{', '.join(literal(v) for v in values)}]::{pg_type}")


def jsonb(value: object) -> Raw:
    payload = json.dumps(value, separators=(",", ":"))
    return Raw(f"{literal(payload)}::jsonb")


def psql_args(
    database: str, *, tuples: bool = True, user: str = PGUSER
) -> list[str]:
    args = [
        PSQL,
        "--no-psqlrc",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        PGHOST,
        "-p",
        PGPORT,
        "-U",
        user,
        "-d",
        database,
    ]
    if tuples:
        args.extend(["-A", "-t", "-F", "\t"])
    return args


def run_sql(
    database: str,
    sql: str,
    *,
    tuples: bool = True,
    user: str = PGUSER,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        psql_args(database, tuples=tuples, user=user),
        input=sql,
        text=True,
        capture_output=True,
        check=False,
    )


def require_success(result: subprocess.CompletedProcess[str], label: str) -> str:
    if result.returncode == 0:
        return result.stdout
    detail = (result.stderr or result.stdout).strip()
    raise RuntimeError(f"{label} failed (exit {result.returncode}): {detail}")


def insert(table: str, **values: object) -> str:
    columns = ", ".join(ident(k) for k in values)
    rendered = ", ".join(literal(v) for v in values.values())
    return f"INSERT INTO public.{ident(table)} ({columns}) VALUES ({rendered});"


def build_schema(inventory: dict) -> str:
    statements: list[str] = ["CREATE SCHEMA IF NOT EXISTS public;"]
    for relation in inventory["public_tables"]:
        columns = relation["columns"]
        if relation["kind"] == "r":
            defs = ",\n  ".join(
                f"{ident(column['name'])} {column['type']}" for column in columns
            )
            statements.append(
                f"CREATE TABLE public.{ident(relation['name'])} (\n  {defs}\n);"
            )
        elif relation["kind"] == "v":
            expressions = ",\n  ".join(
                f"NULL::{column['type']} AS {ident(column['name'])}"
                for column in columns
            )
            statements.append(
                f"CREATE VIEW public.{ident(relation['name'])} AS\n"
                f"SELECT {expressions};"
            )
        else:
            raise RuntimeError(
                f"inventory relation {relation['name']} has unsupported kind "
                f"{relation['kind']!r}"
            )
    return "\n".join(statements) + "\n"


A1 = "00000000-0000-0000-0000-000000000001"
A2 = "00000000-0000-0000-0000-000000000002"
A3 = "00000000-0000-0000-0000-000000000003"
A4 = "00000000-0000-0000-0000-000000000004"
A5 = "00000000-0000-0000-0000-000000000005"
ORPHAN = "00000000-0000-0000-0000-000000000099"
G1 = "10000000-0000-0000-0000-000000000001"
G2 = "10000000-0000-0000-0000-000000000002"
G3 = "10000000-0000-0000-0000-000000000003"
G4 = "10000000-0000-0000-0000-000000000004"
G5 = "10000000-0000-0000-0000-000000000005"
C1 = "20000000-0000-0000-0000-000000000001"
C2 = "20000000-0000-0000-0000-000000000002"
D1 = "30000000-0000-0000-0000-000000000001"
D2 = "30000000-0000-0000-0000-000000000002"


def fixture_rows() -> str:
    rows: list[str] = []
    t0 = ts("2026-09-01 12:00:00+00")
    t1 = ts("2026-09-02 12:00:00+00")

    rows.extend(
        [
            insert(
                "app_accounts",
                id=A1,
                account_type="manual",
                created_at=t0,
                updated_at=t0,
                last_visited_at=t0,
            ),
            insert(
                "app_accounts",
                id=A2,
                account_type="steam",
                steam_library_visible=True,
                steam_playtime_visible=True,
                steam_last_played_visible=True,
                steam_visibility_checked_at=t0,
                steam_games_seen=3,
                created_at=t0,
                updated_at=t1,
                last_visited_at=t1,
            ),
            insert(
                "app_accounts",
                id=A3,
                account_type="steam",
                steam_library_visible=False,
                steam_playtime_visible=None,
                steam_last_played_visible=False,
                steam_visibility_checked_at=t0,
                steam_games_seen=2,
                created_at=t0,
                updated_at=t1,
                last_visited_at=t0,
            ),
            insert(
                "app_accounts",
                id=A4,
                account_type="manual",
                created_at=t0,
                updated_at=t0,
                last_visited_at=t0,
            ),
            insert(
                "app_accounts",
                id=A5,
                account_type="steam",
                steam_library_visible=None,
                steam_playtime_visible=None,
                steam_last_played_visible=None,
                steam_visibility_checked_at=None,
                steam_games_seen=None,
                created_at=t0,
                updated_at=t0,
                last_visited_at=None,
            ),
            insert(
                "app_users",
                id=A2,
                steam_id="76561198000000002",
                display_name="Synthetic Two",
                steam_library_visible=False,
                steam_playtime_visible=False,
                steam_last_played_visible=True,
                steam_visibility_checked_at=t1,
                steam_games_seen=4,
                created_at=t0,
                updated_at=t1,
                last_login_at=t1,
            ),
            insert(
                "app_users",
                id=A3,
                steam_id="76561198000000003",
                display_name="Synthetic Three",
                steam_library_visible=None,
                steam_playtime_visible=True,
                steam_last_played_visible=False,
                steam_visibility_checked_at=t0,
                steam_games_seen=1,
                created_at=t0,
                updated_at=t0,
                last_login_at=t0,
            ),
            insert(
                "manual_steam_profiles",
                id=A2,
                steam_id="76561198000000002",
                steam_profile_url="https://example.invalid/profile/2",
                display_name="Synthetic Manual Two",
                steam_display_name="Synthetic Steam Two",
                avatar_url="https://example.invalid/avatar/2",
                created_at=t0,
                updated_at=t0,
            ),
            insert(
                "manual_steam_profiles",
                id=A4,
                steam_id="76561198000000004",
                steam_profile_url="https://example.invalid/profile/4",
                display_name="Synthetic Manual Four",
                steam_display_name="Synthetic Steam Four",
                avatar_url="https://example.invalid/avatar/4",
                created_at=t0,
                updated_at=t0,
            ),
        ]
    )

    for appid, deck in ((100, 0), (101, 1), (102, 2), (103, 3)):
        rows.append(
            insert(
                "catalog_games",
                steam_appid=appid,
                name=f"Synthetic Game {appid}",
                normalized_name=f"synthetic game {appid}",
                steam_type="game",
                genres=array(["RPG"], "text[]"),
                categories=array(["Single-player"], "text[]"),
                tags=jsonb(["synthetic"]),
                review_positive=8,
                review_negative=2,
                review_total=10,
                price_currency="USD",
                price_initial=100,
                price_final=50,
                discount_percent=50,
                popularity_rank=appid,
                popularity_low=1,
                popularity_high=10,
                popularity_ccu=2,
                source_captured_at=date("2026-09-01"),
                first_seen_reason="seed",
                import_sighting_count=1,
                first_seen_at=t0,
                last_seen_at=t1,
                created_at=t0,
                updated_at=t1,
                users_that_imported=1,
                main_story_minutes=60,
                main_extras_minutes=90,
                completionist_minutes=120,
                duration_source="fixture",
                duration_confidence="medium",
                duration_status="ready",
                duration_kind="finite",
                tags_status="ready",
                tags_failure_count=0,
                platform_windows=True,
                platform_mac=False,
                platform_linux=False,
                deck_compatibility=deck,
                deck_checked_at=date("2026-09-01"),
                duration_manual_override=False,
            )
        )

    rows.extend(
        [
            insert(
                "user_games",
                id=G1,
                user_id=A2,
                ownership="Owned",
                status="In Progress",
                hours_played=1.0,
                completion_percentage=10,
                date_added="2026-08-01",
                notes="A non-empty synthetic note.",
                created_at=t0,
                updated_at=t1,
                last_played_at=t1,
                completed_at=None,
                slept_at=None,
                previous_active_status="In Progress",
                catalog_steam_appid=100,
                last_observed_played_at=t1,
                recency_source="steam_exact",
                recency_evidence_at=t1,
                observed_playtime_minutes=60,
                review_requested_at=None,
                access_source="owned",
                family_owner_steam_id=None,
                family_verified_at=None,
            ),
            insert(
                "user_games",
                id=G2,
                user_id=A2,
                ownership="Owned",
                status="Completed",
                hours_played=40.0,
                completion_percentage=100,
                date_added="2026-08-02",
                notes="Edited hours conflict with exact minutes.",
                created_at=t0,
                updated_at=t1,
                last_played_at=t1,
                completed_at=t1,
                slept_at=None,
                previous_active_status="Sampled",
                catalog_steam_appid=101,
                last_observed_played_at=t1,
                recency_source="observed_playtime_change",
                recency_evidence_at=t1,
                observed_playtime_minutes=3,
                access_source="owned",
                review_requested_at=None,
                family_owner_steam_id=None,
                family_verified_at=None,
            ),
            insert(
                "user_games",
                id=G3,
                user_id=A3,
                ownership="Wishlist",
                status="Not Started",
                hours_played=0,
                completion_percentage=0,
                date_added="2026-08-03",
                notes="Wishlist row with unknown minutes.",
                created_at=t0,
                updated_at=t0,
                last_played_at=None,
                completed_at=None,
                slept_at=None,
                previous_active_status=None,
                catalog_steam_appid=102,
                last_observed_played_at=None,
                recency_source=None,
                recency_evidence_at=None,
                observed_playtime_minutes=None,
                access_source="family",
                family_owner_steam_id="76561198000000004",
                family_verified_at=t1,
            ),
            insert(
                "user_games",
                id=G4,
                user_id=A4,
                ownership="Owned",
                status="Slept",
                hours_played=0,
                completion_percentage=0,
                date_added="2026-08-04",
                notes="Family row without a matching lender.",
                created_at=t0,
                updated_at=t0,
                last_played_at=None,
                completed_at=None,
                slept_at=t1,
                previous_active_status="Not Started",
                catalog_steam_appid=103,
                last_observed_played_at=None,
                recency_source=None,
                recency_evidence_at=None,
                observed_playtime_minutes=None,
                access_source="family",
                family_owner_steam_id="76561198099999999",
                family_verified_at=t1,
            ),
            insert(
                "user_games",
                id=G5,
                user_id=A3,
                ownership="Owned",
                status="Not Started",
                hours_played=0,
                completion_percentage=0,
                date_added="2026-08-05",
                notes="Blank-state activity evidence fixture.",
                created_at=t0,
                updated_at=t0,
                last_played_at=None,
                completed_at=None,
                slept_at=None,
                previous_active_status=None,
                catalog_steam_appid=100,
                last_observed_played_at=None,
                recency_source=None,
                recency_evidence_at=None,
                observed_playtime_minutes=None,
                access_source="owned",
                family_owner_steam_id=None,
                family_verified_at=None,
            ),
            insert(
                "collections",
                id=C1,
                user_id=A2,
                name="Synthetic Collection",
                description="A synthetic collection.",
                created_at=t0,
                updated_at=t1,
                kind="custom",
                rules=jsonb({"genre": "RPG"}),
            ),
            insert(
                "collections",
                id=C2,
                user_id=A3,
                name="Synthetic Smart",
                description="A synthetic empty smart collection.",
                created_at=t0,
                updated_at=t0,
                kind="smart",
                rules=jsonb({}),
            ),
            insert(
                "collection_games",
                collection_id=C1,
                game_id=G1,
                notes="first",
                position=0,
                created_at=t0,
            ),
            insert(
                "collection_games",
                collection_id=C1,
                game_id=G2,
                notes="duplicate position",
                position=0,
                created_at=t0,
            ),
            insert(
                "collection_games",
                collection_id=C1,
                game_id=G3,
                notes="gap after duplicate",
                position=2,
                created_at=t0,
            ),
            insert(
                "user_game_snoozes",
                user_id=A2,
                game_id=G1,
                snoozed_at=t1,
                snoozed_until=t0,
            ),
            insert(
                "user_game_snoozes",
                user_id=A3,
                game_id=G3,
                snoozed_at=t0,
                snoozed_until=None,
            ),
            insert(
                "user_game_pins",
                user_id=A2,
                game_id=G1,
                slot=1,
                pinned_at=t0,
                scope="library",
                hours_at_pin=1.05,
            ),
            insert(
                "user_game_pins",
                user_id=A2,
                game_id=G1,
                slot=2,
                pinned_at=t1,
                scope="library",
                hours_at_pin=1.1,
            ),
            insert(
                "user_game_pins",
                user_id=A3,
                game_id=G3,
                slot=4,
                pinned_at=t0,
                scope="strange",
                hours_at_pin=None,
            ),
            insert(
                "purge_reviews",
                id="40000000-0000-0000-0000-000000000001",
                user_id=A2,
                game_id=G1,
                action="complete",
                reviewed_at=t1,
                playtime_minutes_at_review=60,
                progress_at_review=100,
                last_played_at_review=t1,
            ),
            insert(
                "purge_reviews",
                id="40000000-0000-0000-0000-000000000002",
                user_id=A3,
                game_id=G2,
                action="complete",
                reviewed_at=t1,
                playtime_minutes_at_review=3,
                progress_at_review=100,
                last_played_at_review=t1,
            ),
        ]
    )

    family_steam_ids = [
        "76561198000000011",
        "76561198000000012",
        "76561198000000013",
        "76561198000000014",
        "76561198000000015",
        "bad-steam-id",
    ]
    for index, steam_id in enumerate(family_steam_ids, start=1):
        rows.append(
            insert(
                "user_family_members",
                id=f"50000000-0000-0000-0000-{index:012d}",
                user_id=A3,
                steam_id=steam_id,
                display_name=f"Synthetic Family {index}",
                avatar_url=None,
                profile_url=None,
                candidate_appids=array([100, 0, 9999999999], "bigint[]")
                if index == 1
                else array([100], "bigint[]"),
                library_seen=2 if index == 1 else 1,
                games_imported=index,
                last_synced_at=t1,
                last_error=None,
                created_at=t0,
                updated_at=t1,
            )
        )

    rows.extend(
        [
            insert(
                "completion_events",
                id="60000000-0000-0000-0000-000000000001",
                user_id=A2,
                game_id=G1,
                steam_appid=100,
                source="sweep",
                claimed_at=t0,
                undone_at=None,
                hours_played=1.0,
                estimate_minutes=60,
                price_cents=100,
            ),
            insert(
                "completion_events",
                id="60000000-0000-0000-0000-000000000002",
                user_id=A2,
                game_id=None,
                steam_appid=101,
                source="purge",
                claimed_at=t1,
                undone_at=None,
                hours_played=0.05,
                estimate_minutes=60,
                price_cents=200,
            ),
            insert(
                "completion_events",
                id="60000000-0000-0000-0000-000000000003",
                user_id=A3,
                game_id=ORPHAN,
                steam_appid=None,
                source="details",
                claimed_at=t1,
                undone_at=None,
                hours_played=2.0,
                estimate_minutes=None,
                price_cents=None,
            ),
            insert(
                "completion_events",
                id="60000000-0000-0000-0000-000000000004",
                user_id=A3,
                game_id=None,
                steam_appid=None,
                source="vault",
                claimed_at=t0,
                undone_at=None,
                hours_played=None,
                estimate_minutes=None,
                price_cents=None,
            ),
            insert(
                "completion_events",
                id="60000000-0000-0000-0000-000000000005",
                user_id=A3,
                game_id=G3,
                steam_appid=999,
                source="library",
                claimed_at=t1,
                undone_at=t0,
                hours_played=1.0,
                estimate_minutes=100,
                price_cents=0,
            ),
            insert(
                "account_merges",
                id="70000000-0000-0000-0000-000000000001",
                source_account_id=ORPHAN,
                target_account_id=A2,
                verified_steam_id="76561198000000002",
                merge_mode="merged_existing",
                created_at=t1,
                analytics_delivered_at=None,
            ),
            insert(
                "catalog_game_quarantine",
                steam_appid=100,
                name="Synthetic quarantined game",
                steam_type="dlc",
                matched_rule="type",
                reason="synthetic",
                genres=array(["RPG"], "text[]"),
                categories=array(["Single-player"], "text[]"),
                review_status="pending",
                source="automatic",
                first_detected_at=t0,
                last_detected_at=t1,
                reviewed_at=None,
                review_notes=None,
                updated_at=t1,
            ),
            insert(
                "catalog_game_quarantine",
                steam_appid=999,
                name="Synthetic unknown type",
                steam_type="unexpected-type",
                matched_rule="type",
                reason="synthetic",
                genres=None,
                categories=None,
                review_status="allowed",
                source="manual",
                first_detected_at=t0,
                last_detected_at=t0,
                reviewed_at=t1,
                review_notes=None,
                updated_at=t1,
            ),
            insert(
                "sessions",
                id="80000000-0000-0000-0000-000000000001",
                user_id=A2,
                token_hash="0" * 64,
                created_at=t0,
                last_seen_at=t1,
                expires_at=ts("2026-10-01 00:00:00+00"),
            ),
            insert(
                "sessions",
                id="80000000-0000-0000-0000-000000000002",
                user_id=A3,
                token_hash="A" * 64,
                created_at=t0,
                last_seen_at=t0,
                expires_at=ts("2026-10-01 00:00:00+00"),
            ),
            insert(
                "sessions",
                id="80000000-0000-0000-0000-000000000003",
                user_id=A3,
                token_hash="malformed",
                created_at=t1,
                last_seen_at=t1,
                expires_at=t0,
            ),
            insert(
                "sessions",
                id="80000000-0000-0000-0000-000000000004",
                user_id=A3,
                token_hash=None,
                created_at=t0,
                last_seen_at=t0,
                expires_at=ts("2026-10-01 00:00:00+00"),
            ),
            insert(
                "manual_profile_sessions",
                id="81000000-0000-0000-0000-000000000001",
                profile_id=A4,
                token_hash="0" * 64,
                created_at=t0,
                last_seen_at=t0,
                expires_at=ts("2026-10-01 00:00:00+00"),
            ),
            insert(
                "user_game_state",
                user_id=A2,
                appid=100,
                completed_at=t1,
                slept_at=None,
                prev_active_status=1,
                dismissed_at=None,
                dismissed_playtime=None,
                review_requested_at=None,
                last_played_at=t1,
                last_observed_played_at=t1,
                recency_source=1,
                recency_evidence_at=t1,
                family_owner_steam_id=None,
                family_verified_at=None,
            ),
            insert(
                "user_game_state",
                user_id=A5,
                appid=999,
                completed_at=None,
                slept_at=None,
                prev_active_status=2,
                dismissed_at=None,
                dismissed_playtime=None,
                review_requested_at=None,
                last_played_at=None,
                last_observed_played_at=None,
                recency_source=2,
                recency_evidence_at=None,
                family_owner_steam_id=None,
                family_verified_at=None,
            ),
            insert(
                "vault_draws",
                id=D1,
                user_id=A2,
                steam_appid=100,
                drawn_at=t0,
                session="short",
                mood="chill",
                goal="new",
                collection_id=C1,
                selected_genres=array(["RPG"], "text[]"),
                eligible_pool_count=2,
                reroll_index=0,
                finalist_appids=array([100, 101], "bigint[]"),
            ),
            insert(
                "vault_draws",
                id=D2,
                user_id=A3,
                steam_appid=101,
                drawn_at=t1,
                session="unknown-session",
                mood="unknown-mood",
                goal="unknown-goal",
                collection_id=None,
                selected_genres=None,
                eligible_pool_count=0,
                reroll_index=2,
                finalist_appids=None,
            ),
            insert(
                "vault_draw_events",
                id="90000000-0000-0000-0000-000000000001",
                user_id=A2,
                draw_id=D1,
                event_type="pinned",
                created_at=t0,
            ),
            insert(
                "vault_draw_events",
                id="90000000-0000-0000-0000-000000000002",
                user_id=A3,
                draw_id=D2,
                event_type="future-event",
                created_at=t1,
            ),
            insert(
                "vault_events",
                id="91000000-0000-0000-0000-000000000001",
                user_id=A2,
                game_id=G1,
                action="drawn",
                context=jsonb({"email": "synthetic@example.invalid", "trace": 1}),
                created_at=t0,
            ),
            insert(
                "vault_events",
                id="91000000-0000-0000-0000-000000000002",
                user_id=A3,
                game_id=None,
                action="future-action",
                context=jsonb(["synthetic", 1]),
                created_at=t1,
            ),
            insert(
                "feedback_submissions",
                id="92000000-0000-0000-0000-000000000001",
                user_id=A2,
                feedback_type=0,
                message="A synthetic feedback message.",
                contact_allowed=False,
                contact_email=None,
                route="/fixture",
                app_area="probe",
                client_context=jsonb({"email": "synthetic@example.invalid", "version": 1}),
                dedupe_hash="1" * 64,
                status=0,
                created_at=t0,
            ),
            insert(
                "feedback_submissions",
                id="92000000-0000-0000-0000-000000000002",
                user_id=None,
                feedback_type=9,
                message="Another synthetic feedback message.",
                contact_allowed=True,
                contact_email="synthetic@example.invalid",
                route="/fixture",
                app_area="probe",
                client_context=jsonb(["shape-only"]),
                dedupe_hash="2" * 64,
                status=4,
                created_at=t1,
            ),
            insert(
                "contact_messages",
                id="93000000-0000-0000-0000-000000000001",
                user_id=A2,
                enquiry_type=1,
                email="synthetic@example.invalid",
                subject="Synthetic subject",
                message="A synthetic contact message.",
                dedupe_hash="3" * 64,
                status=0,
                created_at=t0,
                updated_at=t0,
            ),
            insert(
                "contact_messages",
                id="93000000-0000-0000-0000-000000000002",
                user_id=None,
                enquiry_type=9,
                email=None,
                subject="Synthetic second subject",
                message="Another synthetic contact message.",
                dedupe_hash="4" * 64,
                status=8,
                created_at=t1,
                updated_at=t1,
            ),
        ]
    )

    for day, total in (("2026-09-01", 100), ("2026-09-02", 90), ("2026-09-03", 90)):
        rows.append(
            insert(
                "user_playtime_snapshots",
                user_id=A2,
                captured_on=date(day),
                total_minutes=total,
                games_with_playtime=1,
                created_at=t1,
            )
        )
    rows.append(
        insert(
            "user_playtime_snapshots",
            user_id=A3,
            captured_on=date("2026-09-01"),
            total_minutes=10,
            games_with_playtime=1,
            created_at=t0,
        )
    )
    return "\n".join(rows) + "\n"


def public_probe_bundle() -> str:
    names = (
        "p01-p04-inventory-and-access.sql",
        "p05-p06-playtime-and-staging.sql",
        "p07-constraint-conflicts.sql",
        "p08-code-books.sql",
        "px-value-domains.sql",
    )
    body = "\n".join((PROBES_DIR / name).read_text() for name in names)
    return "\n".join(
        [
            "BEGIN;",
            "SET TRANSACTION READ ONLY;",
            "SET LOCAL statement_timeout = '30s';",
            "SET LOCAL lock_timeout = '2s';",
            body,
            "ROLLBACK;",
        ]
    )


def scalar(database: str, sql: str, label: str, *, user: str = PROBE_ROLE) -> int:
    output = require_success(run_sql(database, sql, user=user), label)
    values = [line.strip() for line in output.splitlines() if line.strip()]
    if len(values) != 1:
        raise RuntimeError(f"{label} returned {len(values)} rows, expected one")
    try:
        return int(values[0])
    except ValueError as exc:
        raise RuntimeError(f"{label} returned non-integer output") from exc


def assert_fixture_findings(database: str) -> list[tuple[str, int]]:
    checks = [
        (
            "playtime_divergent_rows",
            "select count(*) from public.user_games where observed_playtime_minutes is not null and hours_played is distinct from (round((observed_playtime_minutes::numeric / 60) * 10) / 10);",
        ),
        (
            "null_minutes_rows",
            "select count(*) from public.user_games where observed_playtime_minutes is null;",
        ),
        (
            "collection_duplicate_rows",
            "select count(*) from (select collection_id, position from public.collection_games group by collection_id, position having count(*) > 1) d;",
        ),
        (
            "family_over_cap_accounts",
            "select count(*) from (select user_id from public.user_family_members group by user_id having count(*) > 5) d;",
        ),
        (
            "decoded_digest_collisions",
            "select count(*) from (select decode(lower(token_hash), 'hex') from public.sessions where token_hash ~ '^[0-9A-Fa-f]{64}$' intersect select decode(lower(token_hash), 'hex') from public.manual_profile_sessions where token_hash ~ '^[0-9A-Fa-f]{64}$') d;",
        ),
        (
            "snapshot_decreases",
            "with x as (select total_minutes, lag(total_minutes) over (partition by user_id order by captured_on) prior from public.user_playtime_snapshots) select count(*) from x where prior is not null and total_minutes < prior;",
        ),
        (
            "json_documents_without_key_output",
            "select count(*) from public.feedback_submissions where client_context is not null;",
        ),
    ]
    return [(name, scalar(database, query, name)) for name, query in checks]


def preflight_optional(database: str) -> tuple[int, int]:
    query = """
select count(*) filter (where to_regclass('auth.users') is null),
       count(*) filter (where to_regclass('cron.job') is null),
       count(*) filter (where to_regclass('net.http_request_queue') is null),
       count(*) filter (where to_regclass('storage.buckets') is null),
       count(*) filter (where to_regclass('storage.objects') is null),
       count(*) filter (where to_regclass('supabase_migrations.schema_migrations') is null);
"""
    output = require_success(
        run_sql(database, query, user=PROBE_ROLE), "optional platform preflight"
    )
    values = [line.strip().split("\t") for line in output.splitlines() if line.strip()]
    if values != [["1", "1", "1", "1", "1", "1"]]:
        raise RuntimeError("optional platform preflight did not report all six objects absent")
    metadata = require_success(
        run_sql(
            database,
            """
select count(*) filter (where a.attname = 'created'),
       count(*) filter (where a.attname in ('created_at', 'enqueued_at'))
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'net' and c.relname = 'http_request_queue'
  and a.attnum > 0 and not a.attisdropped;
""",
            user=PROBE_ROLE,
        ),
            "queue metadata preflight",
        )
    metadata_values = [line.strip().split("\t") for line in metadata.splitlines() if line.strip()]
    if metadata_values != [["0", "0"]]:
        raise RuntimeError("queue metadata preflight unexpectedly found queue age columns")
    return 6, 0


def create_probe_role() -> None:
    if not PROBE_ROLE.startswith("vault_m3_"):
        raise RuntimeError(f"refusing to manage an unexpected probe role: {PROBE_ROLE}")
    require_success(
        run_sql(
            "postgres",
            "\n".join(
                [
                    f"DROP ROLE IF EXISTS {ident(PROBE_ROLE)};",
                    f"CREATE ROLE {ident(PROBE_ROLE)} LOGIN "
                    "NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT "
                    "NOREPLICATION NOSUPERUSER;",
                ]
            ),
            tuples=False,
        ),
        "create temporary probe role",
    )
    output = require_success(
        run_sql(
            "postgres",
            f"""
select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
from pg_catalog.pg_roles
where rolname = {literal(PROBE_ROLE)};
""",
        ),
        "probe role attributes",
    )
    values = [line.strip().split("\t") for line in output.splitlines() if line.strip()]
    if values != [["t", "f", "f", "f", "f"]]:
        raise RuntimeError(f"temporary probe role is not least-privilege: {values!r}")


def grant_probe_access(database: str) -> None:
    require_success(
        run_sql(
            database,
            f"""
revoke create on schema public from public;
revoke all on all tables in schema public from public;
grant connect on database {ident(database)} to {ident(PROBE_ROLE)};
grant usage on schema public to {ident(PROBE_ROLE)};
grant select on all tables in schema public to {ident(PROBE_ROLE)};
""",
            tuples=False,
        ),
        "grant temporary probe access",
    )
    output = require_success(
        run_sql(
            database,
            f"""
select has_database_privilege({literal(PROBE_ROLE)}, current_database(), 'CONNECT'),
       has_schema_privilege({literal(PROBE_ROLE)}, 'public', 'USAGE'),
       has_schema_privilege({literal(PROBE_ROLE)}, 'public', 'CREATE'),
       has_table_privilege({literal(PROBE_ROLE)}, 'public.user_games', 'SELECT'),
       has_table_privilege({literal(PROBE_ROLE)}, 'public.user_games', 'INSERT');
""",
        ),
        "probe access assertions",
    )
    values = [line.strip().split("\t") for line in output.splitlines() if line.strip()]
    if values != [["t", "t", "f", "t", "f"]]:
        raise RuntimeError(f"temporary probe grants are not SELECT-only: {values!r}")


def drop_probe_role() -> None:
    if not PROBE_ROLE.startswith("vault_m3_"):
        raise RuntimeError(f"refusing to manage an unexpected probe role: {PROBE_ROLE}")
    require_success(
        run_sql("postgres", f"DROP ROLE IF EXISTS {ident(PROBE_ROLE)};", tuples=False),
        "drop temporary probe role",
    )


def drop_database() -> None:
    if not FIXTURE_DB.startswith(FIXTURE_PREFIX):
        raise RuntimeError(f"refusing to drop a non-fixture database name: {FIXTURE_DB}")
    result = run_sql("postgres", f"DROP DATABASE IF EXISTS {ident(FIXTURE_DB)};", tuples=False)
    require_success(result, "drop fixture database")


def main() -> int:
    inventory = json.loads(INVENTORY_PATH.read_text())
    relation_count = len(inventory["public_tables"])
    column_count = sum(len(relation["columns"]) for relation in inventory["public_tables"])
    if (relation_count, column_count) != (EXPECTED_RELATIONS, EXPECTED_COLUMNS):
        raise RuntimeError(
            f"fixture authority drift: inventory has {relation_count} relations / "
            f"{column_count} columns"
        )
    created = False
    role_created = False
    try:
        create_probe_role()
        role_created = True
        drop_database()
        require_success(
            run_sql(
                "postgres",
                f"CREATE DATABASE {ident(FIXTURE_DB)} TEMPLATE template0;",
                tuples=False,
            ),
            "create fixture database",
        )
        created = True
        # The copied local template contains unrelated catalogue objects. The
        # fixture owns this new database, so reset only its public schema before
        # materialising the exact inventory relations below.
        require_success(
            run_sql(
                FIXTURE_DB,
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
                tuples=False,
            ),
            "reset fixture public schema",
        )
        require_success(run_sql(FIXTURE_DB, build_schema(inventory), tuples=False), "build fixture schema")
        require_success(run_sql(FIXTURE_DB, fixture_rows(), tuples=False), "insert synthetic fixture rows")
        grant_probe_access(FIXTURE_DB)

        bundle = public_probe_bundle()
        probe_result = run_sql(FIXTURE_DB, bundle, tuples=False, user=PROBE_ROLE)
        require_success(probe_result, "public probe bundle")
        if "ERROR" in (probe_result.stdout + probe_result.stderr).upper():
            raise RuntimeError("public probe bundle emitted an ERROR marker")

        assertion_results = assert_fixture_findings(FIXTURE_DB)
        optional_count, optional_age_columns = preflight_optional(FIXTURE_DB)
        for name, value in assertion_results:
            expected = EXPECTED_FINDINGS[name]
            if value != expected:
                raise RuntimeError(f"{name} expected {expected}, got {value}")
        print(
            f"fixture=PASS database={FIXTURE_DB} relations={relation_count} "
            f"columns={column_count} public_probe_bundle=PASS "
            f"optional_objects_absent={optional_count} queue_age_columns={optional_age_columns}"
        )
        print(
            "fixture_findings="
            + ",".join(f"{name}:{value}" for name, value in assertion_results)
        )
        return 0
    finally:
        if created:
            drop_database()
        if role_created:
            drop_probe_role()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"fixture=FAIL {exc}", file=sys.stderr)
        raise SystemExit(1)
