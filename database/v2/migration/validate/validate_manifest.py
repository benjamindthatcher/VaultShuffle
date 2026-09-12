#!/usr/bin/env python3
"""Validate the M3 disposition manifest against live schema metadata.

This is the mechanical drift gate. It reads the manifest and the inventory and
FAILS LOUDLY on any of:

  V1  a relation in the inventory that the manifest does not list
  V2  a relation in the manifest that the inventory does not have
  V3  a column in the inventory that the manifest does not list
  V4  a column in the manifest that the inventory does not have
  V5  a column whose data type differs between manifest and inventory
  V6  a column whose nullability differs between manifest and inventory
  V7  a column with no disposition, an empty disposition, or a disposition
      outside the closed vocabulary
  V8  a view whose columns are not all 'derived-retirement'
  V9  a relation whose recorded constraint set differs from the inventory
  V10 totals that disagree with the relations actually present
  V11 a disposition whose required supporting field is missing
      (target / recoverable_from / archive / blocked_on), or an
      audit-archive relation with no archive purpose and retention
  V12 source identity or relation kind is missing or inconsistent
  V13 strict final-load mode found an unresolved column or relation decision
  V14 a concrete target/archive reference is absent from the SQL-derived
      physical destination index, or that sidecar's hash has drifted
  V15 a capability projection contradicts the binding account-tuple decision:
      a legacy visibility boolean projected to 'hidden'/'private', a mapping
      that is not exactly true->visible / false->unknown / NULL->unknown, a
      tri-state target with no structured projection, a projection with no
      preserved raw evidence, or prose anywhere in the manifest asserting a
      false-or-NULL to 'hidden' rule
  V17 an archive with no structured retention, a retention class whose bound
      does not match the class, personal data bounded by a release cycle or a
      feature's lifetime instead of by the account, an account-keyed archive
      with no stated deletion and export semantics, or an operational archive
      that nevertheless carries an account key
  V18 strict final-load mode found additions, retirements, or migrations that
      exist only in a locally prepared, unapplied physical schema source
  V16 a column parked on a `pending_destination` whose destination has since
      appeared in the SQL index, or a pending record that does not say what
      the column becomes once it does. This is a ratchet: it fails the moment
      the physical gap closes, so a settled semantic decision cannot stay
      "open" merely because nobody re-read the migration.

Rule zero: a MISSING disposition is NEVER defaulted, inferred or filled in. It
is an error. `disposition_for()` raises rather than returning a fallback, and
there is no code path that supplies one.

Separately from drift, `--report` prints the disposition totals and the open
decisions, so a reviewer can see what is still unresolved without reading 300KB
of JSON.

Usage
-----
    python3 database/v2/migration/validate/validate_manifest.py
    python3 database/v2/migration/validate/validate_manifest.py --report
    python3 database/v2/migration/validate/validate_manifest.py --final-load
    python3 database/v2/migration/validate/validate_manifest.py \
        --manifest PATH --inventory PATH      # for tests / fixtures

Exit codes: 0 valid, 1 drift or a manifest defect, 2 a file could not be read.

No database connection. No network. Reads the manifest, inventory and generated
destination index, and writes nothing.
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
DEFAULT_MANIFEST = V2_ROOT / "migration" / "manifest" / "disposition-manifest.json"
DEFAULT_INVENTORY = V2_ROOT / "source-schema-inventory-20260909.json"

VALID_DISPOSITIONS = frozenset(
    {
        "preserved",
        "transformed",
        "derived-retirement",
        "authorized-retirement",
        "audit-archive",
        "unresolved-decision",
    }
)

# Disposition -> the field that must accompany it. A disposition that cannot
# say where the data went, why it is safe to drop, where it is archived, or
# what unblocks it is not a decision.
REQUIRED_SUPPORT = {
    "preserved": "target",
    "transformed": "target",
    "derived-retirement": "recoverable_from",
    "authorized-retirement": "authorized_by",
    "audit-archive": "archive",
    "unresolved-decision": "blocked_on",
}


class ManifestDefect(Exception):
    """Raised when the manifest cannot answer a question it must answer."""


def disposition_for(column: dict, relation_name: str) -> str:
    """Return the column's disposition, or RAISE.

    There is deliberately no default, no `.get(..., fallback)` and no inference
    from any other field. A column without a disposition is a defect, and the
    only correct behaviour is to refuse to proceed.
    """
    if "disposition" not in column:
        raise ManifestDefect(
            f"{relation_name}.{column.get('name', '<unnamed>')}: no 'disposition' key. "
            f"A missing disposition is never defaulted."
        )
    value = column["disposition"]
    if not isinstance(value, str) or not value:
        raise ManifestDefect(
            f"{relation_name}.{column.get('name', '<unnamed>')}: disposition is "
            f"{value!r}; it must be a non-empty string from the closed vocabulary."
        )
    if value not in VALID_DISPOSITIONS:
        raise ManifestDefect(
            f"{relation_name}.{column.get('name', '<unnamed>')}: disposition "
            f"{value!r} is not in the closed vocabulary "
            f"{sorted(VALID_DISPOSITIONS)}."
        )
    return value


EXPECTED_RELATION_KINDS = frozenset({"r", "v"})

# ---------------------------------------------------------------------------
# V15 -- capability projection semantics.
#
# The binding ruling is docs/v2-m3-capability-decision.md: the legacy Steam
# visibility booleans are availability heuristics computed by
# lib/steam-owned-games.ts:117, not provider privacy assertions. A visible
# library nobody has played yields false; an account whose games carry no
# last-played timestamp yields false. Therefore:
#
#     true -> 'visible';  false -> 'unknown';  NULL -> 'unknown'
#
# This gate exists because the same file previously mapped false to 'hidden'
# in all three transforms while the surrounding prose claimed the opposite.
# Coverage validation passed anyway, because nothing checked the VALUE
# semantics. It does now, against the generated manifest, in both modes.
CAPABILITY_PROJECTION_RULE = "legacy-boolean-to-capability"
CAPABILITY_PROJECTION_MAPPING = {
    "true": "visible",
    "false": "unknown",
    "null": "unknown",
}
CAPABILITY_FORBIDDEN_PROJECTIONS = frozenset({"hidden", "private"})
CAPABILITY_EVIDENCE_PRECEDENCE = frozenset(
    {"account_writer", "profile_reader", "manual_review", "unknown"}
)
CAPABILITY_TARGET_COLUMNS = (
    "app.account_capabilities.library_visibility",
    "app.account_capabilities.playtime_visibility",
    "app.account_capabilities.last_played_visibility",
)
# The physical M3 contract keeps the raw tuple in the durable account-domain
# relation. The destination name is resolved by V14 against the SQL index.
CAPABILITY_RAW_EVIDENCE_PREFIX = "app.account_capability_evidence."
# The prose backstop. Matches "false -> 'hidden'", "false->hidden",
# "NULL becomes hidden" and similar, so a decision cannot be reintroduced in
# narrative text after the structured mapping has been made correct.
FORBIDDEN_PROSE_PROJECTION_RE = re.compile(
    r"\b(?:false|null)\b\s*(?:->|=>|to|becomes?|maps?\s+to)\s*'?(?:hidden|private)\b",
    re.IGNORECASE,
)
PROSE_FIELDS_CHECKED = ("transform", "note", "blocked_on", "recoverable_from")


def validate_capability_projections(manifest: dict) -> list[str]:
    """Enforce the account-tuple capability semantics on the built manifest."""
    failures: list[str] = []

    declared = (
        manifest.get("value_semantics", {}).get("capability_projection")
        if isinstance(manifest.get("value_semantics"), dict)
        else None
    )
    if not isinstance(declared, dict):
        failures.append(
            "V15 manifest.value_semantics.capability_projection is missing; the "
            "manifest must state the binding legacy-boolean mapping rather than "
            "leaving it to prose"
        )
    else:
        if declared.get("mapping") != CAPABILITY_PROJECTION_MAPPING:
            failures.append(
                "V15 manifest.value_semantics.capability_projection.mapping is "
                f"{declared.get('mapping')!r}; the binding ruling "
                "(docs/v2-m3-capability-decision.md) is "
                f"{CAPABILITY_PROJECTION_MAPPING!r}"
            )
        if sorted(declared.get("forbidden_projections") or []) != sorted(
            CAPABILITY_FORBIDDEN_PROJECTIONS
        ):
            failures.append(
                "V15 manifest.value_semantics.capability_projection must forbid "
                f"{sorted(CAPABILITY_FORBIDDEN_PROJECTIONS)} as legacy-boolean "
                "projections"
            )

    projected_columns = 0
    for relation in manifest.get("relations", []):
        relation_name = relation.get("name", "<unnamed>")
        for column in relation.get("columns", []):
            context = f"{relation_name}.{column.get('name', '<unnamed>')}"

            # Prose backstop: applies to every column, not only capability ones.
            for field in PROSE_FIELDS_CHECKED:
                text = column.get(field)
                if isinstance(text, str) and FORBIDDEN_PROSE_PROJECTION_RE.search(
                    text
                ):
                    failures.append(
                        f"V15 {context}.{field}: prose projects a legacy false or "
                        f"NULL to a privacy state. A legacy visibility boolean is "
                        f"an availability heuristic, never a provider privacy "
                        f"assertion; false and NULL both mean 'unknown'."
                    )

            target = column.get("target") or ""
            projection = column.get("capability_projection")
            targets_capability = any(t in target for t in CAPABILITY_TARGET_COLUMNS)

            if targets_capability and not isinstance(projection, dict):
                failures.append(
                    f"V15 {context}: targets an app.account_capabilities "
                    f"visibility column with no structured "
                    f"'capability_projection'. The value rule must be "
                    f"machine-checkable, not narrative."
                )
                continue
            if projection is None:
                continue
            if not isinstance(projection, dict):
                failures.append(
                    f"V15 {context}: 'capability_projection' must be an object"
                )
                continue

            projected_columns += 1
            if projection.get("rule") != CAPABILITY_PROJECTION_RULE:
                failures.append(
                    f"V15 {context}: capability_projection.rule must be "
                    f"'{CAPABILITY_PROJECTION_RULE}', got "
                    f"{projection.get('rule')!r}"
                )
            mapping = projection.get("mapping")
            if not isinstance(mapping, dict):
                failures.append(
                    f"V15 {context}: capability_projection.mapping must be an "
                    f"object keyed by 'true', 'false' and 'null'"
                )
            else:
                if set(mapping) != set(CAPABILITY_PROJECTION_MAPPING):
                    failures.append(
                        f"V15 {context}: capability_projection.mapping keys must "
                        f"be exactly {sorted(CAPABILITY_PROJECTION_MAPPING)}, got "
                        f"{sorted(mapping)}"
                    )
                for key, expected in CAPABILITY_PROJECTION_MAPPING.items():
                    actual = mapping.get(key)
                    if actual in CAPABILITY_FORBIDDEN_PROJECTIONS:
                        failures.append(
                            f"V15 {context}: capability_projection maps legacy "
                            f"{key} to {actual!r}. A legacy false means only "
                            f"that no positive hours or last-played value was "
                            f"observed (lib/steam-owned-games.ts:117); it is "
                            f"not evidence that the account is private."
                        )
                    elif actual != expected:
                        failures.append(
                            f"V15 {context}: capability_projection maps legacy "
                            f"{key} to {actual!r}; the account tuple decision "
                            f"requires {expected!r}"
                        )
            feeds = projection.get("feeds_capability")
            if not isinstance(feeds, bool):
                failures.append(
                    f"V15 {context}: capability_projection.feeds_capability must "
                    f"be a boolean"
                )
            elif feeds and not targets_capability:
                failures.append(
                    f"V15 {context}: capability_projection claims to feed the "
                    f"tri-state but names no app.account_capabilities visibility "
                    f"target"
                )
            if projection.get("evidence_precedence") not in (
                CAPABILITY_EVIDENCE_PRECEDENCE
            ):
                failures.append(
                    f"V15 {context}: capability_projection.evidence_precedence "
                    f"{projection.get('evidence_precedence')!r} is not one of "
                    f"{sorted(CAPABILITY_EVIDENCE_PRECEDENCE)}"
                )
            raw_target = projection.get("raw_evidence_target")
            if not isinstance(raw_target, str) or not raw_target.strip():
                failures.append(
                    f"V15 {context}: capability_projection has no "
                    f"'raw_evidence_target'. false and NULL both project to "
                    f"'unknown', so the raw observation must be preserved or the "
                    f"original fact is destroyed."
                )
            elif not raw_target.startswith(CAPABILITY_RAW_EVIDENCE_PREFIX):
                failures.append(
                    f"V15 {context}: capability_projection.raw_evidence_target "
                    f"{raw_target!r} must name a "
                    f"{CAPABILITY_RAW_EVIDENCE_PREFIX} column"
                )
            if not projection.get("authority"):
                failures.append(
                    f"V15 {context}: capability_projection has no 'authority'"
                )

    if not projected_columns:
        failures.append(
            "V15 no column declares a capability projection. The six legacy "
            "steam_*_visible columns must each carry one, or the semantics are "
            "unenforced."
        )
    return failures


# Targets are intentionally free-form prose because one source fact may be
# split across several destinations. This extracts only schema-qualified
# relation or relation.column names; prose such as "no v2 destination exists"
# remains prose and is not mistaken for a destination.
DESTINATION_REFERENCE_RE = re.compile(
    r"(?<![A-Za-z0-9_])(\+?)([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*"
    r"(?:\.[a-z_][a-z0-9_]*)?)\b",
    re.IGNORECASE,
)


def _destination_references(value: object) -> list[tuple[bool, str]]:
    if not isinstance(value, str):
        return []
    return [
        (bool(match.group(1)), match.group(2).lower())
        for match in DESTINATION_REFERENCE_RE.finditer(value)
    ]


def validate_destination_targets(manifest: dict, destination_index: dict) -> list[str]:
    """Resolve every concrete target/archive reference against the SQL index."""
    failures: list[str] = []
    if not isinstance(destination_index, dict):
        return ["V14 physical destination index must be a JSON object"]
    relations = destination_index.get("relations")
    if not isinstance(relations, dict):
        return ["V14 physical destination index has no relations object"]

    def check_value(context: str, field: str, value: object) -> None:
        if value is None:
            return
        if not isinstance(value, str):
            failures.append(
                f"V14 {context}.{field}: destination reference must be text"
            )
            return
        for is_proposed, reference in _destination_references(value):
            parts = reference.split(".")
            relation_name = ".".join(parts[:2])
            relation = relations.get(relation_name)
            if relation is None:
                failures.append(
                    f"V14 {context}.{field}: destination relation "
                    f"'{relation_name}' is absent from the physical SQL index"
                )
                continue
            if not isinstance(relation, dict):
                failures.append(
                    f"V14 {context}.{field}: index entry for destination relation "
                    f"'{relation_name}' is malformed"
                )
                continue
            if len(parts) != 3:
                continue
            column_name = parts[2]
            columns = relation.get("columns", [])
            if not isinstance(columns, list):
                failures.append(
                    f"V14 {context}.{field}: index columns for destination relation "
                    f"'{relation_name}' are malformed"
                )
                continue
            if column_name not in columns:
                failures.append(
                    f"V14 {context}.{field}: destination column "
                    f"'{reference}' is absent from the physical SQL index"
                )
            # Keep the proposal status visible in a failure's context without
            # treating a proposed M3 destination as an applied one. The manifest
            # is a proposal and already records the sidecar's applied/proposed
            # totals; readiness still requires the coordinator's final review.
            _ = is_proposed

    for relation in manifest.get("relations", []):
        relation_name = relation.get("name", "<unnamed>")
        check_value(relation_name, "target", relation.get("target"))
        for column in relation.get("columns", []):
            context = f"{relation_name}.{column.get('name', '<unnamed>')}"
            check_value(context, "target", column.get("target"))
            check_value(context, "archive", column.get("archive"))
            # A raw-evidence destination is a real destination: resolving it
            # against the SQL is what makes "the raw observation is preserved"
            # a checkable claim instead of a promise.
            projection = column.get("capability_projection")
            if isinstance(projection, dict):
                check_value(
                    context,
                    "capability_projection.raw_evidence_target",
                    projection.get("raw_evidence_target"),
                )
    return failures


# ---------------------------------------------------------------------------
# V17 -- retention classes.
#
# Plan 13 gives personal data exactly two bounds: the account's lifetime for
# retained personal facts, and 30 days after validated cutover for migration
# staging and exports. The earlier manifest windows bound personal data to a
# release cycle or to a product feature's lifetime, which is neither.
RETENTION_CLASSES = {
    "durable-private-fact": "while-the-account-exists",
    "bounded-migration-staging": "30-days-after-validated-cutover",
    "operational-provenance": None,
}
UNBOUNDED_PERSONAL_PHRASES = (
    "release cycle",
    "life of the feature",
    "while the feature exists",
    "permanent while",
    "indefinite",
)


def validate_retention(manifest: dict) -> list[str]:
    """Enforce plan 13's retention classes on the built manifest."""
    failures: list[str] = []
    for relation in manifest.get("relations", []):
        name = relation.get("name", "<unnamed>")
        has_archive = any(
            c.get("disposition") == "audit-archive"
            for c in relation.get("columns", [])
        )
        retention = relation.get("retention")
        if has_archive and not isinstance(retention, dict):
            failures.append(
                f"V17 {name}: archives columns but has no structured 'retention'. "
                f"A retention class stated only in prose is not enforceable."
            )
            continue
        if not isinstance(retention, dict):
            continue

        klass = retention.get("class")
        if klass not in RETENTION_CLASSES:
            failures.append(
                f"V17 {name}: retention.class {klass!r} is not one of "
                f"{sorted(RETENTION_CLASSES)}"
            )
            continue
        expected = RETENTION_CLASSES[klass]
        if expected and retention.get("bound") != expected:
            failures.append(
                f"V17 {name}: retention.class '{klass}' requires bound "
                f"{expected!r}, got {retention.get('bound')!r}"
            )
        identity = retention.get("carries_account_identity")
        if not isinstance(identity, bool):
            failures.append(
                f"V17 {name}: retention.carries_account_identity must be a boolean"
            )
            continue
        if klass == "operational-provenance" and identity:
            failures.append(
                f"V17 {name}: retention.class 'operational-provenance' carries an "
                f"account key. Personal data is bounded by the account, not by an "
                f"operational window."
            )
        if klass == "durable-private-fact" and not identity:
            failures.append(
                f"V17 {name}: 'durable-private-fact' with no account identity is a "
                f"contradiction; classify it as 'operational-provenance'"
            )
        if identity:
            for key in ("account_deletion", "account_export"):
                if not retention.get(key):
                    failures.append(
                        f"V17 {name}: retention carries account identity but does "
                        f"not state '{key}' semantics"
                    )
            prose = (relation.get("archive_retention") or "").lower()
            for phrase in UNBOUNDED_PERSONAL_PHRASES:
                if phrase in prose:
                    failures.append(
                        f"V17 {name}: archive_retention bounds personal data by "
                        f"{phrase!r}. Plan 13 allows the account's lifetime or the "
                        f"30-day post-cutover window, and nothing else."
                    )
    return failures


