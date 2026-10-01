# V2 operations and recovery

The coordinated cutover completed on 1 October 2026 at 11:08:02.828928 UTC. Production is Virginia project `vbjtbwelnhbbdfrqczyf`. V1 has since been deleted by the user. The old source-freeze/export/replace instructions are retired; do not repeat the transfer or switch to a legacy build/database.

## Production configuration

- `VAULT_DATABASE_AUTHORITY=v2`, `VAULT_MAINTENANCE=0`, `VAULT_CUTOVER_WORKERS=0`.
- Restricted application and worker credentials in `V2_DATABASE_URL` and `V2_WORKER_DATABASE_URL`, verified `V2_DATABASE_CA_PEM`, and `V2_PROJECT_REF` for the production target.
- Keep existing `SESSION_SECRET`, `CRON_SECRET` and `STEAM_WEB_API_KEY`. Do not substitute test secrets or rotate the session secret during unrelated cleanup.
- Transaction pooler port 6543, prepared statements disabled, app pool 2, worker pool 1.
- Three providers (`steam`, `steam_store`, `steamspy`) and five Vercel schedules. IGDB is removed; HLTB review/writeback runs locally.

## Recovery

Recover forward on V2. There is no remaining V1 database and no accepted reverse-replay procedure. Fence writes with maintenance when an incident requires it, preserve newer production data, and plan recovery against a verified V2 backup rather than blindly replaying the launch snapshot.

The accepted launch backup is in protected, Git-ignored `data/private/v2-backups/20261001/`. Its `schema-data-acl.dump` SHA-256 is `7672aebe2c075b2a3b9550342eab8612994b131d4350661b435e2d3eed5aff6d`. `COMPLETE.json` and `restore-accepted.json` record actual 26-migration restore acceptance: 97 relation fingerprints, 29 sequence heads, private ACLs and failure/sequence compensation. It is a launch-time snapshot, not a backup of subsequent writes. Role provisioning and credentials require the appropriate operator; the dump does not supply login passwords.

Before restoring anywhere, verify the destination and backup hash and use an isolated database for a restore drill. Never run a blanket replacement, phase-specific fixture, truncate or schema replay against live production as a routine cleanup.

After recovery, verify public routes, unauthorized worker denial, existing-session access, tenant isolation and representative Library/Blacklist/Wishlist/Collections/Vault flows before reopening. Database failure must not trigger a V1 fallback.

## Retention and storage

After the successful cutover, the user explicitly requested immediate local archival and removal of unused transfer data. On **1 October 2026**, all 18 temporary migration-staging relations were archived locally and cleared after an actual restore/fingerprint check, active-hold checks and runtime/dependency review. This supersedes the original 31 October wait for those existing rows. The tables remain empty; no live account, session, Library, game-state or catalogue rows were removed. Required application history and personal measurements remain in their live domains.

The protected archive is `data/private/v2-cleanup/20261001/staging-archive/`: `staging-data-schema-acl.dump`, `COMPLETE.json` and `RESTORE-ACCEPTED.json`. Its SHA-256 is `0182190e40bbe770b70a84f2c237aa9873ea68aa5e8a62a31ae452ea6b43096e`. It contains private historical transfer data; keep it out of Git and public uploads. The older launch backup includes these rows and is historical: do not accidentally restore them into live production during an unrelated recovery.

Measured database storage fell from **469,257,363 to 291,384,467 bytes**, reclaiming **177,872,896 bytes**. See [cleanup acceptance](../database/v2/final-staging-cleanup-20261001.json). No further purge of these launch staging rows is pending. Any future staging writes need their own archive and retention review.

The Library legacy relations were subsequently archived to protected `data/private/v2-cleanup/20261001/legacy-library-archive/`. The full schema/data/ACL dump SHA-256 is `b2f9c513be26f402288d6c3ff2f5abeff14ec4dc0b7de404c9dd2c3f6824f62d`. `RESTORE-ACCEPTED.json` and `HEAP-RESTORE-ACCEPTED.json` record actual restores, exact fingerprints and rollback/access verification. Unused measurements and source-state evidence remain recoverable there; do not restore those unused values into production as routine maintenance.

Additive migrations `20261001164408` and `20261001170624` retain all 400,341 original Added strings and the existing runtime relation name/access, while removing unused legacy payload and physical dropped-column padding. The first migration refuses populated data without a restore-verified archive hash and exact two-relation fingerprints in the `vaultshuffle.legacy_archive_*` operator settings. These are one-off operator inputs, not application settings or an automated purge. Empty fresh installations replay normally. Historical migration files remain immutable; older phase-specific preservation fixtures target their original schema phase.

Measured storage fell another **291,384,467 → 249,466,003 bytes**, saving **41,918,464 bytes**. [Library cleanup acceptance](../database/v2/final-library-storage-cleanup-20261001.json) records the archive and actual validation. Across the two post-launch cleanups, V2 went from 469.3 MB to 249.5 MB (46.8% reduction); that is not a like-for-like comparison with the smaller, earlier V1 snapshot.

Use the latest measured storage receipt as the baseline. Routine statistics/maintenance may be useful after substantial churn; repeat index rebuilds or heap rewrites only with a measured reason. Repository cleanup does not reclaim live database storage.

See [completion status](v2-execution-status.md), [architecture](database-architecture.md), [worker policy](nightly-workers.md) and [final acceptance](../database/v2/final-cutover-acceptance-20261001.json).
