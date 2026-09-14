# Blacklist database/V2 checkpoint

## Root acceptance — 13 September 2026

V2 migration `20260912193000` is now APPLIED and immutable at the SHA below.
The legacy runtime compatibility migration remains UNAPPLIED for a coordinated
runtime release. The earlier local-state section below is historical evidence.

Root applied only the reviewed V2 file via the CLI after exact five-file hash
and empty-target checks. Target SQL behavior and cleanup passed; management
SQL could not assume `vault_app`, so the remote fixture used its existing
admin role, while the local PG17 fixture supplies actual runtime-role evidence.
Target columns, forced RLS and browser ACL checks passed, with zero real rows.
The guest browser flow passed. Index now records 92 relations / 988 columns,
zero pending schema changes; Python 122 checks and manifest coverage pass.
Only the existing V13 source decisions block strict final load.

Evidence: `database/v2/blacklist-target-validation-20260913.json`.
Blacklist development is complete; proceed with the M3 loader. No additional
feature architecture or speculative review is needed.

Completed 12 September 2026. Database and V2 half of the user-authorized
replacement of timed Sleep with permanent Blacklist. Local work only: no
production DDL, deployment, private source rows, secret lookup, commit, or push.

## Frozen contract

- Runtime status is `Blacklisted`; purge action is `blacklist`; draw/vault event
  vocabulary is `blacklisted`.
- Latest V2 stores only `app.game_state.blacklisted boolean not null default
  false` in the existing sparse row. There is no blacklist timestamp, expiry,
  restore history, or separate state subsystem.
- Frozen source `status='Slept'` authoritatively becomes `blacklisted=true`.
  Exported `slept_at` cells are syntax-validated and then intentionally
  discarded. A date never creates membership.
- Manual Reactivate sets the flag false. Both directions are repeat-safe.
  Completion, notes, playtime, dismissal state and separate Vault snoozes keep
  their existing behavior.
- `previous_active_status` remains for ordinary Completed/manual-reactivation
  semantics. V2 retires the Sleep-only `slept_at`, `restored_at`,
  `restored_from_slept_at`, `restored_from_previous_active_status`, and both
  `raw_slept_at` audit columns.
- `source_snapshot_hash` remains loader metadata on mapping, audit and history
  relations. It is not a physical `app.game_state` column.

The legacy runtime keeps its deployed RPC names/signatures:

- `set_user_game_status(uuid,uuid,text)` accepts `Blacklisted` and rejects
  `Slept`;
- `restore_user_game_active(uuid,uuid)` performs manual Reactivate;
- purge uses `blacklist` end to end.

Operator keys migrate atomically without changing positive/total/note:
`event:slept` -> `event:blacklisted` and `decision:sleep` ->
`decision:blacklist`. Both SQL and transform paths reject a legacy/new key
collision rather than choosing one.

## Schema state and frozen files

M1, M2, M3, and
`20260911234500_m3_legacy_preservation_followup.sql` are applied and immutable.
The follow-up remains byte-identical at SHA256
`beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59`.
`database/v2/m3-followup-target-validation-20260912.json` records that CLI
success occurred between the 14:56:33 precheck and 14:58:40 postcheck. The
exact apply instant was not returned, so the physical index truthfully records
`applied: true`, `applied_at: null`, and the observed evidence window.

Two Blacklist migrations are frozen locally and **unapplied**:

- `supabase/migrations/20260912192336_replace_sleep_with_blacklist.sql`, SHA256
  `b08f1a1ff300af972c4669554fccabcd3690115f2da4b56c72ce40fa4644e543`:
  current `public.*` runtime compatibility, data vocabulary conversion, exact
  transition RPCs, view/ACL recreation, and drift-fenced replacement of the two
  large installed import/merge functions.
- `database/v2/supabase/migrations/20260912193000_blacklist_semantics.sql`,
  SHA256
  `a20e75cbca19918d4a5d8cb2778a98f50bf98641b7594c4c067abe58a8c9cca6`:
  V2 boolean state, guarded tenant RPC, vocabulary conversion, and destructive
  retirement of obsolete Sleep-only columns.

Read-only source definition/dependency provenance is banked in
`database/v2/blacklist-source-rpc-metadata-20260912.json`. It records metadata
only; no private source rows or function arguments were captured.