def validate_pending_destinations(
    manifest: dict, destination_index: dict
) -> list[str]:
    """V16 -- a settled decision may not stay open once its column exists.

    Some decisions are blocked only by a destination that has not been created
    yet. Recording that as prose means the closure depends on somebody
    re-reading the migration at the right moment. Recording it as a
    ``pending_destination`` makes it mechanical in BOTH directions:

    * while the destination is absent, the column stays ``unresolved-decision``
      and ``--final-load`` keeps rejecting it -- fail-closed;
    * the moment the destination resolves in the SQL-derived index, leaving the
      column unresolved becomes a validation FAILURE, so the integration cannot
      be quietly forgotten.
    """
    failures: list[str] = []
    relations = destination_index.get("relations")
    if not isinstance(relations, dict):
        return failures

    def resolves(reference: str) -> bool:
        parts = reference.split(".")
        if len(parts) not in (2, 3):
            return False
        relation = relations.get(".".join(parts[:2]))
        if not isinstance(relation, dict):
            return False
        if len(parts) == 2:
            return True
        columns = relation.get("columns", [])
        return isinstance(columns, list) and parts[2] in columns

    for relation in manifest.get("relations", []):
        relation_name = relation.get("name", "<unnamed>")
        for column in relation.get("columns", []):
            pending = column.get("pending_destination")
            if pending is None:
                continue
            context = f"{relation_name}.{column.get('name', '<unnamed>')}"
            if not isinstance(pending, dict):
                failures.append(f"V16 {context}: pending_destination must be an object")
                continue
            target = pending.get("target")
            if not isinstance(target, str) or not target.strip():
                failures.append(
                    f"V16 {context}: pending_destination requires 'target' naming "
                    f"the destination it is waiting for"
                )
                continue
            for key in ("approved_by", "owner", "on_availability", "resulting_target"):
                if not pending.get(key):
                    failures.append(
                        f"V16 {context}: pending_destination requires '{key}'"
                    )
            if column.get("disposition") != "unresolved-decision":
                failures.append(
                    f"V16 {context}: carries a pending_destination but is already "
                    f"'{column.get('disposition')}'; remove the pending record"
                )
                continue
            if resolves(target):
                failures.append(
                    f"V16 {context}: destination '{target}' NOW EXISTS in the "
                    f"SQL-derived index, so this decision is no longer blocked. "
                    f"Close it as '{pending.get('on_availability')}' with target "
                    f"'{pending.get('resulting_target')}' and rebuild; a settled "
                    f"decision must not stay open once its column is real."
                )
    return failures


