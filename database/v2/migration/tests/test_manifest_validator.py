#!/usr/bin/env python3
"""Tests for the M3 disposition manifest, its generator and its validator.

Run:
    python3 -m unittest discover -s database/v2/migration/tests -v
or:
    python3 database/v2/migration/tests/test_manifest_validator.py

Stdlib only. No database, no network, no fixtures outside a temp directory.

What these prove
----------------
* The committed manifest is valid against the committed inventory, and covers
  every relation and every column with a disposition from the closed vocabulary.
* The validator FAILS on each drift class it claims to catch. Each negative test
  mutates a copy of the real artefacts, so the failure is demonstrated against
  the real shapes rather than a toy.
* A missing disposition is never defaulted: `disposition_for` raises, and there
  is no code path anywhere that supplies a fallback.
* The GENERATOR refuses to emit a manifest when a column has no decision, which
  is what makes column coverage mechanical rather than merely likely.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIGRATION_ROOT = HERE.parent
V2_ROOT = MIGRATION_ROOT.parent
REPO_ROOT = V2_ROOT.parent.parent

INVENTORY = V2_ROOT / "source-schema-inventory-20260909.json"
MANIFEST = MIGRATION_ROOT / "manifest" / "disposition-manifest.json"
BUILDER = MIGRATION_ROOT / "manifest" / "build_manifest.py"
DECISIONS_DIR = MIGRATION_ROOT / "manifest" / "dispositions"
VALIDATOR = MIGRATION_ROOT / "validate" / "validate_manifest.py"
# Read-only cross-artefact reference. The physical migration is owned by the
# database worker; these tests never write it. M3 was applied on the target at
# 2026-09-10T23:26:54Z and the local file was RENAMED, not edited, to the
# management-assigned version below; its content hash is unchanged.
M3_MIGRATION = (
    V2_ROOT / "supabase" / "migrations" / "20260910232654_m3_preservation_schema.sql"
)
M3_MIGRATION_SHA256 = (
    "605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a"
)
FOLLOWUP_MIGRATION = (
    V2_ROOT / "supabase" / "migrations" / "20260911234500_m3_legacy_preservation_followup.sql"
)
FOLLOWUP_MIGRATION_SHA256 = (
    "beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59"
)
BLACKLIST_MIGRATION = (
    V2_ROOT / "supabase" / "migrations" / "20260912193000_blacklist_semantics.sql"
)
BLACKLIST_MIGRATION_SHA256 = (
    "a20e75cbca19918d4a5d8cb2778a98f50bf98641b7594c4c067abe58a8c9cca6"
)

# The six legacy Steam visibility booleans, by (relation, column, side).
LEGACY_VISIBILITY_COLUMNS = (
    ("app_accounts", "steam_library_visible", True),
    ("app_accounts", "steam_playtime_visible", True),
    ("app_accounts", "steam_last_played_visible", True),
    ("app_users", "steam_library_visible", False),
    ("app_users", "steam_playtime_visible", False),
    ("app_users", "steam_last_played_visible", False),
)
BINDING_CAPABILITY_MAPPING = {
    "true": "visible",
    "false": "unknown",
    "null": "unknown",
}

EXPECTED_RELATIONS = 44
EXPECTED_BASE_TABLES = 42
EXPECTED_VIEWS = 2
EXPECTED_COLUMNS = 486
EXPECTED_VIEW_NAMES = {"user_games_with_catalog", "catalog_duration_review_queue"}


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


validator = _load_module("m3_validate_manifest", VALIDATOR)
builder = _load_module("m3_build_manifest", BUILDER)


def run_validator(manifest_path: Path, inventory_path: Path, *extra_args: str):
    return subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "--manifest",
            str(manifest_path),
            "--inventory",
            str(inventory_path),
            *extra_args,
        ],
        capture_output=True,
        text=True,
    )


class MutationHarness(unittest.TestCase):
    """Writes a mutated copy of the real artefacts into a temp dir."""

    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST.read_text())
        cls.inventory = json.loads(INVENTORY.read_text())

    def write_pair(self, manifest: dict, inventory: dict):
        tmp = Path(tempfile.mkdtemp(prefix="m3-manifest-test-"))
        mp = tmp / "manifest.json"
        ip = tmp / "inventory.json"
        mp.write_text(json.dumps(manifest))
        ip.write_text(json.dumps(inventory))
        sidecar = Path(manifest["physical_destination_index"]["path"])
        source_sidecar = MANIFEST.parent / sidecar
        destination_sidecar = tmp / sidecar
        destination_sidecar.parent.mkdir(parents=True, exist_ok=True)
        destination_sidecar.write_bytes(source_sidecar.read_bytes())
        return mp, ip

    def write_pair_with_index(self, manifest: dict, inventory: dict, index: dict):
        """Like write_pair, but with a MUTATED destination sidecar.

        The manifest binds the sidecar by hash, so the recorded hash is
        recomputed here; otherwise every such test would fail as V14 hash drift
        instead of exercising the rule under test.
        """
        manifest = copy.deepcopy(manifest)
        tmp = Path(tempfile.mkdtemp(prefix="m3-manifest-index-test-"))
        sidecar = Path(manifest["physical_destination_index"]["path"])
        destination_sidecar = tmp / sidecar
        destination_sidecar.parent.mkdir(parents=True, exist_ok=True)
        payload = (json.dumps(index, indent=2, ensure_ascii=False) + "\n").encode()
        destination_sidecar.write_bytes(payload)
        manifest["physical_destination_index"]["sha256"] = hashlib.sha256(
            payload
        ).hexdigest()
        mp = tmp / "manifest.json"
        ip = tmp / "inventory.json"
        mp.write_text(json.dumps(manifest))
        ip.write_text(json.dumps(inventory))
        return mp, ip

    def assert_fails_with(self, manifest, inventory, code: str):
        mp, ip = self.write_pair(manifest, inventory)
        result = run_validator(mp, ip)
        self.assertEqual(
            result.returncode,
            1,
            msg=f"expected validation failure for {code}; got exit "
            f"{result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}",
        )
        self.assertIn(
            code,
            result.stderr,
            msg=f"expected a {code} failure.\nstderr={result.stderr}",
        )
        return result


class TestCommittedArtefactsAreValid(MutationHarness):
    def test_committed_manifest_validates(self):
        result = run_validator(MANIFEST, INVENTORY)
        self.assertEqual(
            result.returncode,
            0,
            msg=f"committed manifest failed validation:\n{result.stderr}",
        )

    def test_coverage_totals_match_the_live_inventory(self):
        self.assertEqual(len(self.inventory["public_tables"]), EXPECTED_RELATIONS)
        self.assertEqual(
            sum(len(t["columns"]) for t in self.inventory["public_tables"]),
            EXPECTED_COLUMNS,
        )
        totals = self.manifest["totals"]
        self.assertEqual(totals["relations"], EXPECTED_RELATIONS)
        self.assertEqual(totals["base_tables"], EXPECTED_BASE_TABLES)
        self.assertEqual(totals["views"], EXPECTED_VIEWS)
        self.assertEqual(totals["columns"], EXPECTED_COLUMNS)

    def test_every_column_has_a_vocabulary_disposition(self):
        """Column coverage is total. A table-level disposition never suffices."""
        seen = 0
        for rel in self.manifest["relations"]:
            for col in rel["columns"]:
                seen += 1
                disp = validator.disposition_for(col, rel["name"])
                self.assertIn(disp, validator.VALID_DISPOSITIONS)
        self.assertEqual(seen, EXPECTED_COLUMNS)

    def test_manifest_column_set_equals_inventory_column_set(self):
        inv = {
            (t["name"], c["name"])
            for t in self.inventory["public_tables"]
            for c in t["columns"]
        }
        man = {
            (r["name"], c["name"])
            for r in self.manifest["relations"]
            for c in r["columns"]
        }
        self.assertEqual(inv - man, set(), "columns missing from the manifest")
        self.assertEqual(man - inv, set(), "manifest columns absent from source")

    def test_the_two_views_are_marked_derived(self):
        views = {r["name"] for r in self.manifest["relations"] if r["kind"] == "v"}
        self.assertEqual(views, EXPECTED_VIEW_NAMES)
        for rel in self.manifest["relations"]:
            if rel["kind"] != "v":
                continue
            self.assertEqual(rel["disposition_class"], "derived-view")
            for col in rel["columns"]:
                self.assertEqual(
                    col["disposition"],
                    "derived-retirement",
                    f"{rel['name']}.{col['name']} is a view column",
                )

    def test_every_archive_has_a_purpose_and_a_retention(self):
        for rel in self.manifest["relations"]:
            archived = [
                c for c in rel["columns"] if c["disposition"] == "audit-archive"
            ]
            if not archived:
                continue
            self.assertTrue(
                rel.get("archive_purpose"),
                f"{rel['name']} archives {len(archived)} columns with no purpose",
            )
            self.assertTrue(
                rel.get("archive_retention"),
                f"{rel['name']} archives {len(archived)} columns with no retention",
            )

    def test_every_unresolved_column_names_what_unblocks_it(self):
        for rel in self.manifest["relations"]:
            for col in rel["columns"]:
                if col["disposition"] == "unresolved-decision":
                    self.assertTrue(
                        col.get("blocked_on"),
                        f"{rel['name']}.{col['name']} is unresolved with no "
                        f"blocked_on; an open question must not hide in prose",
                    )

    def test_stale_user_game_state_is_never_a_runtime_target(self):
        """readiness 5: the quarantined staging table must not reach app.*"""
        rel = next(
            r for r in self.manifest["relations"] if r["name"] == "user_game_state"
        )
        self.assertEqual(rel["disposition_class"], "archive-only")
        for col in rel["columns"]:
            self.assertIn(
                col["disposition"],
                ("audit-archive", "authorized-retirement", "unresolved-decision"),
                f"user_game_state.{col['name']} must not be migrated",
            )
            for field in ("target", "archive"):
                value = col.get(field) or ""
                self.assertFalse(
                    value.startswith("app.") or value.startswith("+app."),
                    f"user_game_state.{col['name']} points at {value!r}; it must "
                    f"never resurrect authored state or activity",
                )

    def test_manifest_links_to_the_coordinator_physical_contract(self):
        link = self.manifest["physical_contract"]
        self.assertEqual(link["path"], "../../M3-contract.md")
        self.assertTrue(
            (MANIFEST.parent / link["path"]).resolve().exists(),
            "manifest physical_contract link must resolve to the sibling contract",
        )

    def test_manifest_binds_targets_to_the_generated_sql_index(self):
        link = self.manifest["physical_destination_index"]
        index_path = (MANIFEST.parent / link["path"]).resolve()
        self.assertTrue(index_path.exists())
        self.assertEqual(
            link["sha256"],
            hashlib.sha256(index_path.read_bytes()).hexdigest(),
        )
        index = json.loads(index_path.read_text())
        self.assertEqual(link["totals"], index["totals"])
        self.assertGreater(index["totals"]["relations"], 0)

    def test_index_records_the_applied_m3_file_at_its_immutable_hash(self):
        """The sidecar must name the APPLIED M3 file, at the applied content.

        M3 was applied on the target and the local file was renamed, not
        edited. Pinning both the management-assigned filename and the content
        hash here is what makes a later rename, edit or silent reapply show up
        as a test failure rather than as quietly stale provenance.
        """
        index = json.loads(
            (MANIFEST.parent / "physical-destination-index.json").read_text()
        )
        m3 = next(s for s in index["sources"] if s["origin"] == "m3")
        self.assertEqual(m3["file"], M3_MIGRATION.name)
        self.assertEqual(m3["sha256"], M3_MIGRATION_SHA256)
        self.assertEqual(m3["sha256"], hashlib.sha256(M3_MIGRATION.read_bytes()).hexdigest())
        self.assertTrue(m3["applied"])
        self.assertEqual(m3["applied_at"], "2026-09-10T23:26:54Z")
        followup = next(s for s in index["sources"] if s["origin"] == "m3-followup")
        self.assertEqual(followup["file"], FOLLOWUP_MIGRATION.name)
        self.assertEqual(followup["sha256"], FOLLOWUP_MIGRATION_SHA256)
        self.assertEqual(
            followup["sha256"], hashlib.sha256(FOLLOWUP_MIGRATION.read_bytes()).hexdigest()
        )
        self.assertTrue(followup["applied"])
        self.assertIsNone(followup["applied_at"])
        self.assertEqual(
            followup["application_evidence"]["file"],
            "database/v2/m3-followup-target-validation-20260912.json",
        )
        self.assertEqual(
            followup["application_evidence"]["postcheck_observed_at"],
            "2026-09-12T14:58:40.77722+00:00",
        )
        blacklist = next(s for s in index["sources"] if s["origin"] == "blacklist-followup")
        self.assertEqual(blacklist["file"], BLACKLIST_MIGRATION.name)
        self.assertEqual(blacklist["sha256"], BLACKLIST_MIGRATION_SHA256)
        self.assertEqual(BLACKLIST_MIGRATION_SHA256, hashlib.sha256(BLACKLIST_MIGRATION.read_bytes()).hexdigest())
        self.assertTrue(blacklist["applied"])
        self.assertIsNone(blacklist["applied_at"])
        self.assertEqual(index["proposed_relations"], [])
        self.assertEqual(index["totals"]["proposed_relations"], 0)
        self.assertEqual(
            index["totals"]["applied_relations"], index["totals"]["relations"]
        )
        self.assertEqual(index["totals"]["pending_columns"], 0)
        self.assertEqual(index["totals"]["pending_dropped_columns"], 0)
        self.assertEqual(index["pending_columns"], {})
        self.assertEqual(index["pending_dropped_columns"], {})
        self.assertIn("blacklisted", index["relations"]["app.game_state"]["columns"])
        self.assertNotIn("slept_at", index["relations"]["app.game_state"]["columns"])

    def test_strict_final_load_rejects_pending_unapplied_schema(self):
        # Keep the pre-apply regression independent of the live applied state.
        index = json.loads((MANIFEST.parent / "physical-destination-index.json").read_text())
        next(s for s in index["sources"] if s["origin"] == "blacklist-followup")["applied"] = False
        index["pending_columns"] = {"app.game_state": {"columns": ["blacklisted"]}}
        index["pending_dropped_columns"] = {"app.game_state": {"columns": ["slept_at"]}}
        failures = validator.validate(
            self.manifest, json.loads(INVENTORY.read_text()),
            strict_final_load=True, destination_index=index,
        )
        self.assertTrue(any("V18" in failure for failure in failures))

    def test_applied_blacklist_and_unapplied_precision_have_distinct_gates(self):
        result = run_validator(MANIFEST, INVENTORY, "--final-load")
        self.assertEqual(result.returncode, 1)
        self.assertIn("V13", result.stderr)
        self.assertIn("V18", result.stderr)

    def test_manual_sessions_migrate_while_security_intents_expire(self):
        """The intent FK decision must not expire the long-lived manual cookie."""
        manual = next(
            r for r in self.manifest["relations"] if r["name"] == "manual_profile_sessions"
        )
        self.assertEqual(manual["disposition_class"], "migrated")
        self.assertEqual(manual["target"], "app.sessions")
        self.assertIn("session_kind 'manual'", manual["summary"])
        expected_targets = {
            "id": ("app.sessions.id", "migration.session_map.legacy_id"),
            "profile_id": ("app.sessions.account_id", "migration.session_map.account_id"),
            "token_hash": ("app.sessions.token_digest",),
            "created_at": ("app.sessions.created_at",),
            "last_seen_at": ("app.sessions.last_seen_at",),
            "expires_at": ("app.sessions.expires_at",),
        }
        columns = {column["name"]: column for column in manual["columns"]}
        self.assertEqual(set(columns), set(expected_targets))
        for name, targets in expected_targets.items():
            for target in targets:
                self.assertIn(target, columns[name].get("target", ""))
            self.assertIn(columns[name]["disposition"], ("transformed", "preserved"))

        intents = next(
            r for r in self.manifest["relations"] if r["name"] == "manual_profile_security_intents"
        )
        self.assertIn("pending security intents expire", intents["summary"])
        intent_columns = {column["name"]: column for column in intents["columns"]}
        source_session = intent_columns["source_manual_session_id"]
        self.assertEqual(source_session["disposition"], "derived-retirement")
        rationale = f"{source_session.get('note', '')} {source_session.get('recoverable_from', '')}"
        self.assertIn("intent-only", rationale)
        self.assertIn("migrated", rationale)
        self.assertNotIn("manual sessions are expired", rationale.lower())


class TestValidatorCatchesDrift(MutationHarness):
    def test_v1_unlisted_relation_in_source(self):
        inv = copy.deepcopy(self.inventory)
        inv["public_tables"].append(
            {
                "name": "brand_new_table",
                "kind": "r",
                "rls": True,
                "columns": [
                    {"ordinal": 1, "name": "id", "type": "uuid", "nullable": False}
                ],
                "constraints": [],
            }
        )
        self.assert_fails_with(self.manifest, inv, "V1")

    def test_v2_manifest_relation_gone_from_source(self):
        inv = copy.deepcopy(self.inventory)
        inv["public_tables"] = [
            t for t in inv["public_tables"] if t["name"] != "user_game_pins"
        ]
        self.assert_fails_with(self.manifest, inv, "V2")

    def test_v3_unlisted_column_in_source(self):
        inv = copy.deepcopy(self.inventory)
        table = next(t for t in inv["public_tables"] if t["name"] == "collections")
        table["columns"].append(
            {
                "ordinal": 99,
                "name": "newly_added_column",
                "type": "text",
                "nullable": True,
            }
        )
        self.assert_fails_with(self.manifest, inv, "V3")

    def test_v4_manifest_column_gone_from_source(self):
        inv = copy.deepcopy(self.inventory)
        table = next(t for t in inv["public_tables"] if t["name"] == "collections")
        table["columns"] = [c for c in table["columns"] if c["name"] != "description"]
        self.assert_fails_with(self.manifest, inv, "V4")

    def test_v5_changed_type(self):
        inv = copy.deepcopy(self.inventory)
        table = next(t for t in inv["public_tables"] if t["name"] == "user_games")
        col = next(c for c in table["columns"] if c["name"] == "hours_played")
        col["type"] = "double precision"  # was numeric(10,1)
        result = self.assert_fails_with(self.manifest, inv, "V5")
        self.assertIn("hours_played", result.stderr)

    def test_v6_changed_nullability(self):
        inv = copy.deepcopy(self.inventory)
        table = next(t for t in inv["public_tables"] if t["name"] == "user_games")
        col = next(
            c for c in table["columns"] if c["name"] == "observed_playtime_minutes"
        )
        col["nullable"] = False  # was nullable; NULL means unknown
        self.assert_fails_with(self.manifest, inv, "V6")

    def test_v7_missing_disposition_is_never_defaulted(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "sessions")
        col = next(c for c in rel["columns"] if c["name"] == "token_hash")
        removed = col.pop("disposition")
        self.assertEqual(removed, "transformed")
        # Keep totals consistent so the failure is unambiguously V7, not V10.
        man["totals"]["by_disposition"]["transformed"] -= 1
        result = self.assert_fails_with(man, self.inventory, "V7")
        self.assertIn("never defaulted", result.stderr)

    def test_v7_disposition_outside_vocabulary(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "collections")
        col = next(c for c in rel["columns"] if c["name"] == "name")
        col["disposition"] = "probably-fine"
        man["totals"]["by_disposition"]["preserved"] -= 1
        self.assert_fails_with(man, self.inventory, "V7")

    def test_v7_empty_disposition(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "collections")
        col = next(c for c in rel["columns"] if c["name"] == "name")
        col["disposition"] = ""
        man["totals"]["by_disposition"]["preserved"] -= 1
        self.assert_fails_with(man, self.inventory, "V7")

    def test_v8_view_column_claiming_migration(self):
        man = copy.deepcopy(self.manifest)
        rel = next(
            r for r in man["relations"] if r["name"] == "user_games_with_catalog"
        )
        col = next(c for c in rel["columns"] if c["name"] == "hours_played")
        col["disposition"] = "preserved"
        col["target"] = "app.library_games.playtime_minutes"
        man["totals"]["by_disposition"]["derived-retirement"] -= 1
        man["totals"]["by_disposition"]["preserved"] += 1
        self.assert_fails_with(man, self.inventory, "V8")

    def test_v9_changed_constraint(self):
        inv = copy.deepcopy(self.inventory)
        table = next(t for t in inv["public_tables"] if t["name"] == "account_merges")
        con = next(
            c
            for c in table["constraints"]
            if c["name"] == "account_merges_merge_mode_check"
        )
        con["definition"] = "CHECK ((merge_mode = ANY (ARRAY['promoted'::text])))"
        self.assert_fails_with(self.manifest, inv, "V9")

    def test_v10_tampered_totals(self):
        man = copy.deepcopy(self.manifest)
        man["totals"]["columns"] = 999
        self.assert_fails_with(man, self.inventory, "V10")

    def test_v10_tampered_disposition_counts(self):
        man = copy.deepcopy(self.manifest)
        man["totals"]["by_disposition"]["unresolved-decision"] = 1
        self.assert_fails_with(man, self.inventory, "V10")

    def test_v10_wrong_source_project(self):
        inv = copy.deepcopy(self.inventory)
        inv["source_project_ref"] = "some-other-project"
        self.assert_fails_with(self.manifest, inv, "V10")

    def test_v12_missing_inventory_source_identity(self):
        inv = copy.deepcopy(self.inventory)
        inv.pop("source_project_ref")
        self.assert_fails_with(self.manifest, inv, "V12")

    def test_v12_missing_manifest_source_identity(self):
        man = copy.deepcopy(self.manifest)
        man["source"].pop("project_ref")
        self.assert_fails_with(man, self.inventory, "V12")

    def test_v12_relation_kind_drift(self):
        inv = copy.deepcopy(self.inventory)
        relation = next(t for t in inv["public_tables"] if t["name"] == "collections")
        relation["kind"] = "v"
        self.assert_fails_with(self.manifest, inv, "V12")

    def test_v12_manifest_relation_kind_drift(self):
        man = copy.deepcopy(self.manifest)
        relation = next(r for r in man["relations"] if r["name"] == "collections")
        relation["kind"] = "v"
        self.assert_fails_with(man, self.inventory, "V12")

    def test_v12_duplicate_inventory_relation(self):
        inv = copy.deepcopy(self.inventory)
        inv["public_tables"].append(
            copy.deepcopy(next(t for t in inv["public_tables"] if t["name"] == "collections"))
        )
        self.assert_fails_with(self.manifest, inv, "V12")

    def test_v12_duplicate_inventory_column(self):
        inv = copy.deepcopy(self.inventory)
        relation = next(t for t in inv["public_tables"] if t["name"] == "collections")
        relation["columns"].append(copy.deepcopy(relation["columns"][0]))
        self.assert_fails_with(self.manifest, inv, "V12")

    def test_v13_strict_final_load_rejects_unresolved_decisions(self):
        result = run_validator(MANIFEST, INVENTORY, "--final-load")
        self.assertEqual(result.returncode, 1)
        self.assertIn("V13", result.stderr)
        self.assertIn("unresolved", result.stderr.lower())

    def test_v14_target_must_resolve_in_physical_sql_index(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "collections")
        col = next(c for c in rel["columns"] if c["name"] == "name")
        col["target"] = "app.collections.no_such_column"
        result = self.assert_fails_with(man, self.inventory, "V14")
        self.assertIn("no_such_column", result.stderr)

    def test_v14_destination_index_hash_drift_is_rejected(self):
        man = copy.deepcopy(self.manifest)
        man["physical_destination_index"]["sha256"] = "0" * 64
        result = self.assert_fails_with(man, self.inventory, "V14")
        self.assertIn("hash drift", result.stderr)

    def test_v14_missing_destination_sidecar_is_rejected(self):
        mp, ip = self.write_pair(self.manifest, self.inventory)
        (mp.parent / "physical-destination-index.json").unlink()
        result = run_validator(mp, ip)
        self.assertEqual(result.returncode, 1)
        self.assertIn("V14", result.stderr)
        self.assertIn("missing", result.stderr.lower())

    def test_v11_preserved_without_a_target(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "collections")
        col = next(c for c in rel["columns"] if c["name"] == "name")
        col.pop("target")
        self.assert_fails_with(man, self.inventory, "V11")

    def test_v11_archive_without_purpose(self):
        man = copy.deepcopy(self.manifest)
        rel = next(
            r for r in man["relations"] if r["name"] == "catalog_game_sightings"
        )
        rel["archive_purpose"] = ""
        self.assert_fails_with(man, self.inventory, "V11")

    def test_v11_archive_without_retention(self):
        man = copy.deepcopy(self.manifest)
        rel = next(
            r for r in man["relations"] if r["name"] == "catalog_game_sightings"
        )
        rel["archive_retention"] = ""
        self.assert_fails_with(man, self.inventory, "V11")

    def test_v11_unresolved_without_blocked_on(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "user_games")
        col = next(c for c in rel["columns"] if c["name"] == "hours_played")
        col["disposition"] = "unresolved-decision"
        self.assert_fails_with(man, self.inventory, "V11")


class TestCapabilityProjectionSemantics(MutationHarness):
    """V15: the account-tuple capability decision, checked as VALUES.

    The regression this class exists to prevent actually happened: all three
    account visibility transforms mapped a legacy false to 'hidden' while the
    surrounding prose said NULL must never become 'hidden'. Coverage validation
    passed, because nothing checked value semantics. These tests check them
    against the GENERATED manifest, in the same mode a coverage pass runs.
    """

    def _column(self, manifest, relation_name, column_name):
        rel = next(r for r in manifest["relations"] if r["name"] == relation_name)
        return next(c for c in rel["columns"] if c["name"] == column_name)

    # -- positive: the committed artefacts carry the binding semantics --------

    def test_manifest_declares_the_binding_mapping(self):
        declared = self.manifest["value_semantics"]["capability_projection"]
        self.assertEqual(declared["mapping"], BINDING_CAPABILITY_MAPPING)
        self.assertEqual(
            sorted(declared["forbidden_projections"]), ["hidden", "private"]
        )
        self.assertEqual(declared["authority"], "docs/v2-m3-capability-decision.md")

    def test_all_six_legacy_visibility_columns_project_false_to_unknown(self):
        for relation, column, feeds in LEGACY_VISIBILITY_COLUMNS:
            with self.subTest(relation=relation, column=column):
                col = self._column(self.manifest, relation, column)
                projection = col.get("capability_projection")
                self.assertIsInstance(
                    projection,
                    dict,
                    f"{relation}.{column} has no structured capability_projection",
                )
                self.assertEqual(
                    projection["mapping"],
                    BINDING_CAPABILITY_MAPPING,
                    f"{relation}.{column} contradicts the account tuple decision",
                )
                self.assertEqual(projection["feeds_capability"], feeds)
                self.assertEqual(
                    projection["evidence_precedence"],
                    "account_writer" if feeds else "profile_reader",
                )

    def test_no_legacy_visibility_column_ever_projects_to_hidden(self):
        for relation, column, _ in LEGACY_VISIBILITY_COLUMNS:
            with self.subTest(relation=relation, column=column):
                projection = self._column(self.manifest, relation, column)[
                    "capability_projection"
                ]
                self.assertNotIn("hidden", projection["mapping"].values())
                self.assertNotIn("private", projection["mapping"].values())

    def test_every_projection_preserves_the_raw_observation(self):
        """false and NULL collapse to 'unknown', so the raw flag must survive."""
        for relation, column, _ in LEGACY_VISIBILITY_COLUMNS:
            with self.subTest(relation=relation, column=column):
                projection = self._column(self.manifest, relation, column)[
                    "capability_projection"
                ]
                raw = projection["raw_evidence_target"]
                self.assertTrue(
                    raw.startswith("app.account_capability_evidence."),
                    f"{relation}.{column} raw evidence goes to {raw!r}",
                )

    def test_account_side_target_writes_both_projection_and_raw_evidence(self):
        """The authoritative side must not keep only the lossy projection."""
        for column in (
            "steam_library_visible",
            "steam_playtime_visible",
            "steam_last_played_visible",
        ):
            with self.subTest(column=column):
                target = self._column(self.manifest, "app_accounts", column)["target"]
                self.assertIn("app.account_capabilities.", target)
                self.assertIn(
                    "app.account_capability_evidence.", target
                )

    def test_profile_side_never_writes_the_tri_state(self):
        for column in (
            "steam_library_visible",
            "steam_playtime_visible",
            "steam_last_played_visible",
            "steam_visibility_checked_at",
            "steam_games_seen",
        ):
            with self.subTest(column=column):
                col = self._column(self.manifest, "app_users", column)
                self.assertNotIn("app.account_capabilities", col.get("target", ""))

    def test_no_prose_anywhere_projects_false_or_null_to_hidden(self):
        """The exact regression: prose is checked across all 486 columns."""
        offenders = []
        for rel in self.manifest["relations"]:
            for col in rel["columns"]:
                for field in ("transform", "note", "blocked_on", "recoverable_from"):
                    text = col.get(field)
                    if isinstance(
                        text, str
                    ) and validator.FORBIDDEN_PROSE_PROJECTION_RE.search(text):
                        offenders.append(f"{rel['name']}.{col['name']}.{field}")
        self.assertEqual(offenders, [])

    def test_m3_projection_status_domain_has_no_hidden(self):
        """Cross-artefact: the sibling's SQL agrees, and is read only."""
        sql = M3_MIGRATION.read_text()
        marker = "projection_status text not null default 'unresolved'"
        self.assertIn(marker, sql)
        window = sql[sql.index(marker) : sql.index(marker) + 240]
        self.assertIn("'visible'", window)
        self.assertIn("'unknown'", window)
        self.assertNotIn("'hidden'", window)

    # -- negative: each regression class is rejected --------------------------

    def test_v15_rejects_a_mapping_that_makes_false_hidden(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_accounts", "steam_library_visible")[
            "capability_projection"
        ]["mapping"]["false"] = "hidden"
        result = self.assert_fails_with(man, self.inventory, "V15")
        self.assertIn("not evidence that the account is private", result.stderr)

    def test_v15_rejects_a_mapping_that_makes_null_hidden(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_accounts", "steam_playtime_visible")[
            "capability_projection"
        ]["mapping"]["null"] = "hidden"
        self.assert_fails_with(man, self.inventory, "V15")

    def test_v15_rejects_prose_that_reintroduces_the_old_rule(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_accounts", "steam_playtime_visible")["transform"] = (
            "true->'visible', false->'hidden', NULL->'unknown'."
        )
        result = self.assert_fails_with(man, self.inventory, "V15")
        self.assertIn("transform", result.stderr)

    def test_v15_rejects_a_tri_state_target_with_no_structured_projection(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_accounts", "steam_last_played_visible").pop(
            "capability_projection"
        )
        result = self.assert_fails_with(man, self.inventory, "V15")
        self.assertIn("machine-checkable", result.stderr)

    def test_v15_rejects_a_projection_that_discards_the_raw_observation(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_users", "steam_library_visible")[
            "capability_projection"
        ].pop("raw_evidence_target")
        result = self.assert_fails_with(man, self.inventory, "V15")
        self.assertIn("must be preserved", result.stderr)

    def test_v15_rejects_a_missing_boolean_state(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_users", "steam_playtime_visible")[
            "capability_projection"
        ]["mapping"].pop("null")
        self.assert_fails_with(man, self.inventory, "V15")

    def test_v15_rejects_a_manifest_with_no_declared_rule(self):
        man = copy.deepcopy(self.manifest)
        man.pop("value_semantics")
        self.assert_fails_with(man, self.inventory, "V15")

    def test_v15_rejects_a_tampered_declared_rule(self):
        man = copy.deepcopy(self.manifest)
        man["value_semantics"]["capability_projection"]["mapping"]["false"] = "hidden"
        self.assert_fails_with(man, self.inventory, "V15")

    def test_v15_rejects_a_profile_side_row_claiming_to_feed_the_tri_state(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_users", "steam_last_played_visible")[
            "capability_projection"
        ]["feeds_capability"] = True
        self.assert_fails_with(man, self.inventory, "V15")

    def test_v15_rejects_raw_evidence_pointed_somewhere_else(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_accounts", "steam_library_visible")[
            "capability_projection"
        ]["raw_evidence_target"] = "app.account_capabilities.library_visibility"
        self.assert_fails_with(man, self.inventory, "V15")

    def test_v15_runs_in_final_load_mode_too(self):
        man = copy.deepcopy(self.manifest)
        self._column(man, "app_accounts", "steam_library_visible")[
            "capability_projection"
        ]["mapping"]["false"] = "hidden"
        mp, ip = self.write_pair(man, self.inventory)
        result = run_validator(mp, ip, "--final-load")
        self.assertEqual(result.returncode, 1)
        self.assertIn("V15", result.stderr)

    def test_builder_refuses_to_emit_the_old_rule(self):
        """The gate is at build time as well, not only at validation time."""
        tmp = Path(tempfile.mkdtemp(prefix="m3-capability-build-"))
        decisions = tmp / "dispositions"
        decisions.mkdir()
        for f in sorted(DECISIONS_DIR.glob("*.json")):
            (decisions / f.name).write_text(f.read_text())
        inventory = tmp / "inventory.json"
        inventory.write_text(INVENTORY.read_text())
        path = decisions / "00-identity-and-sessions.json"
        doc = json.loads(path.read_text())
        col = doc["relations"]["app_accounts"]["columns"]["steam_library_visible"]
        col["capability_projection"]["mapping"]["false"] = "hidden"
        path.write_text(json.dumps(doc))
        result = subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--inventory",
                str(inventory),
                "--decisions",
                str(decisions),
                "--output",
                str(tmp / "out.json"),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("steam_library_visible", result.stderr)
        self.assertIn("privacy", result.stderr)


