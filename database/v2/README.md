# VaultShuffle production database

V2 is live on Supabase project `vbjtbwelnhbbdfrqczyf` in Virginia. V1 was deleted by the user after the successful 1 October 2026 release. There is no V1 recovery or rollback target.

## Files to keep

- `supabase/migrations/`: the 26 applied, immutable migrations. Future schema changes require a new additive migration; never rewrite the applied chain.
- `supabase/config.toml`: private-schema project configuration. Application schemas are not exposed through the browser Data API.
- `tests/`: SQL and concurrency regression fixtures for constraints, tenant access, session handling, atomic publication, HLTB and Blacklist. Use disposable databases; phase-specific fixtures require the corresponding point in the migration chain.
- `final-cutover-acceptance-20261001.json`: complete transfer, recovery, backup/restore and live acceptance receipt. Counts are snapshots at acceptance, not current totals.
- `final-compaction-audit-20261001.json`: measured storage reclamation.

Production repositories, workers and their tests live in `lib/v2`. Run `npm run test:v2` for their tests. PostgreSQL integration tests create disposable local clusters using the existing PG17 test runtime; they must not target production.

The completed V1 export/transform/load pipeline, source probes/inventories, draft SQL, rehearsal packets and checkpoint files have been removed. Their historical versions remain in Git through `74f482c`; they are not current operating instructions.

See [database architecture](../../docs/database-architecture.md), [operations and recovery](../../docs/v2-cutover-runbook.md), and [completion status](../../docs/v2-execution-status.md).