def load_destination_index_for_manifest(
    manifest: dict, manifest_path: Path
) -> tuple[dict | None, list[str]]:
    """Load and hash-check the generated SQL destination sidecar.

    The sidecar must travel with the generated manifest. A missing sidecar is a
    validation failure rather than an invitation to validate against an
    unrelated index.
    """
    record = manifest.get("physical_destination_index")
    if not isinstance(record, dict):
        return None, [
            "V14 manifest.physical_destination_index must record the generated "
            "SQL destination index"
        ]
    path_text = record.get("path")
    if not isinstance(path_text, str) or not path_text.strip():
        return None, ["V14 physical destination index path is required"]
    candidate = Path(path_text)
    if candidate.is_absolute():
        return None, ["V14 physical destination index path must be relative"]
    path = (manifest_path.parent / candidate).resolve()
    if not path.exists():
        return None, [f"V14 physical destination index is missing: {path}"]
    try:
        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        index = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return None, [f"V14 cannot read physical destination index {path}: {exc}"]
    expected_hash = record.get("sha256")
    if not isinstance(expected_hash, str) or not expected_hash:
        return None, ["V14 physical destination index sha256 is required"]
    if expected_hash != actual_hash:
        return None, [
            "V14 physical destination index hash drift: manifest records "
            f"{expected_hash}, file is {actual_hash}"
        ]
    if not isinstance(index, dict):
        return None, ["V14 physical destination index must be a JSON object"]
    return index, []


