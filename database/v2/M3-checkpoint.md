# M3-B database checkpoint

Physical-schema work is implemented in the shared worktree as of 10 September
2026. This checkpoint replaces the earlier stale note that called the migration
empty. The final migration is 2,128 lines and contains the bounded UI-history
retention/deletion, bounded stale-state staging/sparse evidence, column-scoped
compound-FK deletion, and `app.accounts.last_login_at` layers described by the
afternoon resume brief.
The final M3 migration SHA-256 is
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.
The final physical contract SHA-256 is
`46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`.
Fixture SHA-256 values are `m3.sql`
`585c4a1acf0a42854f6658f3a316d4e3181faf141ca3925680be9819559327de`,
`m3_replay.sql`
`90623f371319595e201da9412b99ca628f9fcf3ac3034fd13d3cee27434d4656`,
`m3_security.sql`
`3979f14306d40992e4bd4b9ab425a77addd6d7e5bdf8a2faec9f6b19d49eb0d1`, and
`m3_cleanup.sql`
`19e73d8b463000a90fd6ac10456b7f0e1b766a7becf28849b0e8fa1dcdd5bb01`.

## Applied state (added 11 September 2026 by the catalogue/manifest worker)

Root applied the reviewed M3 migration on the target at **2026-09-10T23:26:54Z**
and management assigned the version `20260910232654`. The local file was
**renamed, not edited**: its content SHA-256 is unchanged at
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`, verified on
disk under the new name. M1, M2 and M3 are now all applied and immutable, so no
migration may be edited or reapplied; a newly found physical gap is a finding
for root that needs a new, separately reviewed migration.

The physical contract SHA-256 changed with this applied-state refresh. It was
`46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577` at the
final4 review and is re-recorded by the regenerated sidecar; the M3 SQL hash
above is unaffected, because only prose changed.

Remote schema, security and rollback verification remain root's, and are not
claimed here. Root's apply record states the target still holds no source rows,
with the marker deliberately left at `m1`; that is root's remote observation,
not a local check. Nothing in this refresh queried a remote service.

## Scope and authority

This batch owns `database/v2/M3-contract.md`, the single CLI-created migration
`database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql`
(renamed from its pre-apply name `20260909214501_m3_preservation_schema.sql`;
see the applied-state note below), and the new `database/v2/tests/m3*.sql`
fixtures. M1 and M2, the architecture
plan, root ledger, exporter, manifest worker, and source systems remain outside
this work. No remote operation, source query, credential, provider activation,
deployment, export, data load, package change, or commit is authorized here.

The migration was created with `/opt/homebrew/bin/supabase migration new
m3_preservation_schema`; it remains the one M3 migration. The stable M1
`ops.project_marker.schema_version = 'm1'` is preserved. M3 advancement is
represented by the migration filename and the owner-only migration ledger after
a real source replay.

## Measured coordinator evidence available to this batch

These aggregate files are read-only evidence, not exports or source snapshots:

- `source-conflicts-audit-20260909.json`: 684 accounts; two manual accounts
  have no profile; visibility disagrees on 183/461 compared Steam accounts with
  271 differing timestamp comparisons; one collection has duplicate positions;
  family maximum four with no current orphan; all five merge sources survive;
  completion identity/order checks, session shape/expiry, and decoded collision
  checks are clean.
- `source-playtime-audit-20260909.json`: 365,610 owned rows have exact
  observed minutes; 1,563 family rows have null/zero hours; 24,428 stale
  staging rows remain; completion and recency disagreements remain evidence.
- `source-nonpublic-audit-20260909.json`: 45 non-public relations were
  inventoried; auth users, storage buckets/objects, and queued HTTP rows were
  zero; the HTTP queue has no `created` column.

False legacy visibility flags remain absence of a positive observation, not
proof of private status. The account-side tuple decision is retained in the
contract and physical evidence tables; source values are still loader inputs.

## Completed implementation layers

| Layer | State | Physical evidence |
|---|---|---|
| Supabase skill/CLI guidance | complete | Skill read; CLI naming command produced the migration path. |
| M1/M2 immutability | complete | Frozen migration files were not modified; published hashes remain in the contract. |
| Additive target columns | complete | Catalogue first/last-seen provenance, game metadata/features, cumulative playtime semantics, recency evidence, family/collection/pin/completion provenance, and `app.accounts.last_login_at`. |
| Durable domain evidence | complete | Catalogue observations/aliases/reviews/offers/provider terminal state; draw/event and unknown completion history; sparse library and stale-state measurements, purge decisions, orphan family evidence, capability evidence; frozen warm-start data and operator weights. |
| Migration maps and phases | complete | Bidirectional identity maps, run/step watermarks, relation counts, conflict reports, ledger, cutover state, recovery holds, and retention status view. |
| Retention and deletion registry | complete | Enforced retention vocabulary, 30-day staging bound after validated cutover, explicit `ui-history-90d` latest-100/90-day candidates, durable account-domain destinations, account export scope, and registry coverage metadata. |
| RLS and ACL boundary | complete | M3 relations force RLS; private migration/support/operations evidence has no runtime grant; named new-object grants preserve existing M1/M2 ACLs. |
| SQL fixtures | complete in worktree | `m3.sql`, `m3_replay.sql`, `m3_security.sql`, and `m3_cleanup.sql` cover constraints, evidence, phase/idempotency, RLS, ACLs, retention, deletion and rollback cleanup. |

## Replay status

The final clean isolated PG17.6 replay used the disposable cluster
`node_modules/.cache/vaultshuffle-m3-final4-20260910`, database
`vaultshuffle_m3_final4`, and private socket
`/tmp/vaultshuffle-m3-final4-socket-20260910`. Immutable M1, immutable M2, and
the exact current M3 file all applied with `ON_ERROR_STOP=1`. The migration
owner check returned `vault_local_admin` with `rolsuper = false`,
`rolbypassrls = true`, `rolcreaterole = true`, `rolcreatedb = true`, and
`rolcanlogin = true`, matching the target owner shape. The stable marker stayed
`m1`.

Against that replay, `m3.sql`, `m3_replay.sql`, `m3_security.sql`,
`m3_cleanup.sql`, and `m1_session_clock.sql` all exited successfully. The
fixtures covered constraints, map retry/idempotency, exact raw evidence,
bounded 30-day staging, sparse stale-state promotion, latest-100/90-day UI
history candidates, account deletion of private rows and source UUIDs,
draw deletion with pointer clearing and child cascade, collection deletion
with native column-scoped SET NULL, cross-tenant isolation, deliberate SET
NULL de-identification, tenant RLS, named ACLs, and rollback cleanup. The
security fixture ran as the
disposable bootstrap superuser only so it could `SET LOCAL ROLE vault_app`;
runtime roles remained `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, and
`NOCREATEROLE`, with no persistent role-membership mutation.

