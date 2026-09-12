#!/usr/bin/env python3
"""Generate the M3 source-disposition manifest from live schema metadata.

The manifest is GENERATED, never hand-typed. Every relation and every column in
``database/v2/source-schema-inventory-20260909.json`` is enumerated from the
inventory itself, so a column cannot be missing from the manifest: it can only be
missing a *decision*, and a missing decision is a hard build failure.

Inputs
------
1. ``database/v2/source-schema-inventory-20260909.json`` -- live ``public`` schema
   metadata captured 9 September 2026 (44 relations / 486 columns). Read-only.
2. ``database/v2/migration/manifest/dispositions/*.json`` -- the hand-authored
   decisions, split by domain so each file is independently reviewable. Each file
   supplies relation-level context and one decision per column.

Output
------
``database/v2/migration/manifest/disposition-manifest.json``
The output binds to the generated ``physical-destination-index.json`` sidecar;
the validator resolves concrete target/archive references against that index.

Rules enforced at build time
----------------------------
* Exactly one disposition per column, drawn from the closed vocabulary.
* A column present in the inventory with no decision entry is a build ERROR.
  There is no default disposition and no table-level fallback: a relation-level
  summary is narrative only and never satisfies column coverage.
* A decision entry naming a relation or column that does not exist in the
  inventory is a build ERROR (stale decision / drift in the other direction).
* Duplicate relation entries across decision files are a build ERROR.
* Views must be dispositioned ``derived-retirement`` on every column.
* ``unresolved-decision`` columns must carry a ``blocked_on`` reference so an open
  question cannot hide behind prose.
* The source project identity and relation kinds must be present in the inventory;
  duplicate relation/column entries are errors rather than dictionary drift.

Determinism
-----------
The output contains no wall-clock timestamp. It records the SHA-256 of the
inventory and of each decision file instead, so regenerating an unchanged tree
produces a byte-identical manifest and ``--check`` can prove the committed
manifest matches its sources.

Usage
-----
    python3 database/v2/migration/manifest/build_manifest.py            # write
    python3 database/v2/migration/manifest/build_manifest.py --check    # verify

No database connection. No network. Reads two local files and writes one.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
V2_ROOT = HERE.parent.parent
INVENTORY = V2_ROOT / "source-schema-inventory-20260909.json"
DECISIONS_DIR = HERE / "dispositions"
OUTPUT = HERE / "disposition-manifest.json"
DESTINATION_INDEX = HERE / "physical-destination-index.json"

# The closed vocabulary. Any other value is a build error.
DISPOSITIONS = (
    # Fact survives into the v2 runtime model with its meaning and value intact.
    # A column rename or an identity renumber alone does not make it transformed;
    # a change of unit, domain, precision or semantics does.
    "preserved",
    # Fact survives but is changed on the way: unit conversion, value-domain
    # remap, rounding, normalisation, or split across more than one target column.
    "transformed",
    # Not carried, because it is recomputable from facts that are carried, or the
    # target model derives it independently. Retirement is a claim that nothing is
    # lost; it must name what makes the value recoverable.
    "derived-retirement",
    # Explicit product decision to discard an obsolete authored fact. Unlike a
    # derived retirement, the exact value is intentionally unrecoverable.
    "authorized-retirement",
    # Not carried into the runtime model. Retained only in a bounded migration
    # archive for audit or reconciliation. Requires an archive purpose and a
    # retention on the relation entry.
    "audit-archive",
    # No disposition has been agreed. Requires ``blocked_on``.
    "unresolved-decision",
)

REQUIRED_RELATION_KEYS = ("role", "summary", "disposition_class")

# ---------------------------------------------------------------------------
# Capability projection semantics (docs/v2-m3-capability-decision.md).
#
# A legacy Steam visibility boolean is an AVAILABILITY HEURISTIC, not a provider
# privacy assertion: lib/steam-owned-games.ts:117 derives playtimeVisible from
# some(hours_played > 0) and lastPlayedVisible from some(last_played_at), and
# libraryVisible from games.length > 0. A visible library that has never been
# played therefore yields false. Projecting false to 'hidden' manufactures a
# privacy claim the source never made, so the binding mapping is:
#
#     true -> 'visible';  false -> 'unknown';  NULL -> 'unknown'
#
# 'hidden' stays a legal app.account_capabilities value (M1:146-153) but may
# only be reached from independent validated privacy evidence, which this
# source does not carry. This constant is the machine-checkable form of that
# ruling; validate_manifest.py enforces it against the GENERATED manifest so a
# coverage pass cannot bless the opposite rule.
# ---------------------------------------------------------------------------
# Retention classes (plan 13, coordinator ruling 12).
#
# Two rows of plan 13 govern everything this manifest archives:
#
#   "Account/authored state/retired personal facts | retained while account
#    exists; account deletion removes private derivatives too"
#   "Migration staging/exports | purge within 30 days of validated cutover"
#
# The earlier windows -- "M3 signoff plus one release cycle", "permanent while
# the purge feature exists", "life of the merge feature" -- bound PERSONAL data
# to a release cycle or a product feature. A private fact is bounded by the
# account it belongs to, or it is migration staging and is bounded by the
# 30-day cutover window. There is no third option for personal data.
#
# ``None`` as the expected bound means the class chooses its own wording.
RETENTION_CLASSES = {
    "durable-private-fact": "while-the-account-exists",
    "bounded-migration-staging": "30-days-after-validated-cutover",
    "operational-provenance": None,
}
# Phrases that bound personal data to something other than the person.
UNBOUNDED_PERSONAL_PHRASES = (
    "release cycle",
    "life of the feature",
    "while the feature exists",
    "permanent while",
    "indefinite",
)

CAPABILITY_PROJECTION_RULE = "legacy-boolean-to-capability"
CAPABILITY_PROJECTION_MAPPING = {
    "true": "visible",
    "false": "unknown",
    "null": "unknown",
}
# Values a legacy boolean may never be projected to, however the rule is worded.
CAPABILITY_FORBIDDEN_PROJECTIONS = frozenset({"hidden", "private"})
CAPABILITY_EVIDENCE_PRECEDENCE = frozenset(
    {"account_writer", "profile_reader", "manual_review", "unknown"}
)
# Destination columns that hold the projected tri-state. Any column targeting
# one of these must carry the structured projection above.
CAPABILITY_TARGET_COLUMNS = (
    "app.account_capabilities.library_visibility",
    "app.account_capabilities.playtime_visibility",
    "app.account_capabilities.last_played_visibility",
)
# Relation-level ``disposition_class`` is narrative grouping for reviewers.
RELATION_CLASSES = (
    "migrated",           # at least some columns reach the v2 runtime model
    "archive-only",       # nothing reaches the runtime model; archive or retire
    "derived-view",       # a view; never migrated, rebuilt from base relations
    "unresolved",         # the relation's own destination is undecided
)
EXPECTED_RELATION_KINDS = frozenset({"r", "v"})


class BuildError(Exception):
    pass


def check_retention(relation: str, entry: dict, out_columns: list[dict]) -> list[str]:
    """Validate a relation's structured retention record at build time."""
    errors: list[str] = []
    has_archive = any(c.get("disposition") == "audit-archive" for c in out_columns)
    retention = entry.get("retention")
    if has_archive and retention is None:
        errors.append(
            f"{relation}: archives columns but has no structured 'retention'. "
            f"A retention class in prose is not a decision."
        )
        return errors
    if retention is None:
        return errors
    if not isinstance(retention, dict):
        errors.append(f"{relation}: 'retention' must be an object")
        return errors

    klass = retention.get("class")
    if klass not in RETENTION_CLASSES:
        errors.append(
            f"{relation}: retention.class {klass!r} is not one of "
            f"{sorted(RETENTION_CLASSES)}"
        )
        return errors
    expected_bound = RETENTION_CLASSES[klass]
    if expected_bound and retention.get("bound") != expected_bound:
        errors.append(
            f"{relation}: retention.class '{klass}' requires bound "
            f"{expected_bound!r}, got {retention.get('bound')!r}"
        )
    if not retention.get("bound"):
        errors.append(f"{relation}: retention requires a 'bound'")
    if not retention.get("destination"):
        errors.append(f"{relation}: retention requires a 'destination'")
    if not retention.get("authority"):
        errors.append(f"{relation}: retention requires an 'authority'")

    identity = retention.get("carries_account_identity")
    if not isinstance(identity, bool):
        errors.append(
            f"{relation}: retention.carries_account_identity must be a boolean"
        )
        identity = None

    if klass == "durable-private-fact" and identity is False:
        errors.append(
            f"{relation}: retention.class 'durable-private-fact' with no account "
            f"identity is a contradiction; use 'operational-provenance'"
        )
    if klass == "operational-provenance":
        if identity:
            errors.append(
                f"{relation}: retention.class 'operational-provenance' carries "
                f"account identity; personal data is bounded by the account, not "
                f"by an operational window"
            )
        if not retention.get("review"):
            errors.append(
                f"{relation}: 'operational-provenance' requires 'review' naming "
                f"the milestone at which the window is re-examined"
            )
    if identity:
        for key in ("account_deletion", "account_export"):
            if not retention.get(key):
                errors.append(
                    f"{relation}: retention carries account identity, so "
                    f"'{key}' semantics are required"
                )
        prose = entry.get("archive_retention") or ""
        for phrase in UNBOUNDED_PERSONAL_PHRASES:
            if phrase in prose.lower():
                errors.append(
                    f"{relation}: archive_retention says {phrase!r} for personal "
                    f"data. A private fact is bounded by the account or by the "
                    f"30-day cutover window, never by a release cycle or the "
                    f"life of a feature."
                )
    divergence = retention.get("physical_default_divergence")
    if divergence is not None:
        if not isinstance(divergence, dict):
            errors.append(
                f"{relation}: retention.physical_default_divergence must be an "
                f"object"
            )
        else:
            for key in (
                "sql_retention_class_default",
                "expected_class",
                "owner",
                "status",
            ):
                if not divergence.get(key):
                    errors.append(
                        f"{relation}: physical_default_divergence requires "
                        f"'{key}'"
                    )
    return errors