def validate(
    manifest: dict,
    inventory: dict,
    *,
    strict_final_load: bool = False,
    destination_index: dict | None = None,
) -> list[str]:
    """Return a list of failure strings. Empty list means valid."""
    failures: list[str] = []

    inventory_entries = inventory.get("public_tables", [])
    inv_relations: dict[str, dict] = {}
    for relation in inventory_entries:
        name = relation.get("name")
        if name in inv_relations:
            failures.append(
                f"V12 duplicate relation in inventory: {name!r}; source identity "
                "cannot be validated against an ambiguous inventory"
            )
            continue
        inv_relations[name] = relation

    # The manifest and inventory are only useful when tied to the same source
    # project. A missing identity is a defect even when the relation/column sets
    # happen to match by accident.
    source_record = manifest.get("source", {})
    if not isinstance(source_record, dict):
        failures.append("V12 manifest.source must be an object with project_ref")
        source_record = {}
    man_ref = source_record.get("project_ref")
    inv_ref = inventory.get("source_project_ref")
    if not isinstance(inv_ref, str) or not inv_ref.strip():
        failures.append("V12 inventory is missing required source_project_ref")
    if not isinstance(man_ref, str) or not man_ref.strip():
        failures.append("V12 manifest.source.project_ref is required")
    elif isinstance(inv_ref, str) and inv_ref.strip() and man_ref != inv_ref:
        failures.append(
            f"V10 source project mismatch: manifest was built for {man_ref!r} "
            f"but the inventory is from {inv_ref!r}."
        )

    # Duplicate column names would otherwise collapse into a dictionary below,
    # making one source column silently disappear from the drift check.
    for relation in inventory_entries:
        relation_name = relation.get("name", "<unnamed>")
        seen_columns: set[str] = set()
        for column in relation.get("columns", []):
            column_name = column.get("name")
            if column_name in seen_columns:
                failures.append(
                    f"V12 duplicate column in inventory: "
                    f"{relation_name}.{column_name}"
                )
            seen_columns.add(column_name)

    man_relations: dict[str, dict] = {}
    for rel in manifest.get("relations", []):
        name = rel.get("name")
        if name in man_relations:
            failures.append(f"V2 duplicate relation in manifest: '{name}'")
            continue
        man_relations[name] = rel

    # V1 / V2 -- relation set drift, both directions.
    for name in sorted(set(inv_relations) - set(man_relations)):
        failures.append(
            f"V1 relation '{name}' exists in the source inventory "
            f"({len(inv_relations[name]['columns'])} columns) but is NOT in the "
            f"manifest. Schema drift or an unlisted relation."
        )
    for name in sorted(set(man_relations) - set(inv_relations)):
        failures.append(
            f"V2 relation '{name}' is in the manifest but NOT in the source "
            f"inventory. It was dropped or renamed at the source."
        )

    for name in sorted(set(inv_relations) & set(man_relations)):
        inv = inv_relations[name]
        man = man_relations[name]

        inv_kind = inv.get("kind")
        man_kind = man.get("kind")
        if inv_kind not in EXPECTED_RELATION_KINDS:
            failures.append(
                f"V12 {name}: inventory relation kind {inv_kind!r} is not one of "
                f"{sorted(EXPECTED_RELATION_KINDS)}"
            )
        if man_kind not in EXPECTED_RELATION_KINDS:
            failures.append(
                f"V12 {name}: manifest relation kind {man_kind!r} is not one of "
                f"{sorted(EXPECTED_RELATION_KINDS)}"
            )
        elif inv_kind in EXPECTED_RELATION_KINDS and man_kind != inv_kind:
            failures.append(
                f"V12 {name}: relation kind changed; manifest recorded "
                f"{man_kind!r}, source inventory records {inv_kind!r}"
            )

        inv_cols = {c["name"]: c for c in inv["columns"]}
        man_cols: dict[str, dict] = {}
        for col in man.get("columns", []):
            cname = col.get("name")
            if cname in man_cols:
                failures.append(f"V4 {name}.{cname}: duplicate column in manifest")
                continue
            man_cols[cname] = col

        # V3 / V4 -- column set drift, both directions.
        for cname in sorted(set(inv_cols) - set(man_cols)):
            c = inv_cols[cname]
            failures.append(
                f"V3 {name}.{cname} ({c['type']}) exists in the source inventory "
                f"but is NOT in the manifest. Every column needs a disposition."
            )
        for cname in sorted(set(man_cols) - set(inv_cols)):
            failures.append(
                f"V4 {name}.{cname} is in the manifest but NOT in the source "
                f"inventory. It was dropped or renamed at the source."
            )

        is_view = inv.get("kind") == "v"

        for cname in sorted(set(inv_cols) & set(man_cols)):
            inv_c = inv_cols[cname]
            man_c = man_cols[cname]

            # V5 -- type drift.
            if man_c.get("type") != inv_c["type"]:
                failures.append(
                    f"V5 {name}.{cname}: TYPE CHANGED. manifest recorded "
                    f"{man_c.get('type')!r}, source now has {inv_c['type']!r}. "
                    f"The disposition was decided against the old type and must "
                    f"be re-reviewed."
                )

            # V6 -- nullability drift.
            if man_c.get("nullable") != inv_c["nullable"]:
                failures.append(
                    f"V6 {name}.{cname}: NULLABILITY CHANGED. manifest recorded "
                    f"nullable={man_c.get('nullable')}, source now has "
                    f"nullable={inv_c['nullable']}."
                )

            # V7 -- disposition present and in vocabulary. Never defaulted.
            try:
                disp = disposition_for(man_c, name)
            except ManifestDefect as exc:
                failures.append(f"V7 {exc}")
                continue

            # V8 -- views are derived, whole stop.
            if is_view and disp != "derived-retirement":
                failures.append(
                    f"V8 {name}.{cname}: '{name}' is a VIEW (kind 'v') so every "
                    f"column must be 'derived-retirement'; found '{disp}'."
                )

            # V11 -- the disposition's supporting field.
            support = REQUIRED_SUPPORT[disp]
            if is_view and disp == "derived-retirement":
                # A view column has no base row to recover, so recoverable_from
                # is not required of it; the note carries the base-fact pointer.
                pass
            elif not man_c.get(support):
                failures.append(
                    f"V11 {name}.{cname}: disposition '{disp}' requires "
                    f"'{support}', which is missing or empty."
                )
            if not man_c.get("note"):
                failures.append(f"V11 {name}.{cname}: 'note' is missing or empty.")

        # V8 (relation level) -- a view must be classed as one.
        if is_view and man.get("disposition_class") != "derived-view":
            failures.append(
                f"V8 {name}: is a VIEW but disposition_class is "
                f"{man.get('disposition_class')!r}, not 'derived-view'."
            )
        if not is_view and man.get("disposition_class") == "derived-view":
            failures.append(
                f"V8 {name}: is a BASE TABLE (kind 'r') but is classed as "
                f"'derived-view'."
            )

        # V11 (relation level) -- an archive needs purpose and retention.
        has_archive_cols = any(
            c.get("disposition") == "audit-archive" for c in man.get("columns", [])
        )
        if has_archive_cols:
            if not man.get("archive_purpose"):
                failures.append(
                    f"V11 {name}: has audit-archive columns but no "
                    f"'archive_purpose'. Any archive needs an explicit purpose."
                )
            if not man.get("archive_retention"):
                failures.append(
                    f"V11 {name}: has audit-archive columns but no "
                    f"'archive_retention'. Any archive needs an explicit retention."
                )

        # V9 -- constraint drift. The section 4 conflicts hang off exact
        # constraint definitions, so a changed constraint invalidates a decision.
        # A view has no constraints; the inventory records null rather than [].
        inv_cons = {
            (c["name"], c["definition"]) for c in (inv.get("constraints") or [])
        }
        man_cons = {
            (c.get("name"), c.get("definition"))
            for c in (man.get("constraints") or [])
        }
        for gone in sorted(inv_cons - man_cons):
            failures.append(
                f"V9 {name}: constraint '{gone[0]}' exists at the source but is "
                f"not recorded in the manifest: {gone[1]}"
            )
        for extra in sorted(man_cons - inv_cons):
            failures.append(
                f"V9 {name}: constraint '{extra[0]}' is recorded in the manifest "
                f"but no longer matches the source: {extra[1]}"
            )

    # V10 -- totals must describe what is actually there.
    totals = manifest.get("totals", {})
    actual_relations = len(man_relations)
    actual_columns = sum(len(r.get("columns", [])) for r in man_relations.values())
    actual_tables = sum(1 for r in man_relations.values() if r.get("kind") == "r")
    actual_views = sum(1 for r in man_relations.values() if r.get("kind") == "v")
    for label, claimed, actual in (
        ("relations", totals.get("relations"), actual_relations),
        ("columns", totals.get("columns"), actual_columns),
        ("base_tables", totals.get("base_tables"), actual_tables),
        ("views", totals.get("views"), actual_views),
    ):
        if claimed != actual:
            failures.append(
                f"V10 totals.{label} claims {claimed} but the manifest actually "
                f"contains {actual}."
            )

    by_disp = totals.get("by_disposition", {})
    recount: dict[str, int] = {}
    for rel in man_relations.values():
        for col in rel.get("columns", []):
            d = col.get("disposition")
            if isinstance(d, str):
                recount[d] = recount.get(d, 0) + 1
    for disp in sorted(VALID_DISPOSITIONS):
        if by_disp.get(disp, 0) != recount.get(disp, 0):
            failures.append(
                f"V10 totals.by_disposition['{disp}'] claims "
                f"{by_disp.get(disp, 0)} but the manifest contains "
                f"{recount.get(disp, 0)}."
            )

    if strict_final_load:
        unresolved_columns = [
            f"{relation['name']}.{column['name']}"
            for relation in man_relations.values()
            for column in relation.get("columns", [])
            if column.get("disposition") == "unresolved-decision"
        ]
        unresolved_relations = [
            relation["name"]
            for relation in man_relations.values()
            if relation.get("open_decisions")
        ]
        if unresolved_columns or unresolved_relations:
            failures.append(
                "V13 strict final-load rejects unresolved decisions: "
                f"{len(unresolved_columns)} unresolved columns and "
                f"{len(unresolved_relations)} relations with open decisions"
            )

    if destination_index is not None:
        failures.extend(validate_destination_targets(manifest, destination_index))
        failures.extend(validate_pending_destinations(manifest, destination_index))
        if strict_final_load:
            pending_columns = destination_index.get("pending_columns", {})
            pending_drops = destination_index.get("pending_dropped_columns", {})
            unapplied_sources = [
                source.get("origin", "unknown")
                for source in destination_index.get("sources", [])
                if isinstance(source, dict) and source.get("applied") is False
            ]
            if (
                isinstance(pending_columns, dict)
                and isinstance(pending_drops, dict)
                and (pending_columns or pending_drops or unapplied_sources)
            ):
                pending_add_count = sum(
                    len(entry.get("columns", []))
                    for entry in pending_columns.values()
                    if isinstance(entry, dict) and isinstance(entry.get("columns", []), list)
                )
                pending_drop_count = sum(
                    len(entry.get("columns", []))
                    for entry in pending_drops.values()
                    if isinstance(entry, dict) and isinstance(entry.get("columns", []), list)
                )
                failures.append(
                    "V18 strict final-load rejects locally prepared, unapplied "
                    f"schema: {pending_add_count} pending additions, "
                    f"{pending_drop_count} pending drops, "
                    f"{len(unapplied_sources)} unapplied migrations "
                    f"({', '.join(unapplied_sources)})"
                )

    # V15 runs in BOTH modes. The semantics gate is not a final-load nicety:
    # a coverage pass that blessed the opposite rule is exactly what happened
    # before this check existed.
    failures.extend(validate_capability_projections(manifest))
    failures.extend(validate_retention(manifest))

    return failures


