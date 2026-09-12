# M3-B manifest, probe and validator checkpoint

Manifest, probe and validator work completed on `codex/v2-architecture`, 10
September 2026. This checkpoint covers the assigned
`database/v2/migration/**` deliverables and does not claim M3 completion, a
source export or a final freeze snapshot.

## Afternoon handoff status

The semantic and physical integration layers are complete against the current
sibling SQL: V15 checks the account-tuple visibility rule in coverage and
strict modes, V16 ratchets settled `pending_destination` decisions, and V17
checks the plan 13 retention classes. The SQL-derived sidecar is now 92
relations (35 applied + 57 proposed) and 991 columns, with SHA-256
`ea92cb5e2f2e62f79d187f90ab6dcc32d1e001d4dc8caa67bc7bcdbe08af82c8`; its
M3 source hash is
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a` and the
current physical contract hash is
`46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`.
The generated manifest binds that sidecar and covers 44 relations / 486
columns. The saved synthetic probe replay is unchanged evidence and is not
rerun for these manifest-only edits.

## Scope and evidence boundary

The source inventory remains the manifest authority:
[`database/v2/source-schema-inventory-20260909.json`](../database/v2/source-schema-inventory-20260909.json)
records 44 public relations, 42 base tables, 2 views and 486 columns for
project `pfvblcopcmairdfeqdep`. The non-public, visibility, conflict and
playtime JSON files are immutable aggregate audits only; they are not an export
or a final freeze snapshot. No source rows, credentials, private JSON values or
definition text were copied into this bundle.

The local SQL replay used a disposable database named
`vaultshuffle_m3_probe_fixture_20260910` and synthetic adversarial rows built
from the recorded public inventory. It did not use an M1/M2 evidence database,
an export fixture database or the source project. The public bundle ran inside
one `READ ONLY` transaction with a 30-second statement timeout and a 2-second
lock timeout. The schema was created by `vault_local_admin`; probes and
assertions ran as temporary role `vault_m3_probe_reader`, which was verified as
`LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, with
`public` schema `USAGE`, no `CREATE`, and table `SELECT` without `INSERT`.

## Completed layers

| Layer | State | Evidence |
|---|---|---|
| Checkpoint and evidence boundary | Complete | This file; audit-only/source-freeze boundary stated explicitly |
| Manifest validator hardening | Complete | Source identity required; `r`/`v` kinds checked; duplicate inventory relations/columns rejected; `--final-load` rejects unresolved columns and relation decisions; V14 resolves every concrete target/archive reference against the SQL-derived destination index |
| Manifest generation | Complete | Generated manifest links `physical_contract.path` to the coordinator-owned [`database/v2/M3-contract.md`](../database/v2/M3-contract.md) and binds `physical_destination_index.sha256` to the SQL-derived sidecar; `--check` passes at 44 relations / 486 columns |
| Physical destination binding | Complete for the current proposal | [`physical-destination-index.json`](../database/v2/migration/manifest/physical-destination-index.json) is rebuilt from the sibling's actual M1/M2/M3 SQL: 92 relations (35 applied + 57 proposed), 991 columns; V14 rejects missing targets and sidecar hash drift |
| Probe privacy and SQL correctness | Complete | Public refs schema-qualified; private/freeform JSON keys, values, unconstrained grouping labels and definition text are not projected; optional platform probes are isolated and preflighted; digest shape is validated before decode; NULL and IEEE-754 boundary cases are covered |
| PostgreSQL fixture replay | Complete | Inventory-derived 44-relation / 486-column fixture; meaningful rows detect playtime disagreement, NULL minutes, duplicate positions, family over-cap, digest collision, cumulative decrease and JSON shape without key output |
| Mechanical and validator tests | Complete | 22 probe-safety tests and 97 manifest/validator tests pass |
| Capability projection semantics (V15) | Complete | Legacy `false` no longer maps to `hidden` anywhere; the mapping is structured data checked by the builder and by validator rule V15 in BOTH modes, with a prose backstop across all 486 columns |

The identity/session disposition keeps long-lived `manual_profile_sessions`
rows in unified `app.sessions` with `session_kind = 'manual'`, exact decoded
digest, owner, expiry and `migration.session_map` provenance. Only the separate
short-lived `manual_profile_security_intents` expire and restart at final
maintenance. A manifest regression enforces this distinction and keeps the
intent's `source_manual_session_id` rationale scoped to intent retirement.

## Capability visibility correction (the semantic contradiction)

