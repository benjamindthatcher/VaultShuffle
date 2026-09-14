# M3 local loader checkpoint

Updated: 13 September 2026

## Scope and safety boundary

Batch C owns `lib/v2/migration/load/**`, its synthetic loader fixtures, this
checkpoint, `docs/v2-m3-loader-contract.md`, and
`docs/v2-m3-local-runbook.md`. Export, reader, transform, schema and manifest
files are inputs and remain read-only. All execution is synthetic and against
an explicitly named local Unix socket. No remote source or target connection,
secret discovery, deployment, commit, or push is part of this batch.

## Completed foundation and verified failure boundaries

- Private staging spools each verified relation to a `0700` directory and
  `0600` sealed NDJSON file with per-relation row, cell and byte bounds. A
  reader that emits a row and then fails terminal verification deletes the
  partial stage and leaves the target untouched.
- The pipeline evaluates source coverage, transform exceptions, unresolved
  conflicts, supplied snapshot decisions and an independently supplied pinned
  schema fingerprint before creating `migration.runs` or writing a target row.
- Target loading uses one PostgreSQL transaction, typed temporary tables,
  explicit COPY encodings, dependency ordering, immutable run metadata and
  applied-step checksums, exact `EXCEPT ALL` reconciliation before commit, and
  per-source `migration.relation_counts`.
- Replay of identical immutable evidence is an idempotent no-op. A changed
  snapshot/schema/manifest/transform/staging identity for the same run is
  rejected before target mutation.
- Explicit identity values are followed by loader-owned transactional `ALTER
  SEQUENCE ... RESTART WITH max(id)+1`. One test proves the next ordinary insert
  succeeds without test-side repair; a second forces reconciliation failure
  after the restart and verifies the sequence state rolls back unchanged.
- The focused loader unit suite passed 23/23. The pre-Blacklist PG17 pipeline
  suite passed 12/12 on M1+M2+M3+preservation-follow-up,
  covering success, exact integers/microseconds/COPY escapes, precommit refusal,
  late reader failure, full rollback, replay, schema drift, sequence repair,
  private reporting and remote-target refusal.

## Blacklist contract incorporated

The load contract now writes required `app.game_state.blacklisted` and no
longer writes `slept_at`. The source fixture still reads and validates the
legacy `slept_at` cell while the library transform derives membership solely
from `status='Slept'`. Schema fingerprints and PG evidence must be refreshed
after replaying `20260912193000_blacklist_semantics.sql` locally.

## Completed all-domain and final-schema phase

- Applied the accepted V2 Blacklist migration to the isolated PG17 fixture and
  refreshed independently recorded fingerprints. The all-domain contract spans
  69 loaded/evidence relations and fingerprints to
  `1558351531a10a8ebfd5ec932cc56a21e434c883e7e46a2bdfb950fd96a208b8`.
- Replaced silent dynamic omissions with required-output checks, explicit
  session/capability source adapters, snake-case target normalization and
  allowlisted helper-field retirement. Target binding rejects an emitted field
  missing from PostgreSQL and any required target column absent from the batch.
- Fixed physical target names for capability evidence, completion history and
  registry, collection membership evidence, and removed the nonexistent draw
  map. Recommendation children share the explicitly loaded snapshot identity;
  catalogue prices share their explicitly loaded offer identity.
- Fixed read-back reconciliation for nullable booleans, fixed-scale numeric
  spellings and JSONB key order. JSON text keeps large numeric tokens intact
  through COPY. Per-column digests now identify a mismatching scalar class
  without exposing values.
- Expanded `all-domains.integration.ts` so all 44 source relations are nonempty,
  including manual identity/session/security intent, collections, commitments,
  draws, history, family, duration/provider queues, recommendation/settings,
  support and operational records. The sealed-reader and pure-transform
  preflight passes and checks every emitted field against the generated physical
  destination index. It exposed and fixed nullable AppID-reference handling and
  two missing helper-field retirements in the family/review adapters.
- Added owner-only, create-once reconciliation report output and the final
  loader contract/runbook.

## Final validation and remaining gates

Final local results:

- `npx tsc --noEmit --pretty false`: pass.
- `npx eslint lib/v2/migration/load/*.ts`: pass.
- Loader/all-domain units: 23 pass, 0 fail.
- The final expanded all-domain PG17 rehearsal passed 1/1. Its one transaction
  stages, transforms, loads and reconciles all 44 nonempty source relations and
  records 44 nonempty `migration.relation_counts` rows.
- The final targeted PG17 fault suite passed 13/13. It includes transactional
  identity-sequence restart and the regression proving a later reconciliation
  failure rolls that restart back, alongside the reader, gate, replay, schema,
  encoding, reconciliation, privacy and remote-target refusal cases.
- The all-domain pass also covers the final physical adapters: omitted
  `catalog.review_decisions.source_payload` is supplied as `{}`, and completion
  history has explicit identities with resolved and unknown registry links bound
  before COPY.

This batch performed no real or remote execution. A synthetic pass cannot close the
real consistent-export, full-row-visibility, V13 source-decision, real
exception/conflict, target-empty-at-run-time, measured-storage, private
real-reconciliation or operator cutover gates. Those remain mandatory and are
listed in `docs/v2-m3-local-runbook.md`.
