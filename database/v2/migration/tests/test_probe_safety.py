#!/usr/bin/env python3
"""Mechanical safety checks on the M3 source probes.

The probes are count-only by policy. Policy in a README is not enforcement, so
this test enforces it: it parses every statement in
`database/v2/migration/probes/*.sql` and fails on anything that could return a
row of user data, mutate the source, or read a secret.

What it enforces
----------------
S1  Every statement is a read: SELECT or WITH. No INSERT/UPDATE/DELETE/DDL,
    no FOR UPDATE, no locking clause.
S2  `vault.secrets` (and any decrypted view over it) is never referenced.
S3  `cron.job.command` is never projected. It can contain an Authorization
    header, so it may only appear inside a boolean or length expression.
S4  No `SELECT *` anywhere.
S5  Every statement that reads a `public` data relation is an AGGREGATE query:
    it must contain count/sum/min/max/avg, so it cannot return raw rows.
S6  No known-private column is ever projected bare into a target list.
S7  No `LIMIT`. A probe that needs LIMIT to be safe is not count-only.
S8  Every public data relation reference is explicitly schema-qualified.

Run:
    python3 -m unittest discover -s database/v2/migration/tests -v

Stdlib only. Reads .sql files as text; connects to nothing.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIGRATION_ROOT = HERE.parent
V2_ROOT = MIGRATION_ROOT.parent
PROBES_DIR = MIGRATION_ROOT / "probes"
INVENTORY = V2_ROOT / "source-schema-inventory-20260909.json"

# Columns that must never be projected. Either they are personal data, a
# credential-adjacent digest, or free text a user wrote.
PRIVATE_COLUMNS = {
    "token_hash",
    "key_hash",
    "dedupe_hash",
    "email",
    "contact_email",
    "message",
    "subject",
    "notes",
    "note",
    "review_notes",
    "display_name",
    "steam_display_name",
    "avatar_url",
    "profile_url",
    "steam_profile_url",
    "steam_id",
    "verified_steam_id",
    "family_owner_steam_id",
    "openid_response_nonce",
    "source_url",
    "last_error",
    "last_error_message",
    "error_message",
    "response_text",
    "search_title",
    "date_added",
    "command",
    "prosrc",
    "games",
    "client_context",
    "context",
    "source_payload",
    "evidence",
    "manifest",
    "summary",
    "counts",
    "rules",
    "tags",
    "candidate_appids",
    "finalist_appids",
    "selected_genres",
    "return_message",
}

WRITE_KEYWORDS = (
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "grant",
    "revoke",
    "create",
    "comment on",
    "for update",
    "for no key update",
    "for share",
    "lock table",
)

AGGREGATES = ("count(", "sum(", "min(", "max(", "avg(", "round(avg")

# Reading catalogue metadata is reading SCHEMA, not data.
CATALOG_SOURCES = (
    "pg_class",
    "pg_namespace",
    "pg_attribute",
    "pg_constraint",
    "pg_proc",
    "pg_trigger",
    "pg_roles",
    "pg_policy",
    "pg_language",
    "pg_attrdef",
    "information_schema",
    "supabase_migrations",
)


def strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    sql = re.sub(r"--[^\n]*", " ", sql)
    return sql


def statements(sql: str) -> list[str]:
    body = strip_comments(sql)
    return [s.strip() for s in body.split(";") if s.strip()]


def load_probe_files() -> list[Path]:
    return sorted(PROBES_DIR.glob("*.sql"))


def public_relation_names() -> set[str]:
    inv = json.loads(INVENTORY.read_text())
    return {t["name"] for t in inv["public_tables"]}


class TestProbeFilesExist(unittest.TestCase):
    def test_probe_files_present(self):
        files = load_probe_files()
        self.assertGreaterEqual(len(files), 4, "expected the P01-P08 probe set")
        names = {f.name for f in files}
        for expected in (
            "p01-p04-inventory-and-access.sql",
            "p05-p06-playtime-and-staging.sql",
            "p07-constraint-conflicts.sql",
            "p08-code-books.sql",
            "px-value-domains.sql",
            "platform-optional.sql",
        ):
            self.assertIn(expected, names)

    def test_readme_states_nothing_has_been_run(self):
        readme = (PROBES_DIR / "README.md").read_text().lower()
        self.assertIn("has been run", readme)
        self.assertIn("count-only", readme)


class TestProbeSafety(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = load_probe_files()
        cls.relations = public_relation_names()

    def each_statement(self):
        for path in self.files:
            for index, stmt in enumerate(statements(path.read_text()), start=1):
                yield path, index, stmt

    def test_s1_every_statement_is_a_read(self):
        for path, index, stmt in self.each_statement():
            lowered = stmt.lower()
            self.assertTrue(
                lowered.startswith("select") or lowered.startswith("with"),
                f"{path.name} statement {index} does not start with SELECT/WITH: "
                f"{stmt[:80]!r}",
            )
            for kw in WRITE_KEYWORDS:
                # Word boundaries matter: 'created_at' is not CREATE, and
                # 'last_updated' is not UPDATE.
                self.assertIsNone(
                    re.search(rf"\b{kw}\b", lowered),
                    f"{path.name} statement {index} contains write keyword {kw!r}",
                )

    def test_s2_vault_secrets_is_never_referenced(self):
        for path in self.files:
            lowered = strip_comments(path.read_text()).lower()
            for forbidden in (
                "vault.secrets",
                "decrypted_secrets",
                "vault.decrypted",
                "pgsodium",
            ):
                self.assertNotIn(
                    forbidden,
                    lowered,
                    f"{path.name} references {forbidden!r}; vault secrets are "
                    f"excluded from every probe and every export",
                )

    def test_s3_cron_command_is_never_projected(self):
        """`command` may only appear inside ilike/length, never as a column."""
        for path, index, stmt in self.each_statement():
            if "cron.job" not in stmt.lower():
                continue
            for line in stmt.splitlines():
                bare = line.strip().rstrip(",").strip()
                self.assertNotEqual(
                    bare.lower(),
                    "command",
                    f"{path.name} statement {index} projects cron.job.command",
                )
            # Every mention must be wrapped in a safe expression.
            for match in re.finditer(r"\bcommand\b", stmt.lower()):
                window = stmt.lower()[max(0, match.start() - 40) : match.end() + 40]
                self.assertTrue(
                    "ilike" in window or "length(" in window or "command_" in window,
                    f"{path.name} statement {index} uses `command` outside a "
                    f"boolean/length expression: {window!r}",
                )

    def test_s4_no_select_star(self):
        for path, index, stmt in self.each_statement():
            self.assertNotRegex(
                stmt.lower(),
                r"select\s+\*",
                f"{path.name} statement {index} uses SELECT *",
            )

    def test_s5_data_statements_are_aggregates(self):
        for path, index, stmt in self.each_statement():
            lowered = stmt.lower()
            if any(src in lowered for src in CATALOG_SOURCES):
                continue  # schema metadata, not data
            touches_data = any(
                re.search(rf"\b(from|join)\s+public\.{re.escape(rel)}\b", lowered)
                for rel in self.relations
            )
            if not touches_data:
                continue
            self.assertTrue(
                any(agg in lowered for agg in AGGREGATES),
                f"{path.name} statement {index} reads a public data relation "
                f"without an aggregate; it could return raw rows:\n{stmt[:200]}",
            )

    def test_s6_no_private_column_is_projected_bare(self):
        for path, index, stmt in self.each_statement():
            lowered = stmt.lower()
            if any(src in lowered for src in CATALOG_SOURCES):
                continue
            in_select_list = False
            for line in stmt.splitlines():
                bare = line.strip()
                if not bare:
                    continue
                low = bare.lower()
                if low.startswith("select"):
                    in_select_list = True
                    rest = low[len("select") :].strip().rstrip(",").strip()
                    if rest in PRIVATE_COLUMNS:
                        self.fail(
                            f"{path.name} statement {index} projects private "
                            f"column {rest!r}"
                        )
                    continue
                if low.startswith(("from ", "where ", "group by", "order by", "join ")):
                    in_select_list = False
                if not in_select_list:
                    continue
                candidate = bare.rstrip(",").strip().lower()
                # `x as y` -- the projected expression is the part before `as`.
                expr = candidate.split(" as ")[0].strip()
                self.assertNotIn(
                    expr,
                    PRIVATE_COLUMNS,
                    f"{path.name} statement {index} projects private column "
                    f"{expr!r} (line: {bare!r})",
                )

    def test_s7_no_limit_clauses(self):
        for path, index, stmt in self.each_statement():
            self.assertNotRegex(
                stmt.lower(),
                r"\blimit\s+\d+",
                f"{path.name} statement {index} uses LIMIT; a probe that needs "
                f"LIMIT to be safe is not count-only",
            )

    def test_probes_only_reference_relations_that_exist(self):
        """A probe against a renamed relation would fail at the worst moment."""
        known = self.relations | {
            "auth.users",
            "cron.job",
            "cron.job_run_details",
            "net.http_request_queue",
            "storage.buckets",
            "storage.objects",
            "supabase_migrations.schema_migrations",
        }
        for path, index, stmt in self.each_statement():
            lowered = stmt.lower()
            for match in re.finditer(
                r"\b(?:from|join)\s+(?:lateral\s+)?(?!lateral\b)([a-z_][a-z0-9_.]*)", lowered
            ):
                # `a IS DISTINCT FROM b` is an operator, not a FROM clause.
                preceding = lowered[max(0, match.start() - 12) : match.start()]
                if preceding.rstrip().endswith("distinct"):
                    continue
                name = match.group(1)
                if name.startswith("pg_") or name.startswith("information_schema"):
                    continue
                if "." in name:
                    schema, relation = name.split(".", 1)
                    if schema in ("pg_catalog", "information_schema"):
                        continue
                    if schema == "public":
                        self.assertIn(
                            relation,
                            self.relations,
                            f"{path.name} statement {index} selects FROM unknown "
                            f"public relation {relation!r}",
                        )
                        continue
                    if name in known:
                        continue
                    continue
                if name in self.relations:
                    self.fail(
                        f"{path.name} statement {index} references public relation "
                        f"{name!r} without the required public. qualifier"
                    )
                if name in known:
                    continue
                # CTE names, lateral subqueries and aliases are fine.
                if re.search(rf"\b{re.escape(name)}\s+as\s*\(", lowered):
                    continue
                if name in (
                    "reproduced",
                    "divergent",
                    "per_collection",
                    "per_account",
                    "ordered",
                    "collisions",
                    "d",
                    "unnest",
                    # Table-valued JSON helper used only inside an aggregate
                    # scalar subquery; it is not a source relation.
                    "jsonb_object_keys",
                ):
                    continue
                self.fail(
                    f"{path.name} statement {index} selects FROM unknown "
                    f"relation {name!r}"
                )

    def test_public_relations_are_schema_qualified(self):
        for path, index, stmt in self.each_statement():
            lowered = stmt.lower()
            for match in re.finditer(
                r"\b(?:from|join)\s+(?:lateral\s+)?(?!lateral\b)([a-z_][a-z0-9_.]*)", lowered
            ):
                name = match.group(1)
                if name in self.relations:
                    self.fail(
                        f"{path.name} statement {index} references {name!r} "
                        "without public. qualification"
                    )


class TestProbeCoverage(unittest.TestCase):
    """Every readiness section 10 item is accounted for by a probe or a note."""

    @classmethod
    def setUpClass(cls):
        cls.text = "\n".join(p.read_text() for p in load_probe_files())
        cls.readme = (PROBES_DIR / "README.md").read_text()

    def test_all_nine_section_10_items_are_addressed(self):
        for probe_id in ("P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08"):
            self.assertIn(
                probe_id,
                self.text,
                f"readiness section 10 item for {probe_id} has no probe",
            )
        # Item 9, byte accounting, is not answerable from the source.
        self.assertIn("byte accounting", self.readme.lower())
        self.assertIn("not a source probe", self.readme.lower())

    def test_manifest_probe_references_all_exist(self):
        """Every probe id the manifest blocks a decision on must be defined."""
        manifest_text = (
            MIGRATION_ROOT / "manifest" / "disposition-manifest.json"
        ).read_text()
        referenced = set(re.findall(r"\bP(?:0\d[a-z]?|X-[a-z])\b", manifest_text))
        self.assertTrue(referenced, "manifest references no probes at all")
        missing = sorted(r for r in referenced if r not in self.text)
        self.assertEqual(
            missing,
            [],
            f"the manifest blocks decisions on probes that do not exist: {missing}",
        )

    def test_no_probe_documents_the_false_to_hidden_rule(self):
        """Comments are documentation too, and this one was wrong for a while.

        readiness 8.3 guarded only NULL, so the probe comment said 'NULL must
        never become hidden' while the dispositions mapped false to 'hidden'.
        The binding rule (docs/v2-m3-capability-decision.md) is that false and
        NULL both project to 'unknown'; nothing in this bundle may say
        otherwise, comment or code.
        """
        forbidden = re.compile(
            r"\b(?:false|null)\b\s*(?:->|=>|to|becomes?|maps?\s+to)\s*'?"
            r"(?:hidden|private)\b",
            re.IGNORECASE,
        )
        for path in load_probe_files():
            match = forbidden.search(path.read_text())
            self.assertIsNone(
                match,
                f"{path.name} documents a legacy false/NULL to privacy-state "
                f"projection: {match.group(0) if match else ''!r}",
            )

    def test_p07f_measures_the_visibility_disagreement_it_is_cited_for(self):
        """S-VIS-PRECEDENCE depends on this probe actually existing."""
        self.assertIn("P07f", self.text)
        for expected in (
            "library_visible_differs",
            "playtime_visible_differs",
            "last_played_visible_differs",
            "library_visible_null_mismatch",
            "visit_and_login_differ",
        ):
            self.assertIn(
                expected,
                self.text,
                f"P07f no longer counts {expected}; the precedence recheck "
                f"and the last-login/last-visit distinction lose their evidence",
            )

    def test_readiness_section_4_and_14_conflicts_have_probes(self):
        for marker in (
            "readiness 4.1",
            "readiness 4.2",
            "readiness 4.6",
            "readiness 4.7",
            "readiness 4.8",
            "readiness 4.9",
            "readiness 4.10",
            "readiness 4.11",
            "readiness 4.13",
            "readiness 14.3",
            "readiness 14.4",
            "readiness 14.6",
            "readiness 14.7",
        ):
            self.assertIn(
                marker,
                self.text,
                f"no probe cites {marker}; that conflict stays unmeasured",
            )


class TestNonPublicSchemaDispositions(unittest.TestCase):
    """Every non-`public` schema the inventory lists must have a disposition."""

    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads(
            (
                MIGRATION_ROOT / "manifest" / "non-public-schema-dispositions.json"
            ).read_text()
        )
        cls.inventory = json.loads(INVENTORY.read_text())

    def test_all_ten_non_public_schemas_are_covered(self):
        listed = set(self.inventory["schemas"]) - {"public"}
        decided = set(self.doc["schemas"])
        self.assertEqual(len(listed), 10)
        self.assertEqual(
            listed - decided, set(), "schemas with no assessed disposition"
        )
        self.assertEqual(
            decided - listed, set(), "dispositions for schemas that do not exist"
        )

    def test_every_schema_states_rationale_probe_and_credential_risk(self):
        for name, entry in self.doc["schemas"].items():
            for key in (
                "assessed_role",
                "disposition",
                "rationale",
                "carries_credentials",
                "probe",
                "v2_target",
            ):
                self.assertIn(key, entry, f"{name} is missing {key!r}")
                self.assertNotEqual(entry[key], "", f"{name}.{key} is empty")
            if entry["carries_credentials"]:
                self.assertTrue(
                    entry.get("credential_note"),
                    f"{name} carries credentials but has no credential_note",
                )

    def test_vault_is_excluded_absolutely(self):
        vault = self.doc["schemas"]["vault"]
        self.assertEqual(vault["disposition"], "EXCLUDED-ABSOLUTELY")
        self.assertEqual(vault["v2_target"], "none, deliberately and permanently.")
        self.assertIn("vault", self.doc["summary"]["excluded_absolutely"])

    def test_cron_disposition_forbids_exporting_commands(self):
        cron = self.doc["schemas"]["cron"]
        note = cron["credential_note"].lower()
        self.assertIn("authorization", note)
        self.assertIn("never", note)

    def test_any_archive_states_purpose_and_retention(self):
        for name, entry in self.doc["schemas"].items():
            if not entry.get("archive"):
                continue
            self.assertTrue(
                entry.get("archive_purpose"), f"{name} archive has no purpose"
            )
            self.assertTrue(
                entry.get("archive_retention"), f"{name} archive has no retention"
            )

    def test_summary_accounts_for_every_schema_exactly_once(self):
        buckets = [
            v for k, v in self.doc["summary"].items() if isinstance(v, list)
        ]
        flat = [s for b in buckets for s in b]
        self.assertEqual(
            sorted(flat),
            sorted(self.doc["schemas"]),
            "summary buckets must partition the schema set exactly",
        )
        self.assertEqual(len(flat), self.doc["summary"]["count"])


# The runner must stay at the END of the module. It previously sat above
# TestNonPublicSchemaDispositions, so `python3 .../test_probe_safety.py` ran
# unittest.main() before that class existed and silently skipped its 6 tests
# (16 ran, not 22) while `unittest discover` ran all of them.
if __name__ == "__main__":
    unittest.main(verbosity=2)