def check_capability_projection(
    relation: str, column: str, decision: dict
) -> list[str]:
    """Validate a column's structured capability projection at build time.

    Returns a list of error strings. Two directions are checked:

    * a column whose ``target`` names one of the projected tri-state columns
      MUST carry a structured projection -- prose alone cannot decide it;
    * a structured projection, wherever it appears, must match the binding
      account-tuple mapping exactly and must never project to 'hidden'.
    """
    errors: list[str] = []
    target = decision.get("target") or ""
    projection = decision.get("capability_projection")
    targets_capability = any(t in target for t in CAPABILITY_TARGET_COLUMNS)

    if targets_capability and not isinstance(projection, dict):
        errors.append(
            f"{relation}.{column}: targets an app.account_capabilities "
            f"visibility column, so it requires a structured "
            f"'capability_projection'; prose is not a decision"
        )
        return errors
    if projection is None:
        return errors
    if not isinstance(projection, dict):
        errors.append(
            f"{relation}.{column}: 'capability_projection' must be an object"
        )
        return errors

    if projection.get("rule") != CAPABILITY_PROJECTION_RULE:
        errors.append(
            f"{relation}.{column}: capability_projection.rule must be "
            f"'{CAPABILITY_PROJECTION_RULE}', got {projection.get('rule')!r}"
        )
    mapping = projection.get("mapping")
    if not isinstance(mapping, dict):
        errors.append(
            f"{relation}.{column}: capability_projection.mapping must be an "
            f"object keyed by 'true', 'false' and 'null'"
        )
    else:
        if set(mapping) != set(CAPABILITY_PROJECTION_MAPPING):
            errors.append(
                f"{relation}.{column}: capability_projection.mapping keys must "
                f"be exactly {sorted(CAPABILITY_PROJECTION_MAPPING)}, got "
                f"{sorted(mapping)}; every legacy boolean state needs a decision"
            )
        for key, expected in CAPABILITY_PROJECTION_MAPPING.items():
            actual = mapping.get(key)
            if actual in CAPABILITY_FORBIDDEN_PROJECTIONS:
                errors.append(
                    f"{relation}.{column}: capability_projection maps legacy "
                    f"{key} to {actual!r}. A legacy visibility boolean is an "
                    f"availability heuristic (lib/steam-owned-games.ts:117), "
                    f"not a provider privacy assertion; it may never assert a "
                    f"privacy state the source never made."
                )
            elif actual != expected:
                errors.append(
                    f"{relation}.{column}: capability_projection maps legacy "
                    f"{key} to {actual!r}; the account tuple decision "
                    f"(docs/v2-m3-capability-decision.md) requires {expected!r}"
                )
    if not isinstance(projection.get("feeds_capability"), bool):
        errors.append(
            f"{relation}.{column}: capability_projection.feeds_capability must "
            f"be a boolean saying whether this side writes the tri-state"
        )
    elif projection["feeds_capability"] and not targets_capability:
        errors.append(
            f"{relation}.{column}: capability_projection claims it feeds the "
            f"tri-state but its target names no app.account_capabilities "
            f"visibility column"
        )
    precedence = projection.get("evidence_precedence")
    if precedence not in CAPABILITY_EVIDENCE_PRECEDENCE:
        errors.append(
            f"{relation}.{column}: capability_projection.evidence_precedence "
            f"{precedence!r} is not one of "
            f"{sorted(CAPABILITY_EVIDENCE_PRECEDENCE)}"
        )
    raw_target = projection.get("raw_evidence_target")
    if not isinstance(raw_target, str) or not raw_target.strip():
        errors.append(
            f"{relation}.{column}: capability_projection requires "
            f"'raw_evidence_target'. The projection is lossy -- false and NULL "
            f"both become 'unknown' -- so the raw observation must be preserved."
        )
    if not projection.get("authority"):
        errors.append(
            f"{relation}.{column}: capability_projection requires 'authority' "
            f"naming the ruling it implements"
        )
    return errors


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_destination_index(path: Path = DESTINATION_INDEX) -> dict:
    """Load the SQL-derived destination index used by the generated manifest."""
    if not path.exists():
        raise BuildError(f"physical destination index not found: {path}")
    try:
        index = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise BuildError(f"cannot read physical destination index {path}: {exc}")
    if not isinstance(index, dict) or not isinstance(index.get("relations"), dict):
        raise BuildError(
            f"physical destination index {path} must contain a relations object"
        )
    return index