The final SQL logs are retained under that disposable cluster directory:
`replay-m1.log`, `replay-m2.log`, `replay-m3.log`, `test-m3.log`,
`test-m3-replay.log`, `test-m3-security.log`, `test-m3-cleanup.log`,
`retention-explain.log`, and `final-catalog-check.log`. The final catalog
check reports 92 private
relations and 991 columns, and confirms the two scoped actions:
`ON DELETE SET NULL (collection_id)` for the draw/collection key and
`ON DELETE SET NULL (current_draw_ref)` for the state/draw key. The old
collection `SECURITY DEFINER` detach helper is absent. No additional
retention-only indexes remain; the existing account/time and unique account
indexes are used by the account-scoped query.

The checked-in physical destination index has now been regenerated against the
applied files (11 September 2026). It records the same **92 relations and 991
columns** — app 31/313, catalog 13/194, migration 25/239, ops 15/166,
reco 5/44, support 3/35 — with all 92 now `applied` and none `proposed`, the M3
source hash `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`
under the applied filename `20260910232654_m3_preservation_schema.sql`, the
apply instant `2026-09-10T23:26:54Z`, and the `ui-history-90d` registry class.
Because this refresh edited contract prose, the recorded physical-contract hash
moved from `46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`
to `2d7a77eb38f69cf6985ebf1b803bd187cc3f1b5033f9468da7480f044da3a68e`; the SQL
hash is unchanged, because no SQL was touched. The sidecar itself is
`095797f57b21c3fc0bb063351bdb1a49f33f4ef49075f3b50fe1ba056e5607b1` and the
regenerated disposition manifest is
`98355df376c5793ca8b3e37ebaab08869c8cd9e3084bcdde2ad8f616f6f4f843`.
The exact local commands were `python3
database/v2/migration/manifest/build_destination_index.py` and `python3
database/v2/migration/manifest/build_manifest.py`, both of which then report
`up to date` under `--check`.

The focused retention plan is recorded in `retention-explain.log`. A
rollback-only fixture inserted 40 synthetic accounts, 10,000 draws, 10,000
draw events, and 40 actions, then prepared the exact account-scoped query from
the contract with `LIMIT 20`. PostgreSQL's plan returned 300 candidates before
the top-N limit, ranked 250 rows for the selected account, and used account
index conditions on every draw/event branch; it did not scan the other 39
accounts. The final schema has no retention-only duplicate indexes: the
existing account/time and account/id indexes cover the observed path. The
earlier default-materialized form had scanned all synthetic draw rows before
filtering the account, which is why the view now declares its ranking CTE
`NOT MATERIALIZED` and the contract requires a bound account parameter.

The read-only cross-domain checks pass for the last generated sidecar:
`python3 database/v2/migration/tests/test_probe_safety.py` ran 16 tests, and
the validator run against `/tmp/m3-physical-destination-index-final4.json`
passed. The sibling manifest test module currently has 97 tests; its two
failures are sibling-owned manifest drift (the manual-session disposition
expectation and the checked-in sidecar hash), not physical SQL failures.
Those checks confirm all 486 source columns in the disposition manifest have
explicit dispositions; the physical index resolves 991 destination columns
and proves destination names only. The account-side visibility rule remains
`true -> visible` and `false/NULL -> unknown`, and the stale-state split points
at bounded staging plus sparse durable evidence. Rerun the validator after the
sibling refreshes the sidecar hashes.

The old immutable M1 fixture `m1.sql` deliberately writes a dangling
`app.vault_state.current_draw_ref`; after M3 adds the scoped draw-history FK,
that historical fixture is expected to fail if run after M3. M1 migration
application and `m1_session_clock.sql` passed previously. Do not edit M1/M2 or
their fixtures to hide this expected contract change; run the M1 baseline before
M3 for regression evidence.

## Remaining source and coordinator gates

The physical schema does not decide authored-hours authority versus exact
observed minutes, unknown completion identity, duplicate collection order,
stale `user_game_state` code meanings, catalogue type/quarantine/duration
manual decisions, in-flight import rerun, future deleted-source tombstones, or
the measured reconciliation conflicts. The final M3 gate still requires one
consistent export/snapshot, manifest transforms, parity/reconciliation, and
storage measurement. No M3 completion claim is made by this checkpoint.