class TestPendingDestinationRatchet(MutationHarness):
    """V16: a decision blocked only by a missing column cannot stay open."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.index = json.loads(
            (MANIFEST.parent / "physical-destination-index.json").read_text()
        )

    def _last_login(self, manifest=None):
        manifest = manifest or self.manifest
        rel = next(r for r in manifest["relations"] if r["name"] == "app_users")
        return next(c for c in rel["columns"] if c["name"] == "last_login_at")

    def _pending_manifest(self):
        """Recreate the pre-DDL state to exercise V16 against today's index."""
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "app_users")
        col = next(c for c in rel["columns"] if c["name"] == "last_login_at")
        col["disposition"] = "unresolved-decision"
        col.pop("target", None)
        col["blocked_on"] = "physical destination test fixture"
        col["pending_destination"] = {
            "target": "app.accounts.last_login_at",
            "approved_by": "synthetic V16 fixture",
            "owner": "synthetic V16 fixture",
            "on_availability": "preserved",
            "resulting_target": "app.accounts.last_login_at",
        }
        rel["open_decisions"] = ["D-IDN-4 synthetic pending fixture"]
        return man

    def test_last_login_is_closed_after_the_destination_lands(self):
        column = self._last_login()
        self.assertEqual(column["disposition"], "preserved")
        self.assertEqual(column["target"], "app.accounts.last_login_at")
        self.assertNotIn("pending_destination", column)
        rel = next(r for r in self.manifest["relations"] if r["name"] == "app_users")
        self.assertEqual(rel["open_decisions"], [])

    def test_the_destination_is_present_in_the_physical_index(self):
        columns = self.index["relations"]["app.accounts"]["columns"]
        self.assertIn("last_login_at", columns)

    def test_last_login_never_collapses_into_last_seen_at(self):
        """The forbidden closures remain asserted after D-IDN-4 closes."""
        column = self._last_login()
        blob = json.dumps(column).lower()
        self.assertNotIn("max(last_visited_at", blob)
        self.assertIn("no derivation from visits", blob)
        # last_visited_at keeps its own, separate destination.
        accounts = next(
            r for r in self.manifest["relations"] if r["name"] == "app_accounts"
        )
        visited = next(
            c for c in accounts["columns"] if c["name"] == "last_visited_at"
        )
        self.assertEqual(visited["target"], "app.accounts.last_seen_at")
        self.assertEqual(visited["disposition"], "preserved")

    def test_v16_fires_the_moment_the_destination_appears(self):
        man = self._pending_manifest()
        mp, ip = self.write_pair(man, self.inventory)
        result = run_validator(mp, ip)
        self.assertEqual(
            result.returncode,
            1,
            msg=f"V16 did not fire.\nstdout={result.stdout}\nstderr={result.stderr}",
        )
        self.assertIn("V16", result.stderr)
        self.assertIn("app.accounts.last_login_at", result.stderr)
        self.assertIn("NOW EXISTS", result.stderr)

    def test_v16_fires_in_coverage_mode_not_only_final_load(self):
        """A coverage pass must not silently accept a stale open decision."""
        man = self._pending_manifest()
        mp, ip = self.write_pair(man, self.inventory)
        for extra in ([], ["--final-load"]):
            with self.subTest(mode=extra or ["coverage"]):
                result = run_validator(mp, ip, *extra)
                self.assertEqual(result.returncode, 1)
                self.assertIn("V16", result.stderr)

    def test_v16_rejects_a_pending_record_that_says_nothing(self):
        man = self._pending_manifest()
        rel = next(r for r in man["relations"] if r["name"] == "app_users")
        col = next(c for c in rel["columns"] if c["name"] == "last_login_at")
        col["pending_destination"].pop("resulting_target")
        self.assert_fails_with(man, self.inventory, "V16")

    def test_v16_rejects_a_pending_record_on_an_already_closed_column(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "app_accounts")
        col = next(c for c in rel["columns"] if c["name"] == "created_at")
        col["pending_destination"] = {
            "target": "app.accounts.created_at",
            "approved_by": "x",
            "owner": "y",
            "on_availability": "preserved",
            "resulting_target": "app.accounts.created_at",
        }
        self.assert_fails_with(man, self.inventory, "V16")

    def test_builder_rejects_a_pending_record_on_a_decided_column(self):
        tmp = Path(tempfile.mkdtemp(prefix="m3-pending-build-"))
        decisions = tmp / "dispositions"
        decisions.mkdir()
        for f in sorted(DECISIONS_DIR.glob("*.json")):
            (decisions / f.name).write_text(f.read_text())
        inventory = tmp / "inventory.json"
        inventory.write_text(INVENTORY.read_text())
        path = decisions / "00-identity-and-sessions.json"
        doc = json.loads(path.read_text())
        doc["relations"]["app_accounts"]["columns"]["created_at"][
            "pending_destination"
        ] = {
            "target": "app.accounts.created_at",
            "approved_by": "x",
            "owner": "y",
            "on_availability": "preserved",
            "resulting_target": "app.accounts.created_at",
        }
        path.write_text(json.dumps(doc))
        result = subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--inventory",
                str(inventory),
                "--decisions",
                str(decisions),
                "--output",
                str(tmp / "out.json"),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("pending_destination is only", result.stderr)