def load_inventory(path: Path = INVENTORY) -> dict:
    if not path.exists():
        raise BuildError(f"inventory not found: {path}")
    return json.loads(path.read_text())


def load_decisions(directory: Path = DECISIONS_DIR) -> tuple[dict, list[dict]]:
    if not directory.is_dir():
        raise BuildError(f"decisions directory not found: {directory}")
    files = sorted(directory.glob("*.json"))
    if not files:
        raise BuildError(f"no decision files in {directory}")
    merged: dict[str, dict] = {}
    provenance: list[dict] = []
    for path in files:
        doc = json.loads(path.read_text())
        relations = doc.get("relations")
        if not isinstance(relations, dict):
            raise BuildError(f"{path.name}: top-level 'relations' object required")
        for name, entry in relations.items():
            if name in merged:
                raise BuildError(
                    f"{path.name}: relation '{name}' already decided in "
                    f"'{merged[name]['_source_file']}'"
                )
            entry = dict(entry)
            entry["_source_file"] = path.name
            merged[name] = entry
        provenance.append(
            {
                "file": path.name,
                "sha256": sha256_file(path),
                "relations": sorted(relations.keys()),
            }
        )
    return merged, provenance


def build(
    inventory: dict,
    decisions: dict,
    provenance: list[dict],
    inventory_path: Path = INVENTORY,
    destination_index: dict | None = None,
) -> dict:
    errors: list[str] = []

    if destination_index is None:
        destination_index = load_destination_index()

    source_ref = inventory.get("source_project_ref")
    if not isinstance(source_ref, str) or not source_ref.strip():
        errors.append("inventory: source_project_ref is required")

    inv_relations: dict[str, dict] = {}
    for relation in inventory.get("public_tables", []):
        name = relation.get("name")
        if name in inv_relations:
            errors.append(f"inventory: duplicate relation '{name}'")
            continue
        kind = relation.get("kind")
        if kind not in EXPECTED_RELATION_KINDS:
            errors.append(
                f"{name}: inventory kind {kind!r} not in "
                f"{sorted(EXPECTED_RELATION_KINDS)}"
            )
        seen_columns: set[str] = set()
        for column in relation.get("columns", []):
            column_name = column.get("name")
            if column_name in seen_columns:
                errors.append(f"{name}: inventory duplicate column '{column_name}'")
            seen_columns.add(column_name)
        inv_relations[name] = relation

    # Drift in the decision direction: a decided relation that no longer exists.
    for name in sorted(decisions):
        if name not in inv_relations:
            errors.append(
                f"relation '{name}' has decisions but is absent from the inventory "
                f"(stale decision in {decisions[name]['_source_file']})"
            )

    out_relations = []
    totals = {d: 0 for d in DISPOSITIONS}
    column_total = 0

    for name in sorted(inv_relations):
        inv = inv_relations[name]
        entry = decisions.get(name)
        if entry is None:
            errors.append(
                f"relation '{name}' ({len(inv['columns'])} columns) has NO decision "
                f"entry; every relation needs one"
            )
            continue

        for key in REQUIRED_RELATION_KEYS:
            if not entry.get(key):
                errors.append(f"{name}: relation key '{key}' is required")
        klass = entry.get("disposition_class")
        if klass not in RELATION_CLASSES:
            errors.append(
                f"{name}: disposition_class '{klass}' not in {RELATION_CLASSES}"
            )
        if inv["kind"] == "v" and klass != "derived-view":
            errors.append(f"{name}: a view must use disposition_class 'derived-view'")
        entry_kind = entry.get("kind")
        if entry_kind is not None and entry_kind not in EXPECTED_RELATION_KINDS:
            errors.append(
                f"{name}: decision kind {entry_kind!r} is not one of "
                f"{sorted(EXPECTED_RELATION_KINDS)}"
            )
        elif entry_kind is not None and entry_kind != inv["kind"]:
            errors.append(
                f"{name}: decision kind {entry_kind!r} disagrees with inventory "
                f"kind {inv['kind']!r}"
            )

        col_decisions = entry.get("columns")
        if not isinstance(col_decisions, dict):
            errors.append(f"{name}: 'columns' object required")
            col_decisions = {}

        inv_col_names = {c["name"] for c in inv["columns"]}
        for extra in sorted(set(col_decisions) - inv_col_names):
            errors.append(
                f"{name}.{extra}: decided but absent from the inventory "
                f"(stale decision or renamed column)"
            )

        out_columns = []
        rel_counts = {d: 0 for d in DISPOSITIONS}

        for col in inv["columns"]:
            column_total += 1
            cname = col["name"]
            decision = col_decisions.get(cname)
            if decision is None:
                # NEVER defaulted. This is the whole point of generating.
                errors.append(
                    f"{name}.{cname} ({col['type']}): no disposition. Add an entry to "
                    f"{entry['_source_file']}; there is no default."
                )
                continue
            if isinstance(decision, str):
                errors.append(
                    f"{name}.{cname}: decision must be an object with 'disposition', "
                    f"got a bare string"
                )
                continue

            disp = decision.get("disposition")
            if disp not in DISPOSITIONS:
                errors.append(
                    f"{name}.{cname}: disposition '{disp}' not in {DISPOSITIONS}"
                )
                continue

            if inv["kind"] == "v" and disp != "derived-retirement":
                errors.append(
                    f"{name}.{cname}: view columns must be 'derived-retirement', "
                    f"got '{disp}'"
                )

            note = decision.get("note")
            if not note:
                errors.append(f"{name}.{cname}: 'note' is required")

            if disp == "unresolved-decision" and not decision.get("blocked_on"):
                errors.append(
                    f"{name}.{cname}: unresolved-decision requires 'blocked_on' "
                    f"naming the probe or coordinator question that unblocks it"
                )
            if disp in ("preserved", "transformed") and not decision.get("target"):
                errors.append(
                    f"{name}.{cname}: '{disp}' requires 'target' naming the v2 "
                    f"destination (or the proposed M3 relation.column)"
                )
            if disp == "derived-retirement" and inv["kind"] == "r" and not decision.get(
                "recoverable_from"
            ):
                errors.append(
                    f"{name}.{cname}: derived-retirement requires 'recoverable_from' "
                    f"stating what makes the value recoverable"
                )
            if disp == "authorized-retirement" and not decision.get("authorized_by"):
                errors.append(
                    f"{name}.{cname}: authorized-retirement requires 'authorized_by' "
                    f"naming the explicit product decision"
                )
            if disp == "audit-archive" and not decision.get("archive"):
                errors.append(
                    f"{name}.{cname}: audit-archive requires 'archive' naming the "
                    f"bounded archive relation"
                )

            errors.extend(check_capability_projection(name, cname, decision))

            pending = decision.get("pending_destination")
            if pending is not None:
                if not isinstance(pending, dict):
                    errors.append(
                        f"{name}.{cname}: 'pending_destination' must be an object"
                    )
                else:
                    for key in (
                        "target",
                        "approved_by",
                        "owner",
                        "on_availability",
                        "resulting_target",
                    ):
                        if not pending.get(key):
                            errors.append(
                                f"{name}.{cname}: pending_destination requires "
                                f"'{key}'"
                            )
                    if pending.get("on_availability") not in DISPOSITIONS:
                        errors.append(
                            f"{name}.{cname}: pending_destination."
                            f"on_availability "
                            f"{pending.get('on_availability')!r} is not in "
                            f"{DISPOSITIONS}"
                        )
                    if disp != "unresolved-decision":
                        errors.append(
                            f"{name}.{cname}: pending_destination is only "
                            f"meaningful while the column is still "
                            f"'unresolved-decision'; this column is '{disp}', "
                            f"so remove the pending record"
                        )

            rel_counts[disp] = rel_counts.get(disp, 0) + 1
            totals[disp] = totals.get(disp, 0) + 1

            out_col = {
                "ordinal": col["ordinal"],
                "name": cname,
                "type": col["type"],
                "nullable": col["nullable"],
                "disposition": disp,
                "note": note,
            }
            for optional in (
                "target",
                "transform",
                "recoverable_from",
                "authorized_by",
                "archive",
                "blocked_on",
                "conflict",
                "evidence",
                # The machine-checkable half of a value-semantics decision.
                # Emitted so the validator gates the GENERATED manifest, not
                # just the hand-authored source.
                "capability_projection",
                "decision_ref",
                "settled_by",
                "snapshot_checks",
                # A decision whose SEMANTICS are settled but whose destination
                # does not physically exist yet. Validator V16 turns this into
                # a ratchet: once the destination resolves, leaving the column
                # unresolved is a failure.
                "pending_destination",
            ):
                if decision.get(optional):
                    out_col[optional] = decision[optional]
            out_columns.append(out_col)

        if entry.get("archive_purpose") or entry.get("archive_retention"):
            if not (entry.get("archive_purpose") and entry.get("archive_retention")):
                errors.append(
                    f"{name}: an archive needs BOTH 'archive_purpose' and "
                    f"'archive_retention'"
                )
        if any(
            c.get("disposition") == "audit-archive" for c in out_columns
        ) and not entry.get("archive_purpose"):
            errors.append(
                f"{name}: has audit-archive columns but no 'archive_purpose' / "
                f"'archive_retention' on the relation"
            )
        errors.extend(check_retention(name, entry, out_columns))

        out_relations.append(
            {
                "name": name,
                "kind": inv["kind"],
                "rls": inv["rls"],
                "role": entry.get("role"),
                "summary": entry.get("summary"),
                "disposition_class": klass,
                "target": entry.get("target"),
                "archive_purpose": entry.get("archive_purpose"),
                "archive_retention": entry.get("archive_retention"),
                "retention": entry.get("retention"),
                "open_decisions": entry.get("open_decisions", []),
                "evidence": entry.get("evidence", []),
                "decision_file": entry["_source_file"],
                "column_count": len(inv["columns"]),
                "column_dispositions": {
                    k: v for k, v in rel_counts.items() if v
                },
                "columns": out_columns,
                "constraints": inv.get("constraints", []),
            }
        )

    if errors:
        raise BuildError(
            "manifest build failed with %d error(s):\n  - %s"
            % (len(errors), "\n  - ".join(errors))
        )

    base_tables = sum(1 for r in out_relations if r["kind"] == "r")
    views = sum(1 for r in out_relations if r["kind"] == "v")

    return {
        "manifest_version": "1",
        "milestone": "M3",
        "generated_by": "database/v2/migration/manifest/build_manifest.py",
        "generated_note": (
            "GENERATED FILE. Do not hand-edit. Edit "
            "database/v2/migration/manifest/dispositions/*.json and rebuild. "
            "Contains no wall-clock timestamp so regeneration is byte-identical."
        ),
        "status": "proposal-for-coordinator-review",
        "physical_contract": {
            "path": "../../M3-contract.md",
            "description": (
                "Coordinator-owned M3 physical contract. Every + target in this "
                "manifest is a proposed destination defined there; it must be "
                "rechecked after the contract/migration changes."
            ),
        },
        "physical_destination_index": {
            "path": "physical-destination-index.json",
            "sha256": sha256_file(DESTINATION_INDEX),
            "totals": destination_index.get("totals", {}),
            "description": (
                "Generated from the M1/M2/M3 migration SQL. The validator uses "
                "this sidecar to resolve every concrete target and archive "
                "reference; rerun its builder whenever the physical migration "
                "changes."
            ),
        },
        "source": {
            "project_ref": inventory.get("source_project_ref"),
            "database": inventory.get("database"),
            "timezone": inventory.get("timezone"),
            "captured_at": inventory.get("captured_at"),
            "inventory_file": inventory_path.name,
            "inventory_sha256": sha256_file(inventory_path),
            "schemas_present": inventory.get("schemas", []),
        },
        "decision_files": provenance,
        "disposition_vocabulary": {
            "preserved": (
                "Fact reaches the v2 runtime model with meaning and value intact. "
                "A rename or identity renumber alone is still 'preserved'."
            ),
            "transformed": (
                "Fact reaches v2 but changed: unit, value domain, precision, "
                "normalisation, or split across multiple target columns."
            ),
            "derived-retirement": (
                "Not carried; recomputable from carried facts or derived "
                "independently by the target. Must name what makes it recoverable."
            ),
            "authorized-retirement": (
                "Not carried and intentionally unrecoverable under an explicit "
                "product decision. Must name the decision authority."
            ),
            "audit-archive": (
                "Not in the runtime model. Retained only in a bounded migration "
                "archive with a stated purpose and retention."
            ),
            "unresolved-decision": (
                "No agreed disposition. Must name the probe or coordinator "
                "question that unblocks it."
            ),
        },
        "value_semantics": {
            "capability_projection": {
                "rule": CAPABILITY_PROJECTION_RULE,
                "authority": "docs/v2-m3-capability-decision.md",
                "mapping": dict(CAPABILITY_PROJECTION_MAPPING),
                "forbidden_projections": sorted(CAPABILITY_FORBIDDEN_PROJECTIONS),
                "rationale": (
                    "A legacy Steam visibility boolean is an availability "
                    "heuristic, not a provider privacy assertion: "
                    "lib/steam-owned-games.ts:117 derives libraryVisible from "
                    "games.length > 0, playtimeVisible from "
                    "some(hours_played > 0) and lastPlayedVisible from "
                    "some(last_played_at). A fully visible library that has "
                    "never been played yields false. Projecting false to "
                    "'hidden' would manufacture a privacy claim the source "
                    "never made, so false and NULL both project to 'unknown'."
                ),
                "hidden_note": (
                    "'hidden' remains a legal app.account_capabilities value "
                    "(M1:146-153) and is reachable only from independent "
                    "validated privacy evidence. No legacy boolean supplies "
                    "that evidence. The M3 preservation schema agrees: "
                    "app.account_capability_evidence."
                    "projection_status admits only visible / unknown / "
                    "conflict / unresolved."
                ),
                "lossiness_note": (
                    "The projection is deliberately lossy: legacy false and "
                    "legacy NULL are indistinguishable afterwards. Every "
                    "projected column therefore also names a "
                    "raw_evidence_target so the original observation and its "
                    "precedence survive in "
                    "app.account_capability_evidence."
                ),
                "enforced_by": (
                    "build_manifest.check_capability_projection at build time "
                    "and validate_manifest V15 against this generated file."
                ),
            }
        },
        "target_notation": {
            "plain": (
                "e.g. 'app.accounts.id' -- exists today in an applied, frozen "
                "migration (M1 20260906093036 or M2 20260907163356)."
            ),
            "plus_prefix": (
                "e.g. '+app.playtime_daily.games_with_playtime' -- does NOT exist "
                "in the frozen M1/M2 schema. Its destination is defined in the "
                "coordinator-owned database/v2/M3-contract.md and must be "
                "rechecked against the new M3 migration."
            ),
            "migration_schema": (
                "The 'migration' schema is private: M1:781-782 grant USAGE on app "
                "and catalog only, so neither vault_app nor vault_worker can reach "
                "migration.* at runtime. Archives and staging live there."
            ),
        },
        "totals": {
            "relations": len(out_relations),
            "base_tables": base_tables,
            "views": views,
            "columns": column_total,
            "by_disposition": {k: totals[k] for k in DISPOSITIONS},
        },
        "relations": out_relations,
    }