The checkpoint prose was right and the artefact was wrong. All three account
visibility transforms in
[`dispositions/00-identity-and-sessions.json`](../database/v2/migration/manifest/dispositions/00-identity-and-sessions.json)
read `true->'visible', false->'hidden', NULL->'unknown'`, and one carried the
comment "NULL must never become 'hidden'" — an earlier fix that guarded NULL
and left `false` wrong. Coverage validation passed anyway, because nothing
checked value semantics.

What changed:

* The binding mapping is now **`true -> 'visible'; false -> 'unknown'; NULL ->
  'unknown'`**, on all six legacy `steam_*_visible` columns (three account-side,
  three profile-side).
* The rule is **structured data, not prose**. Each column carries a
  `capability_projection` object (`rule`, `mapping`, `feeds_capability`,
  `evidence_precedence`, `raw_evidence_target`, `authority`), and the manifest
  carries a top-level `value_semantics.capability_projection` stating the rule
  and forbidding `hidden`/`private` as legacy-boolean projections.
* Because the projection is **lossy** — legacy `false` and legacy `NULL` are
  indistinguishable afterwards — the account-side booleans now write BOTH
  `app.account_capabilities.<x>_visibility` AND
  `app.account_capability_evidence.raw_<x>_visible`, with
  `steam_visibility_checked_at` joining the same account-side row so the tuple
  is not split from its checked time. Before this change the authoritative
  side's raw flags were destroyed by the projection.
* Profile-side rows keep `feeds_capability: false` and
  `evidence_precedence: 'profile_reader'`, so differing profile evidence is
  preserved with attribution and still never writes the tri-state.
* `hidden` remains a legal `app.account_capabilities` value (M1:146-153). It is
  reachable only from independent validated privacy evidence, which no legacy
  boolean supplies.

How it is enforced, rather than asserted:

* `build_manifest.check_capability_projection` fails the BUILD when a column
  targets a tri-state column without a structured projection, when the mapping
  is not exactly the binding one, or when `raw_evidence_target` is absent.
* Validator rule **V15** re-checks the same semantics against the GENERATED
  manifest, in coverage mode as well as `--final-load`, so a coverage pass can
  no longer bless the opposite rule.
* A prose backstop regex runs over `transform`, `note`, `blocked_on` and
  `recoverable_from` on all 486 columns, so the rule cannot be reintroduced in
  narrative text after the structured mapping is made correct.
* V14 now also resolves each `raw_evidence_target` against the SQL-derived
  destination index, so "the raw observation is preserved" is a checkable claim
  about a real column rather than a promise.
* Cross-artefact: a read-only test asserts the sibling's
  `app.account_capability_evidence.projection_status` domain admits
  `visible`/`unknown`/`conflict`/`unresolved` and no `hidden`. The two artefacts
  now agree.
* `probes/p07-constraint-conflicts.sql` P07f had the same weaker comment. Only
  the comment changed; the executed statement stream is unchanged, so the probe
  was not rerun. A probe-safety test now rejects any probe text that documents a
  `false`/`NULL` to privacy-state projection.

## Exact local verification

The standalone commands and observed results are:

```text
$ python3 database/v2/migration/manifest/build_manifest.py --check
manifest up to date: 44 relations / 486 columns

$ python3 database/v2/migration/manifest/build_destination_index.py --check
destination index up to date: 92 relations (35 applied + 57 proposed), 991 columns

$ python3 database/v2/migration/validate/validate_manifest.py
manifest valid for coverage: 44 relations / 486 columns; unresolved decisions remain review blockers

$ python3 database/v2/migration/validate/validate_manifest.py --final-load
MANIFEST VALIDATION FAILED: 1 problem(s)
  - V13 strict final-load rejects unresolved decisions: 1 unresolved columns and 5 relations with open decisions

$ python3 -m unittest database.v2.migration.tests.test_probe_safety
Ran 22 tests in 0.065s
OK

$ python3 -m unittest database.v2.migration.tests.test_manifest_validator
Ran 97 tests in 4.031s
OK

$ python3 -m unittest discover -s database/v2/migration/tests
Ran 119 tests in 4.058s
OK

$ python3 -m py_compile database/v2/migration/manifest/build_manifest.py database/v2/migration/validate/validate_manifest.py database/v2/migration/tests/run_probe_fixture.py database/v2/migration/tests/test_probe_safety.py database/v2/migration/tests/test_manifest_validator.py
# exit 0; no output
```

The successful disposable-database replay used the isolated local cluster
override below because the shared `/tmp/vaultshuffle-pg17` cluster was in
recovery and the sibling's temporary cluster is separately owned:

