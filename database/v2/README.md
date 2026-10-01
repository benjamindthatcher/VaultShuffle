# VaultShuffle production database

V2 is live on Supabase project `vbjtbwelnhbbdfrqczyf` in Virginia. V1 was deleted by the user after the successful 1 October 2026 release. There is no V1 recovery or rollback target.

## Files to keep

- `supabase/migrations/`: the 26 immutable launch migrations and additive follow-ups. The two Library storage follow-ups (`20261001164408`, `20261001170624`) are applied. Future schema changes require a new additive migration; never rewrite the applied chain.
- `supabase/config.toml`: private-schema project configuration. Application schemas are not exposed through the browser Data API.
- `tests/`: SQL and concurrency regression fixtures for constraints, tenant access, session handling, atomic publication, HLTB and Blacklist. Use disposable databases; phase-specific fixtures require the corresponding point in the migration chain.
- `final-cutover-acceptance-20261001.json`: complete transfer, recovery, backup/restore and live acceptance receipt. Counts are snapshots at acceptance, not current totals.
- `final-compaction-audit-20261001.json`: measured initial index reclamation.
- `final-staging-cleanup-20261001.json`: restore-verified local archival and early removal of the 18 unused transfer tables' rows, reducing hosted storage to about 291 MB.
- `final-library-storage-cleanup-20261001.json`: restore-verified local archival of unused legacy measurements/source-state evidence, exact Library date preservation and physical compaction, reducing hosted storage to about 249.5 MB.
- `maintenance/20261001_archive_transfer_staging.sql`: the exact tested one-off operator procedure; requires archive fingerprints and refuses drift or live dependencies. It is completed, not a schema migration or a recurring job.

Production repositories, workers and their tests live in `lib/v2`. Run `npm run test:v2` for their tests. PostgreSQL integration tests create disposable local clusters using the existing PG17 test runtime; they must not target production.

The completed V1 export/transform/load pipeline, source probes/inventories, draft SQL, rehearsal packets and checkpoint files have been removed. Their historical versions remain in Git through `74f482c`; they are not current operating instructions.

See [database architecture](../../docs/database-architecture.md), [operations and recovery](../../docs/v2-cutover-runbook.md), and [completion status](../../docs/v2-execution-status.md).