def render(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, sort_keys=False, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--check",
        action="store_true",
        help="do not write; exit non-zero if the committed manifest is stale",
    )
    ap.add_argument("--inventory", type=Path, default=INVENTORY)
    ap.add_argument("--decisions", type=Path, default=DECISIONS_DIR)
    ap.add_argument("--output", type=Path, default=OUTPUT)
    args = ap.parse_args(argv)

    try:
        inventory = load_inventory(args.inventory)
        decisions, provenance = load_decisions(args.decisions)
        manifest = build(inventory, decisions, provenance, args.inventory)
    except BuildError as exc:
        print(f"BUILD FAILED\n{exc}", file=sys.stderr)
        return 1

    text = render(manifest)

    if args.check:
        if not args.output.exists():
            print(f"CHECK FAILED: {args.output} does not exist", file=sys.stderr)
            return 1
        if args.output.read_text() != text:
            print(
                f"CHECK FAILED: {args.output.name} is stale; rerun without --check",
                file=sys.stderr,
            )
            return 1
        print(
            "manifest up to date: %d relations / %d columns"
            % (manifest["totals"]["relations"], manifest["totals"]["columns"])
        )
        return 0

    args.output.write_text(text)
    t = manifest["totals"]
    print(
        "wrote %s\n  %d relations (%d tables + %d views), %d columns"
        % (args.output, t["relations"], t["base_tables"], t["views"], t["columns"])
    )
    for k, v in t["by_disposition"].items():
        print("  %-20s %4d" % (k, v))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