```text
$ M3_PGHOST=/tmp/vaultshuffle-m3-probe-socket M3_PGPORT=55434 python3 database/v2/migration/tests/run_probe_fixture.py
fixture=PASS database=vaultshuffle_m3_probe_fixture_20260910 relations=44 columns=486 public_probe_bundle=PASS optional_objects_absent=6 queue_age_columns=0
fixture_findings=playtime_divergent_rows:1,null_minutes_rows:3,collection_duplicate_rows:1,family_over_cap_accounts:1,decoded_digest_collisions:1,snapshot_decreases:1,json_documents_without_key_output:2
```

The fixture's temporary database was dropped in `finally`, the temporary probe
role was dropped afterward, and the post-run admin assertion returned
`0  0` for `(fixture_database_count, probe_role_count)`. This replay predates
the final manifest-only retention edits and remains valid unchanged evidence;
the isolated cluster is disposable and no shared or sibling cluster is part of
this replay.

## Required decisions carried forward

- Coverage mode may enumerate unresolved source-value decisions for review. A
  final-load invocation fails while any `unresolved-decision` column or
  relation-level `open_decisions` entry remains. The current strict result is
  intentionally a blocker, not a coerced pass.
- Probe output exposes only fixed allowlisted buckets, `null`/`other` counts,
  numeric bounds and aggregate JSON shape/key-count statistics. Freeform JSON
  keys and values, arbitrary text grouping, comments, defaults, trigger bodies,
  routine bodies and constraint definitions remain private review material.
- Public relation references are schema-qualified. Optional auth, cron, queue,
  storage and migration-ledger relations are separate probes; a runner must
  preflight each `@requires` relation and report `absent`/`present` before
  running object-specific SQL. `net.http_request_queue.created` is not used:
  the recorded source metadata has no such column.
- A repeatable-read rehearsal is snapshot-consistent while schedules write. It
  is separate from final-cutover schedule fencing: a concurrent scheduled write
  does not invalidate a read-only rehearsal snapshot, while final cutover must
  freeze or fence the relevant writers and record the source snapshot identity.
- Playtime and visibility audits remain measured aggregate evidence only. The
  real export must rerun them in its one source snapshot and reconcile any new
  disagreement. Unknown family minutes remain unknown; authored hours and raw
  tuple/provenance evidence are retained when they cannot be reproduced. The
  account-side visibility tuple is authoritative per
  [`docs/v2-m3-capability-decision.md`](v2-m3-capability-decision.md), while
  `false`/`NULL` projects to unknown absent independent privacy evidence.
- Durable authored/provenance facts belong in the physical destinations defined
  by the sibling's actual [`database/v2/M3-contract.md`](../database/v2/M3-contract.md):
  `app.accounts.last_login_at`, `app.account_capability_evidence`,
  `app.library_legacy_measurements`, `app.purge_review_history`,
  `app.family_members`, `app.collection_games`, `ops.account_merges`, and the
  durable catalogue relations. The complete stale `user_game_state` child is
  bounded `migration.legacy_user_game_state_audit` staging; only rows explicitly
  marked for promotion reach durable `app.game_state_legacy_measurements`, and
  neither relation becomes runtime authority. Raw migration staging and exports
  follow plan 13's bounded post-cutover window; no “permanent while feature
  exists” claim is used for raw staging.

## Remaining blockers

The manifest now has one explicit unresolved column decision and five
relation-level open decisions. The column blocker is `user_games.hours_played`
(`D-LIB-3`): the exact observed minutes remain separate from the legacy numeric
and raw hours evidence, with unreproducible values promoted to durable
`app.library_legacy_measurements`; the active runtime precedence remains gated
on P05 at the final source snapshot. No authored value is inferred from a
discrepancy.

The relation-level gates are `api_rate_limits` cooldown behavior at cutover,
`purge_reviews` completion reconciliation (`PX-c`), `steam_import_jobs`
in-flight accounts at freeze, `user_games`'s remaining hours precedence, and
the live `user_games_with_catalog` view definition (`P04`). They remain
fail-closed until an authorized snapshot, manifest review and coordinator
decision resolves them. `app_users.last_login_at` (`D-IDN-4`) is settled to
nullable `app.accounts.last_login_at`, separately from `last_seen_at`, and is
no longer a blocker.

The coordinator's saved counts (including 183 account/profile visibility
disagreements, 24,428 stale-state rows and the measured playtime populations)
remain audit evidence only. They do not authorize an export, freeze, remote
query, remote apply or source mutation. The sibling implementing the physical
contract owns destination names and the migration hash; this bundle links to
the actual current SQL-derived index and contract hash rather than inventing a
destination or hash.