The physical index now reports 92 applied relations, one pending addition
(`app.game_state.blacklisted`), and six pending column drops. Strict final-load
validation fails closed with V18 until the V2 Blacklist migration is applied.
Frozen generated checksums are
`d2c679dc5f2b0ac0d5bd44264569040142124bffe3b71276d7f4ed0703b24625`
for `physical-destination-index.json` and
`0ecc1eef10d9ad3a32fb48a6ed38ca521d17da9f9b41257c8b771bfe65a21185`
for `disposition-manifest.json`.
The source disposition vocabulary now has `authorized-retirement`, which
requires the explicit product authority and does not pretend the discarded
instant is recoverable.

## Concrete fixes made during acceptance

- Replaced invalid dynamic SQL string quoting in the compatibility migration.
- Migrated the separate free-text `public.vault_events.action` history.
- Changed the V2 mutation function to a narrow `SECURITY DEFINER` interface so
  callers do not receive direct Blacklist-column write grants. Forced RLS and
  `app.current_account_id()` still enforce the tenant boundary.
- Reactivate deletes a flag-only sparse row in one statement, avoiding a
  transient `game_state_check` violation; rows with notes/dismissal state keep
  those facts.
- Added conditional browser-role revokes so a plain local PostgreSQL replay and
  Supabase both behave correctly.
- Added transform mapping for current membership, purge history, draw/vault
  events and operator keys; removed Sleep-only output/audit fields from the V2
  transform and load contract.

## Validation evidence

All commands used synthetic local data only.

- `npx tsc --noEmit --pretty false`: pass.
- Focused transform/loader units: 178 pass, 0 fail.
- Python manifest/probe suite: 121 pass, 0 fail.
- Manifest coverage validation: pass, 44 relations / 486 columns.
- Strict final-load validation: expected refusal: V13 existing snapshot
  decisions plus V18 `1 pending additions, 6 pending drops, 1 unapplied
  migrations (blacklist-followup)`.
- Fresh PostgreSQL 17 replay of M1 + M2 + M3 + applied preservation follow-up +
  V2 Blacklist migration: pass.
- `database/v2/tests/blacklist_semantics.sql`: pass. Covers legacy-to-Boolean
  load boundary, permanent membership/no timed function, repeat Blacklist and
  Reactivate, sparse deletion, completion replacement, notes/playtime
  preservation, tenant isolation, forced RLS, narrow function ACL, removed
  columns and unchanged Vault snooze.
- `database/v2/tests/legacy_blacklist_compatibility.sql`: pass on fresh PG17.
  Covers in-place `Slept`/`sleep` vocabulary conversion, operator tuning,
  transition RPCs, repeat calls, cross-user refusal, removal of timed function
  references, read-view recreation and unchanged legacy snooze.
- `lib/v2/migration/transform/library-constraints.integration.ts`: 27 pass,
  0 fail against the latest V2 schema, including real inserts for
  `blacklisted=true` and the Sleep-free audit shapes.

## Apply and deployment gate

Root owns every remote action. Apply the legacy compatibility migration in the
same coordinated release window that switches the runtime to `Blacklisted`:
the old runtime's `Slept` writes will be rejected after the DDL, while the new
runtime requires the new RPC domain. The migration reads the installed large
function definitions and aborts the whole transaction if their reviewed
fragments drifted.

Apply the V2 migration to the separate V2 target before any updated loader run.
The 14:58:40 evidence found the target empty and healthy, but that observation
is dated and is not proof of its current contents; repeat the normal schema/
row/security precheck at the actual apply gate. The migration itself refuses to
infer membership if an older loader has populated any non-null `slept_at`.

There is deliberately no lossless SQL rollback claim. Both migrations drop the
populated Sleep timestamp column and normalize historical vocabulary; the V2
migration also drops Sleep-only restoration/audit columns. `DROP COLUMN` loses
those values. That loss is the user's explicit decision. Reversal would require
a pre-apply backup plus the old application/database contract, not a down
migration that reconstructs discarded dates.

After application, refresh the loader integration's frozen schema fingerprints
and replay its all-domain PG gate. Its source export continues to include old
`status` and `slept_at`; the transformer consumes the former and discards the
latter. No generic loader work was completed in this batch.
