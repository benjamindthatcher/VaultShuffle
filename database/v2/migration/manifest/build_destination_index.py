#!/usr/bin/env python3
"""Index the physical destinations the applied and proposed migrations define.

Why this exists
---------------
Every concrete relation or column reference in a disposition manifest
``target`` or ``archive`` field names a v2 destination. Before this index existed,
a target was just a string: nothing proved that
``catalog.duration_estimates.match_confidence`` was a real column rather than a
plausible-looking name someone typed. A manifest that closes a decision by
pointing at an imaginary column has not closed anything.

This module reads the migration SQL directly -- it is the only artefact that
actually creates the destinations -- and emits a machine-checkable index of
every ``schema.relation`` and its columns. ``build_manifest.py`` embeds the
index, and ``validate_manifest.py`` rejects any target that does not resolve.

Ownership boundary
------------------
The three migration files and ``database/v2/M3-contract.md`` belong to the
physical-database worker. This module only ever READS them, and records their
SHA-256 so a later change is visible as drift rather than being silently
absorbed. It never edits them and never invents a name that is not in the SQL.

Applied state
-------------
All three migrations are now applied and immutable: M1 (``20260906093036``),
M2 (``20260907163356``) and M3 (``20260910232654``). M3 was applied on the
target at 2026-09-10T23:26:54Z, and the local file was RENAMED -- not edited --
from the pre-apply ``20260909214501`` name to the management-assigned version.
Its content hash is unchanged at
``605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a``, which is
what ``sources[].sha256`` records here.

``applied`` therefore means "this destination is created by an applied,
immutable migration file". It is not a claim that the remote schema, security
and rollback verification root still owns has been completed, and it is not
permission to edit any SQL: a new physical gap needs a new, separately
reviewed migration.

Usage
-----
    python3 database/v2/migration/manifest/build_destination_index.py
    python3 database/v2/migration/manifest/build_destination_index.py --check

No database connection. No network. Reads local SQL, writes one JSON file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
V2_ROOT = HERE.parent.parent
MIGRATIONS = V2_ROOT / "supabase" / "migrations"
CONTRACT = V2_ROOT / "M3-contract.md"
OUTPUT = HERE / "physical-destination-index.json"

# (filename, origin label, applied?, applied_at) -- origin order is also
# precedence order. ``applied_at`` is the recorded apply instant for the file,
# copied from the coordinator's apply record, never read from a clock here.
MIGRATION_SOURCES = (
    ("20260906093036_m1_private_foundation.sql", "m1", True, None),
    ("20260907163356_m2_jobs_quota_publish.sql", "m2", True, None),
    (
        "20260910232654_m3_preservation_schema.sql",
        "m3",
        True,
        "2026-09-10T23:26:54Z",
    ),
    # Prepared locally under the 11 September dispatch (batch A step 4) from
    # database/v2/proposals/m3_legacy_preservation_followup.sql. NOT applied to
    # any target: `applied=False` and `applied_at=None` are the truthful state,
    # and root owns the remote apply decision. It defines no new relation; it
    # extends three applied ones, so it appears in `extended_relations` and the
    # columns it adds are resolvable manifest targets while still being
    # reported as unapplied.
    (
        "20260911234500_m3_legacy_preservation_followup.sql",
        "m3-followup",
        False,
        None,
    ),
)

# Words that open a TABLE-level constraint rather than a column definition.
CONSTRAINT_OPENERS = frozenset(
    {
        "primary",
        "unique",
        "check",
        "foreign",
        "constraint",
        "exclude",
        "like",
    }
)

CREATE_TABLE_RE = re.compile(
    r"^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?"
    r"([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(",
    re.IGNORECASE,
)
ALTER_TABLE_RE = re.compile(
    r"^\s*alter\s+table\s+(?:if\s+exists\s+)?"
    r"([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*$",
    re.IGNORECASE,
)
ALTER_TABLE_INLINE_RE = re.compile(
    r"^\s*alter\s+table\s+(?:if\s+exists\s+)?"
    r"([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+(.*)$",
    re.IGNORECASE,
)
ADD_COLUMN_RE = re.compile(
    r"^\s*add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\b",
    re.IGNORECASE,
)
IDENT_RE = re.compile(r"^\s*([a-z_][a-z0-9_]*)\b")


INSERT_RE = re.compile(
    r"^\s*insert\s+into\s+([a-z_]+\.[a-z_]+)\b", re.IGNORECASE
)


class IndexError_(Exception):
    pass


def _split_top_level(text: str, opener: str = "(", closer: str = ")") -> list[str]:
    """Split ``(a, b), (c, d)`` into its top-level parenthesised groups."""
    groups: list[str] = []
    depth = 0
    in_string = False
    start = None
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "'":
            if in_string and text[i + 1 : i + 2] == "'":
                i += 2
                continue
            in_string = not in_string
        elif not in_string:
            if ch == opener:
                if depth == 0:
                    start = i + 1
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0 and start is not None:
                    groups.append(text[start:i])
                    start = None
        i += 1
    return groups


def _split_fields(group: str) -> list[str]:
    """Split one VALUES tuple on top-level commas, honouring '' escapes."""
    fields: list[str] = []
    depth = 0
    in_string = False
    current: list[str] = []
    i = 0
    while i < len(group):
        ch = group[i]
        if ch == "'":
            if in_string and group[i + 1 : i + 2] == "'":
                current.append("''")
                i += 2
                continue
            in_string = not in_string
            current.append(ch)
        elif not in_string and ch in "({[":
            depth += 1
            current.append(ch)
        elif not in_string and ch in ")}]":
            depth -= 1
            current.append(ch)
        elif not in_string and ch == "," and depth == 0:
            fields.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    if current:
        fields.append("".join(current).strip())
    return fields


def _literal(text: str):
    text = text.strip()
    lowered = text.lower()
    if lowered == "null":
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if text.startswith("'"):
        end = text.rfind("'")
        return text[1:end].replace("''", "'")
    try:
        return int(text)
    except ValueError:
        return text


def parse_seed_rows(text: str, relation: str) -> list[tuple]:
    """Return the VALUES tuples of every ``insert into <relation>`` statement.

    Read-only structural parsing of the physical migration, used to carry the
    database worker's retention taxonomy into this index. Nothing is inferred:
    a row that is not literally in the SQL does not appear here.
    """
    rows: list[tuple] = []
    # Comments are stripped first so a `;` or a quote inside a comment cannot
    # terminate the statement early.
    body = "\n".join(_strip_line_comment(line) for line in text.splitlines())
    pattern = re.compile(
        r"insert\s+into\s+" + re.escape(relation) + r"\b", re.IGNORECASE
    )
    for match in pattern.finditer(body):
        # Walk to the statement terminator, honouring string literals. A
        # description such as "bounded revisions; obsolete raw payloads ..."
        # contains a semicolon that is NOT a terminator.
        i = match.end()
        in_string = False
        end = len(body)
        while i < len(body):
            ch = body[i]
            if ch == "'":
                if in_string and body[i + 1 : i + 2] == "'":
                    i += 2
                    continue
                in_string = not in_string
            elif not in_string and ch == ";":
                end = i
                break
            i += 1
        statement = body[match.end() : end]
        lowered = statement.lower()
        marker = re.search(r"\bvalues\b", lowered)
        if not marker:
            continue
        for group in _split_top_level(statement[marker.end() :]):
            rows.append(tuple(_literal(f) for f in _split_fields(group)))
    return rows


def build_retention_registry(text: str) -> dict:
    """Index the physical retention taxonomy the M3 migration seeds.

    ``ops.retention_classes`` fixes the vocabulary and, per plan 13, the only
    scope allowed a post-cutover expiry. ``ops.data_retention_registry`` says
    which relation is in which class, whether it holds personal data, and what
    account deletion and account export do to it. Carrying both here lets the
    manifest validator prove that a lasting private fact is not sole-homed in
    bounded migration staging, instead of asserting it in prose.
    """
    classes: dict[str, dict] = {}
    for row in parse_seed_rows(text, "ops.retention_classes"):
        if len(row) < 5:
            continue
        classes[row[0]] = {
            "scope": row[1],
            "max_days_after_cutover": row[2],
            "personal_data_allowed": row[3],
            "description": row[4],
        }
    relations: dict[str, dict] = {}
    for row in parse_seed_rows(text, "ops.data_retention_registry"):
        if len(row) < 9:
            continue
        uuid_columns = row[5] or "{}"
        if isinstance(uuid_columns, str):
            inner = uuid_columns.strip().lstrip("{").rstrip("}")
            uuid_list = [c for c in (p.strip() for p in inner.split(",")) if c]
        else:
            uuid_list = []
        relations[row[0]] = {
            "introduced_in": row[1],
            "retention_class": row[2],
            "holds_personal_data": row[3],
            "account_fk_column": row[4],
            "account_uuid_columns": uuid_list,
            "deletion_mode": row[6],
            "export_scope": row[7],
            "rationale": row[8],
        }
    return {
        "classes": {name: classes[name] for name in sorted(classes)},
        "relations": {name: relations[name] for name in sorted(relations)},
        "totals": {
            "classes": len(classes),
            "registered_relations": len(relations),
            "personal_data_relations": sum(
                1 for r in relations.values() if r["holds_personal_data"]
            ),
        },
        "description": (
            "Parsed from ops.retention_classes and ops.data_retention_registry "
            "in the M3 migration SQL, which the database worker owns. Read "
            "only; the manifest validator resolves retention claims against it "
            "rather than restating a class in prose."
        ),
    }


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _strip_line_comment(line: str) -> str:
    """Remove a trailing ``--`` comment that is not inside a string literal."""
    out = []
    in_string = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "'":
            # '' inside a literal is an escaped quote, not a close+open.
            in_string = not in_string
        elif not in_string and ch == "-" and line[i + 1 : i + 2] == "-":
            break
        out.append(ch)
        i += 1
    return "".join(out)


def _depth_delta(line: str) -> int:
    """Net paren depth change for a line, ignoring parens in string literals."""
    delta = 0
    in_string = False
    for ch in line:
        if ch == "'":
            in_string = not in_string
        elif not in_string:
            if ch == "(":
                delta += 1
            elif ch == ")":
                delta -= 1
    return delta


def parse_sql(text: str) -> dict[str, list[str]]:
    """Return ``{'schema.relation': [column, ...]}`` for one migration file.

    Handles multi-line ``check`` constraints by tracking paren depth, so a
    continuation line such as ``check (x in ('a', 'b'))`` is never mistaken for
    a column definition. Table-level constraints are skipped by keyword.
    """
    relations: dict[str, list[str]] = {}
    lines = text.splitlines()

    i = 0
    n = len(lines)
    while i < n:
        raw = _strip_line_comment(lines[i])

        create = CREATE_TABLE_RE.match(raw)
        if create:
            name = f"{create.group(1).lower()}.{create.group(2).lower()}"
            columns: list[str] = []
            depth = _depth_delta(raw)
            # A definition line only STARTS a new item when the previous one was
            # terminated by a comma. Without this, a wrapped continuation such as
            # "    references app.collections(...) on delete set null" would be
            # read as a column literally named "references".
            expect_new_item = True
            head_tail = raw.split("(", 1)[1] if "(" in raw else ""
            body_lines = [head_tail] if head_tail.strip() else []
            i += 1
            # depth 1 == directly inside the column list.
            while i < n and depth > 0:
                body = _strip_line_comment(lines[i])
                body_lines.append(body)
                depth += _depth_delta(body)
                i += 1
            # Re-walk the collected body with the comma rule.
            depth = 1
            for body in body_lines:
                stripped = body.strip()
                if depth == 1 and expect_new_item and stripped:
                    ident = IDENT_RE.match(body)
                    if ident and ident.group(1).lower() not in CONSTRAINT_OPENERS:
                        col = ident.group(1).lower()
                        if col not in columns:
                            columns.append(col)
                depth += _depth_delta(body)
                if stripped:
                    # Depth back at the column-list level and item comma-closed.
                    expect_new_item = depth <= 1 and stripped.rstrip().endswith(",")
            if name in relations:
                raise IndexError_(f"relation defined twice in one file: {name}")
            relations[name] = columns
            continue

        # ``alter table x.y`` with the actions on following lines, and the
        # single-line form ``alter table x.y add column z ...``.
        alter = ALTER_TABLE_RE.match(raw)
        inline = None if alter else ALTER_TABLE_INLINE_RE.match(raw)
        if alter or inline:
            if alter:
                name = f"{alter.group(1).lower()}.{alter.group(2).lower()}"
                tail_lines = []
            else:
                name = f"{inline.group(1).lower()}.{inline.group(2).lower()}"
                tail_lines = [inline.group(3)]
            # Consume until the statement terminator.
            depth = sum(_depth_delta(t) for t in tail_lines)
            terminated = any(";" in t for t in tail_lines) and depth <= 0
            i += 1
            while i < n and not terminated:
                body = _strip_line_comment(lines[i])
                tail_lines.append(body)
                depth += _depth_delta(body)
                if ";" in body and depth <= 0:
                    terminated = True
                i += 1
            existing = relations.setdefault(name, [])
            depth = 0
            for t in tail_lines:
                if depth == 0:
                    add = ADD_COLUMN_RE.match(t)
                    if add:
                        col = add.group(1).lower()
                        if col not in existing:
                            existing.append(col)
                depth += _depth_delta(t)
            continue

        i += 1

    return relations


def build(
    migrations_dir: Path = MIGRATIONS,
    contract: Path = CONTRACT,
    sources: tuple = MIGRATION_SOURCES,
) -> dict:
    relations: dict[str, dict] = {}
    source_records = []
    retention_registry: dict = {
        "classes": {},
        "relations": {},
        "totals": {},
        "description": "",
    }

    for filename, origin, applied, applied_at in sources:
        path = migrations_dir / filename
        if not path.exists():
            raise IndexError_(f"migration not found: {path}")
        text = path.read_text()
        if origin == "m3":
            retention_registry = build_retention_registry(text)
        parsed = parse_sql(text)
        for name, columns in parsed.items():
            entry = relations.get(name)
            if entry is None:
                relations[name] = {
                    "origin": origin,
                    "applied": applied,
                    "columns": list(columns),
                    "extended_by": [],
                }
            else:
                added = [c for c in columns if c not in entry["columns"]]
                entry["columns"].extend(added)
                if added and origin not in entry["extended_by"]:
                    entry["extended_by"].append(origin)
                if added and not applied:
                    # The relation itself is applied, but these columns exist
                    # only in a migration that has NOT been applied to any
                    # target. Recording that here is what keeps a manifest
                    # target resolvable WITHOUT claiming the column is live.
                    entry.setdefault("pending_columns", []).extend(added)
                    entry.setdefault("pending_from", [])
                    if origin not in entry["pending_from"]:
                        entry["pending_from"].append(origin)
        source_records.append(
            {
                "file": filename,
                "origin": origin,
                "applied": applied,
                "applied_at": applied_at,
                "sha256": sha256_file(path),
                "relations_defined": sorted(parsed),
            }
        )

    if not contract.exists():
        raise IndexError_(f"physical contract not found: {contract}")

    schemas = sorted({name.split(".", 1)[0] for name in relations})
    proposed = sorted(n for n, r in relations.items() if not r["applied"])
    extended = sorted(n for n, r in relations.items() if r["extended_by"])

    return {
        "index_version": "1",
        "milestone": "M3",
        "generated_by": "database/v2/migration/manifest/build_destination_index.py",
        "generated_note": (
            "GENERATED FILE. Do not hand-edit. Parsed from the migration SQL, "
            "which is owned by the physical-database worker and is only ever "
            "read here. Rerun the builder after that worker changes a migration."
        ),
        "boundary_note": (
            "M1 (20260906093036), M2 (20260907163356) and M3 (20260910232654) "
            "are all applied and immutable; no migration may be edited or "
            "reapplied. M3 was applied at 2026-09-10T23:26:54Z and the local "
            "file was RENAMED, not edited, from the pre-apply 20260909214501 "
            "name, so its content hash is unchanged. 'applied' here means the "
            "destination is created by an applied, immutable migration file. "
            "20260911234500_m3_legacy_preservation_followup.sql is PREPARED "
            "LOCALLY AND NOT APPLIED: its source record carries "
            "'applied': false, and every column it adds to an already-applied "
            "relation is listed in that relation's 'pending_columns' and "
            "summarised under 'pending_columns' at the top level. A pending "
            "column is a resolvable manifest target but is NOT present on the "
            "target database, so no decision may be called closed on the "
            "strength of one until root applies that migration. This index "
            "proves a target name exists in the SQL. It does not certify the "
            "remote schema, security and rollback verification root still "
            "owns, and a newly discovered physical gap needs a new, separately "
            "reviewed migration rather than an edit."
        ),
        "physical_contract": {
            "path": "database/v2/M3-contract.md",
            "sha256": sha256_file(contract),
            "description": (
                "Prose contract owned by the physical-database worker. Recorded "
                "by hash only; destination NAMES come from the SQL, not prose, "
                "so a contract edit cannot silently redefine a target."
            ),
        },
        "sources": source_records,
        "schemas": schemas,
        "totals": {
            "relations": len(relations),
            "applied_relations": sum(1 for r in relations.values() if r["applied"]),
            "proposed_relations": len(proposed),
            "extended_relations": len(extended),
            "columns": sum(len(r["columns"]) for r in relations.values()),
            "pending_columns": sum(
                len(r.get("pending_columns", [])) for r in relations.values()
            ),
        },
        "pending_columns": {
            name: {
                "columns": sorted(entry["pending_columns"]),
                "from": list(entry["pending_from"]),
                "status": "prepared locally, not applied to any target",
            }
            for name, entry in sorted(relations.items())
            if entry.get("pending_columns")
        },
        "proposed_relations": proposed,
        "extended_relations": extended,
        "retention_registry": retention_registry,
        "relations": {name: relations[name] for name in sorted(relations)},
    }


def render(index: dict) -> str:
    return json.dumps(index, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--migrations", type=Path, default=MIGRATIONS)
    ap.add_argument("--contract", type=Path, default=CONTRACT)
    ap.add_argument("--output", type=Path, default=OUTPUT)
    args = ap.parse_args(argv)

    try:
        index = build(args.migrations, args.contract)
    except IndexError_ as exc:
        print(f"INDEX BUILD FAILED\n{exc}", file=sys.stderr)
        return 1

    text = render(index)

    if args.check:
        if not args.output.exists():
            print(f"CHECK FAILED: {args.output} does not exist", file=sys.stderr)
            return 1
        if args.output.read_text() != text:
            print(
                "CHECK FAILED: the physical destination index is STALE. The "
                "migration SQL or the contract changed under it. Rerun without "
                "--check and re-review every affected target.",
                file=sys.stderr,
            )
            return 1
        t = index["totals"]
        print(
            "destination index up to date: %d relations "
            "(%d applied + %d proposed), %d columns"
            % (
                t["relations"],
                t["applied_relations"],
                t["proposed_relations"],
                t["columns"],
            )
        )
        return 0

    args.output.write_text(text)
    t = index["totals"]
    print(
        "wrote %s\n  %d relations (%d applied + %d proposed), %d columns, "
        "%d existing relations extended"
        % (
            args.output,
            t["relations"],
            t["applied_relations"],
            t["proposed_relations"],
            t["columns"],
            t["extended_relations"],
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