def report(manifest: dict) -> None:
    totals = manifest["totals"]
    print("M3 source-disposition manifest (coverage mode)")
    print(f"  status        {manifest.get('status')}")
    print(f"  source        {manifest['source'].get('project_ref')}")
    print(f"  captured_at   {manifest['source'].get('captured_at')}")
    print(
        f"  coverage      {totals['relations']} relations "
        f"({totals['base_tables']} tables + {totals['views']} views), "
        f"{totals['columns']} columns"
    )
    print("  dispositions")
    for k, v in totals["by_disposition"].items():
        pct = 100.0 * v / totals["columns"] if totals["columns"] else 0.0
        print(f"    {k:<22} {v:>4}  {pct:5.1f}%")

    unresolved = [
        (r["name"], c["name"], c.get("blocked_on", ""))
        for r in manifest["relations"]
        for c in r["columns"]
        if c.get("disposition") == "unresolved-decision"
    ]
    print(f"\n  {len(unresolved)} unresolved columns across "
          f"{len({u[0] for u in unresolved})} relations")

    decisions: dict[str, list[str]] = {}
    for rel in manifest["relations"]:
        for d in rel.get("open_decisions", []):
            key = d.split(":")[0].strip() if ":" in d[:16] else rel["name"]
            decisions.setdefault(key, []).append(rel["name"])
    print(f"  {sum(len(v) for v in decisions.values())} relation-level open "
          f"decisions recorded")

    print("\n  archives (each needs purpose + retention):")
    for rel in manifest["relations"]:
        if rel.get("archive_purpose"):
            print(f"    {rel['name']:<32} {rel.get('archive_retention', '')[:70]}")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    ap.add_argument("--report", action="store_true", help="print a summary too")
    ap.add_argument(
        "--final-load",
        "--strict-final-load",
        dest="strict_final_load",
        action="store_true",
        help="reject unresolved columns and relation-level open decisions",
    )
    ap.add_argument(
        "--quiet", action="store_true", help="print nothing on success"
    )
    ap.add_argument(
        "--destination-index",
        type=Path,
        default=None,
        help="override the generated SQL destination index sidecar",
    )
    args = ap.parse_args(argv)

    try:
        manifest = json.loads(args.manifest.read_text())
    except OSError as exc:
        print(f"cannot read manifest: {exc}", file=sys.stderr)
        return 2
    try:
        inventory = json.loads(args.inventory.read_text())
    except OSError as exc:
        print(f"cannot read inventory: {exc}", file=sys.stderr)
        return 2

    if args.destination_index is None:
        destination_index, destination_failures = load_destination_index_for_manifest(
            manifest, args.manifest
        )
    else:
        try:
            destination_index = json.loads(args.destination_index.read_text())
            destination_failures = []
        except (OSError, json.JSONDecodeError) as exc:
            destination_index = None
            destination_failures = [
                f"V14 cannot read physical destination index "
                f"{args.destination_index}: {exc}"
            ]

    failures = validate(
        manifest,
        inventory,
        strict_final_load=args.strict_final_load,
        destination_index=destination_index,
    )
    failures.extend(destination_failures)

    if failures:
        print(
            f"MANIFEST VALIDATION FAILED: {len(failures)} problem(s)",
            file=sys.stderr,
        )
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    if args.report:
        report(manifest)
    elif not args.quiet and args.strict_final_load:
        t = manifest["totals"]
        print(
            f"manifest valid for final load: {t['relations']} relations / "
            f"{t['columns']} columns, no unresolved decisions"
        )
    elif not args.quiet:
        t = manifest["totals"]
        print(
            f"manifest valid for coverage: {t['relations']} relations / "
            f"{t['columns']} columns; unresolved decisions remain review blockers"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