def sql_retention_defaults(sql: str) -> dict[str, str]:
    """Read `retention_class ... default '<x>'` per created relation.

    Read-only. The migration is owned by the database worker; these tests never
    write it, and they record what it currently says rather than asserting what
    it ought to say beyond the classes plan 13 fixes.
    """
    defaults: dict[str, str] = {}
    current = None
    for line in sql.splitlines():
        created = re.match(r"\s*create table ([a-z_]+\.[a-z_]+)\s*\(", line)
        if created:
            current = created.group(1)
            continue
        found = re.search(r"retention_class text not null default '([^']+)'", line)
        if found and current:
            defaults[current] = found.group(1)
    return defaults


class TestRetentionClasses(MutationHarness):
    """V17: personal data is bounded by the account, not by a release cycle."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.sql_defaults = sql_retention_defaults(M3_MIGRATION.read_text())

    def _archives(self):
        for rel in self.manifest["relations"]:
            if any(c["disposition"] == "audit-archive" for c in rel["columns"]):
                yield rel

    def test_every_archive_declares_a_structured_retention(self):
        for rel in self._archives():
            with self.subTest(relation=rel["name"]):
                self.assertIsInstance(rel.get("retention"), dict)

    def test_no_personal_archive_is_bounded_by_a_release_cycle_or_a_feature(self):
        for rel in self._archives():
            retention = rel["retention"]
            if not retention["carries_account_identity"]:
                continue
            with self.subTest(relation=rel["name"]):
                self.assertIn(
                    retention["bound"],
                    ("while-the-account-exists", "30-days-after-validated-cutover"),
                    f"{rel['name']} bounds personal data by "
                    f"{retention['bound']!r}",
                )
                prose = rel["archive_retention"].lower()
                for phrase in validator.UNBOUNDED_PERSONAL_PHRASES:
                    self.assertNotIn(phrase, prose)

    def test_every_account_keyed_archive_states_deletion_and_export(self):
        for rel in self._archives():
            retention = rel["retention"]
            if not retention["carries_account_identity"]:
                continue
            with self.subTest(relation=rel["name"]):
                self.assertTrue(retention["account_deletion"])
                self.assertTrue(retention["account_export"])

    def test_raw_staging_is_bounded_to_thirty_days_after_cutover(self):
        staging = [
            r
            for r in self._archives()
            if r["retention"]["class"] == "bounded-migration-staging"
        ]
        self.assertTrue(staging, "no archive is classed as migration staging")
        for rel in staging:
            with self.subTest(relation=rel["name"]):
                self.assertEqual(
                    rel["retention"]["bound"], "30-days-after-validated-cutover"
                )

    def test_sole_authored_evidence_has_a_durable_home(self):
        """Ruling 12: do not discard sole authored or provenance evidence."""
        for name in (
            "user_games",
            "purge_reviews",
            "collection_games",
        ):
            with self.subTest(relation=name):
                rel = next(r for r in self.manifest["relations"] if r["name"] == name)
                self.assertEqual(
                    rel["retention"]["class"],
                    "durable-private-fact",
                    f"{name} holds authored values that survive nowhere else",
                )
                self.assertEqual(
                    rel["retention"]["bound"], "while-the-account-exists"
                )

        stale = next(
            r for r in self.manifest["relations"] if r["name"] == "user_game_state"
        )
        self.assertEqual(
            stale["retention"]["class"], "bounded-migration-staging"
        )
        promotion = stale["retention"].get("durable_promotion")
        self.assertIsInstance(promotion, dict)
        self.assertEqual(
            promotion["destination"], "app.game_state_legacy_measurements"
        )
        self.assertEqual(promotion["class"], "durable-private-fact")
        self.assertEqual(promotion["bound"], "while-the-account-exists")
        index = json.loads((MANIFEST.parent / "physical-destination-index.json").read_text())
        physical = index["retention_registry"]["relations"][
            promotion["destination"]
        ]
        self.assertEqual(physical["retention_class"], "durable-account-lifetime")
        self.assertEqual(physical["export_scope"], "account_export")

    def test_declared_physical_divergences_are_still_real(self):
        """A ratchet on the sibling's SQL, in the direction of convergence.

        Each divergence records the retention_class default the physical
        migration currently carries. When the database worker corrects one, this
        test fails, and the ledger entry must be removed rather than left
        asserting a stale disagreement.
        """
        for rel in self._archives():
            divergence = rel["retention"].get("physical_default_divergence")
            if not divergence:
                continue
            destination = rel["retention"]["destination"]
            recorded = divergence["sql_retention_class_default"]
            actual = self.sql_defaults.get(destination)
            with self.subTest(relation=rel["name"]):
                if recorded.startswith("("):
                    # e.g. "(no retention_class column in the M3 SQL)"
                    self.assertIsNone(
                        actual,
                        f"{destination} now has retention_class {actual!r}; update "
                        f"the divergence ledger for {rel['name']}",
                    )
                else:
                    self.assertEqual(
                        actual,
                        recorded,
                        f"{destination} retention_class default is now {actual!r}, "
                        f"not the recorded {recorded!r}; the divergence for "
                        f"{rel['name']} is stale and must be re-reviewed",
                    )

    def test_undeclared_archives_agree_with_the_physical_default(self):
        """Where no divergence is declared, the two artefacts must agree."""
        account_bounded = {
            "permanent-while-account-exists",
            "durable-account-lifetime",
        }
        cutover_bounded = {
            "30-days-after-cutover",
            "30-days-after-validated-cutover",
            "staging-30d-post-cutover",
            "m3-signoff",
        }
        for rel in self._archives():
            retention = rel["retention"]
            if retention.get("physical_default_divergence"):
                continue
            actual = self.sql_defaults.get(retention["destination"])
            if actual is None:
                continue
            with self.subTest(relation=rel["name"]):
                if retention["class"] == "durable-private-fact":
                    self.assertIn(actual, account_bounded)
                elif retention["class"] == "bounded-migration-staging":
                    self.assertIn(actual, cutover_bounded)

    # -- negative -------------------------------------------------------------

    def test_v17_rejects_an_archive_with_no_retention_record(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "purge_reviews")
        rel.pop("retention")
        self.assert_fails_with(man, self.inventory, "V17")

    def test_v17_rejects_a_release_cycle_bound_on_personal_data(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "user_games")
        rel["retention"]["bound"] = "m3-signoff-plus-one-release"
        result = self.assert_fails_with(man, self.inventory, "V17")
        self.assertIn("while-the-account-exists", result.stderr)

    def test_v17_rejects_a_feature_lifetime_claim_in_prose(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "purge_reviews")
        rel["archive_retention"] = "Permanent while the purge feature exists."
        result = self.assert_fails_with(man, self.inventory, "V17")
        self.assertIn("Plan 13 allows", result.stderr)

    def test_v17_rejects_personal_data_classed_as_operational(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "user_games")
        rel["retention"]["class"] = "operational-provenance"
        rel["retention"]["bound"] = "whenever"
        result = self.assert_fails_with(man, self.inventory, "V17")
        self.assertIn("account key", result.stderr)

    def test_v17_rejects_an_account_keyed_archive_with_no_deletion_semantics(self):
        man = copy.deepcopy(self.manifest)
        rel = next(r for r in man["relations"] if r["name"] == "user_games")
        rel["retention"]["account_deletion"] = ""
        self.assert_fails_with(man, self.inventory, "V17")

    def test_v17_rejects_staging_stretched_past_the_cutover_window(self):
        man = copy.deepcopy(self.manifest)
        rel = next(
            r
            for r in man["relations"]
            if r["name"] == "manual_profile_security_intents"
        )
        rel["retention"]["bound"] = "90-days-after-cutover"
        self.assert_fails_with(man, self.inventory, "V17")

    def test_builder_rejects_an_archive_with_no_retention(self):
        tmp = Path(tempfile.mkdtemp(prefix="m3-retention-build-"))
        decisions = tmp / "dispositions"
        decisions.mkdir()
        for f in sorted(DECISIONS_DIR.glob("*.json")):
            (decisions / f.name).write_text(f.read_text())
        inventory = tmp / "inventory.json"
        inventory.write_text(INVENTORY.read_text())
        path = decisions / "01-library-and-state.json"
        doc = json.loads(path.read_text())
        doc["relations"]["purge_reviews"].pop("retention")
        path.write_text(json.dumps(doc))
        result = subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--inventory",
                str(inventory),
                "--decisions",
                str(decisions),
                "--output",
                str(tmp / "out.json"),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("structured 'retention'", result.stderr)


class TestDispositionForNeverDefaults(unittest.TestCase):
    """Rule zero, asserted directly against the function."""

    def test_raises_on_missing_key(self):
        with self.assertRaises(validator.ManifestDefect):
            validator.disposition_for({"name": "x"}, "some_relation")

    def test_raises_on_none(self):
        with self.assertRaises(validator.ManifestDefect):
            validator.disposition_for({"name": "x", "disposition": None}, "r")

    def test_raises_on_unknown_value(self):
        with self.assertRaises(validator.ManifestDefect):
            validator.disposition_for({"name": "x", "disposition": "maybe"}, "r")

    def test_returns_only_real_values(self):
        for disp in sorted(validator.VALID_DISPOSITIONS):
            self.assertEqual(
                validator.disposition_for({"name": "x", "disposition": disp}, "r"),
                disp,
            )

    def test_no_fallback_literal_anywhere_in_the_validator(self):
        """A grep-level guard: no `.get("disposition", ...)` with a default."""
        source = VALIDATOR.read_text()
        self.assertNotIn('get("disposition",', source)
        self.assertNotIn("get('disposition',", source)


class TestGeneratorEnforcesCoverage(unittest.TestCase):
    """The generator is what makes a missing column impossible, not unlikely."""

    def _build_with(self, decisions_dir: Path, inventory_path: Path):
        return subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--inventory",
                str(inventory_path),
                "--decisions",
                str(decisions_dir),
                "--output",
                str(decisions_dir.parent / "out.json"),
            ],
            capture_output=True,
            text=True,
        )

    def _fixture(self):
        tmp = Path(tempfile.mkdtemp(prefix="m3-builder-test-"))
        decisions = tmp / "dispositions"
        decisions.mkdir()
        for f in sorted(DECISIONS_DIR.glob("*.json")):
            (decisions / f.name).write_text(f.read_text())
        inventory = tmp / "inventory.json"
        inventory.write_text(INVENTORY.read_text())
        return tmp, decisions, inventory

    def test_baseline_fixture_builds(self):
        tmp, decisions, inventory = self._fixture()
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("486 columns", result.stdout)

    def test_build_fails_when_a_column_has_no_decision(self):
        tmp, decisions, inventory = self._fixture()
        path = decisions / "01-library-and-state.json"
        doc = json.loads(path.read_text())
        doc["relations"]["user_games"]["columns"].pop("observed_playtime_minutes")
        path.write_text(json.dumps(doc))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("observed_playtime_minutes", result.stderr)
        self.assertIn("no disposition", result.stderr)
        self.assertIn("there is no default", result.stderr)

    def test_build_fails_when_a_whole_relation_has_no_decision(self):
        tmp, decisions, inventory = self._fixture()
        path = decisions / "02-collections-and-vault.json"
        doc = json.loads(path.read_text())
        doc["relations"].pop("user_game_snoozes")
        path.write_text(json.dumps(doc))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("user_game_snoozes", result.stderr)
        self.assertIn("NO decision entry", result.stderr)

    def test_build_fails_when_source_identity_is_missing(self):
        tmp, decisions, inventory = self._fixture()
        doc = json.loads(inventory.read_text())
        doc.pop("source_project_ref")
        inventory.write_text(json.dumps(doc))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("source_project_ref is required", result.stderr)

    def test_build_fails_when_inventory_kind_is_invalid(self):
        tmp, decisions, inventory = self._fixture()
        doc = json.loads(inventory.read_text())
        relation = next(t for t in doc["public_tables"] if t["name"] == "collections")
        relation["kind"] = "m"
        inventory.write_text(json.dumps(doc))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("inventory kind", result.stderr)

    def test_build_fails_when_decision_kind_disagrees_with_inventory(self):
        tmp, decisions, inventory = self._fixture()
        path = decisions / "02-collections-and-vault.json"
        doc = json.loads(path.read_text())
        doc["relations"]["collections"]["kind"] = "v"
        path.write_text(json.dumps(doc))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("disagrees with inventory", result.stderr)

    def test_build_fails_on_a_stale_decision(self):
        tmp, decisions, inventory = self._fixture()
        path = decisions / "02-collections-and-vault.json"
        doc = json.loads(path.read_text())
        doc["relations"]["collections"]["columns"]["colour_theme"] = {
            "disposition": "preserved",
            "target": "app.collections.colour_theme",
            "note": "a column that does not exist",
        }
        path.write_text(json.dumps(doc))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("colour_theme", result.stderr)
        self.assertIn("absent from the inventory", result.stderr)

    def test_build_fails_on_a_duplicate_relation_across_files(self):
        tmp, decisions, inventory = self._fixture()
        dup = json.loads((decisions / "07-views.json").read_text())
        src = json.loads((decisions / "02-collections-and-vault.json").read_text())
        dup["relations"]["collections"] = src["relations"]["collections"]
        (decisions / "08-duplicate.json").write_text(json.dumps(dup))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("already decided", result.stderr)

    def test_build_fails_when_a_view_column_claims_migration(self):
        tmp, decisions, inventory = self._fixture()
        path = decisions / "07-views.json"
        doc = json.loads(path.read_text())
        doc["relations"]["user_games_with_catalog"]["columns"]["notes"] = {
            "disposition": "preserved",
            "target": "app.game_state.notes",
            "note": "a view row cannot be migrated",
        }
        path.write_text(json.dumps(doc))
        result = self._build_with(decisions, inventory)
        self.assertEqual(result.returncode, 1)
        self.assertIn("view columns must be", result.stderr)

    def test_committed_manifest_is_not_stale(self):
        result = subprocess.run(
            [sys.executable, str(BUILDER), "--check"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            msg=f"the committed manifest does not match its decision files "
            f"(rebuild it):\n{result.stderr}",
        )

    def test_regeneration_is_deterministic(self):
        tmp, decisions, inventory = self._fixture()
        first = self._build_with(decisions, inventory)
        self.assertEqual(first.returncode, 0, msg=first.stderr)
        out = decisions.parent / "out.json"
        a = out.read_text()
        second = self._build_with(decisions, inventory)
        self.assertEqual(second.returncode, 0, msg=second.stderr)
        self.assertEqual(a, out.read_text(), "manifest generation is not stable")


if __name__ == "__main__":
    unittest.main(verbosity=2)
