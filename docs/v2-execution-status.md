# V2 completion status

Updated 1 October 2026. The coordinated release is complete and production uses Virginia V2 (`vbjtbwelnhbbdfrqczyf`). The user reports that V1 has been deleted. Do not attempt another source export, transfer, source unfreeze or V1 rollback.

## Accepted release

All seven selected groups are live: database/Blacklist/HLTB, Wishlist/regional prices, Purple/stationary controls, landing/public pages, profile simplification, Dashboard/Library/Playing Next, and Vault/recommendations. The optional legacy logging patch and redundant worktree copies remain excluded.

- All 46 source domains were accounted for; 97 relation fingerprints and 29 sequence heads matched the final copy.
- 743 accounts, 812 sessions and 4,362 Blacklisted states transferred. All eight stale libraries were refreshed completely, including an 11,335-game library; authored state was unchanged before opening.
- At acceptance, V2 had 408,519 owned-library rows and 29,488 catalogue games. These totals can change with normal production use.
- All 26 launch migrations are applied. Original SQL remains immutable. Existing-session and public/product checks passed; app/worker access and TLS were verified. Two subsequent library-storage migrations were applied after the cleanup described below.
- Compaction reclaimed 14,303,232 bytes, leaving 469,175,443 database bytes at acceptance. The current-chain backup was actually restored and its fingerprints, sequences and ACLs verified.
- IGDB settings were removed from Vercel Production and Preview after explicit approval. The final cleanup deployment `dpl_AcAFXP69KdKHmm427mN1k42To4fJ`, commit `74f482c90de574db75078740e1e645e4bb78b2de`, was READY and passed public health checks.

Machine-readable proof: [final acceptance](../database/v2/final-cutover-acceptance-20261001.json) and [compaction](../database/v2/final-compaction-audit-20261001.json). The receipt's source-fence section describes the state at cutover, before the user deleted V1.

## Setup cleanup

The one-off export, source-freeze, transform, staging/load and manifest tooling has been removed, together with obsolete source snapshots, audit probes, proposals, rehearsal packets and milestone checkpoints. Runtime code and database regression tests remain. Earlier execution history is recoverable from Git through `74f482c`; it is no longer the current task list.

Removed 159 tracked one-off setup files. All 26 migration checksums remained unchanged. Retained V2 regression tests passed 181/181, including disposable PostgreSQL checks; typecheck, lint and theme checks passed (38 existing lint warnings, zero errors). Removed the obsolete agent-wait block from the Supabase config; public-only API schema exposure and PG17 settings remain unchanged. The stopped final-load cluster and redundant final replacement packet were also removed, reclaiming 2392051712 local disk bytes; protected source exports and backup/restore proof were retained.

Protected backups and final proof remain local and untracked. The accepted V2 backup is retained under `data/private/v2-backups/20261001/`. It contains private account/session/game data: do not commit, publish or upload it casually. The user's local server on port 8766 and unrelated worktrees/patches remain untouched.

## Remaining normal operation

Keep `VAULT_DATABASE_AUTHORITY=v2`, `VAULT_MAINTENANCE=0` and `VAULT_CUTOVER_WORKERS=0`. Preserve existing session, cron and Steam secrets. Use V2 backups for recovery.

The user subsequently approved immediate local archival and removal of unused migration data. On 1 October, **864,425 temporary rows in 18 staging tables** were downloaded to protected `data/private/v2-cleanup/20261001/staging-archive/`, restored locally and verified by exact fingerprints, then cleared from production in the tested guarded transaction. No CASCADE, identity reset, schema change or live-domain deletion was used. Staging rows are now zero; all core live counts were unchanged (743 accounts, 813 sessions, 408,519 Library rows, 20,490 game-state rows and 29,488 games).

This supersedes the original 31 October wait for those archived rows. Storage dropped **469,257,363 → 291,384,467 bytes**, reclaiming **177,872,896 bytes** (~178 MB). Home, releases and guest API health checks passed. The applied migration files remain unchanged. [Cleanup acceptance](../database/v2/final-staging-cleanup-20261001.json) records the exact allowlist, archive hash and actual validation. Required user history and personal measurements remain live.

## Library storage cleanup

The subsequent `user_games` audit found that the compact 27.5 MB ownership table was accompanied by a 74.4 MB legacy measurement relation. Only its original Added strings were read by the runtime. At the user's request, both full legacy measurement relations (422,360 rows total) were archived locally and actually restored with foreign keys and exact fingerprints before simplifying production.

Additive migrations `20261001164408` and `20261001170624` retain the existing account/AppID/date relation name and owner-only reads, remove unused measurement/provenance columns, clear the unused 22,019-row source-state copy, and rebuild the date heap without dropped-column padding. All **400,341 original dates** remain exact text, with no timezone conversion. Current ownership, state, activity and authored history are unchanged by the cleanup. The protected 3.98 MB archive is in `data/private/v2-cleanup/20261001/legacy-library-archive/`; keep it out of Git and public uploads.

Storage fell **291,384,467 → 249,466,003 bytes**, reclaiming another **41,918,464 bytes** (~41.9 MB). The retained date relation is 36.8 MB; its original name remains for compatibility. Cumulative measured V2 cleanup saved **219,791,360 bytes (46.8%)** against the 469,257,363-byte staging baseline. This does **not** demonstrate a 50–75% whole-database reduction against V1: the old 234 MB snapshot had fewer accounts/library rows.

Archive restore, byte-exact date preservation, dependency refusal, rollback, core fingerprints and access checks passed. The V2 suite passed 189/189 before the final heap rebuild; all 101 repository integration tests passed with the final chain, and typecheck passed. Public routes and the existing signed-in Library worked after cleanup. An unintended browser completion during verification was reactivated; original section counts were verified (320 active, 2 Blacklisted, 36 completed), with the temporary claim undone and no Vault current-game clear. [Library cleanup acceptance](../database/v2/final-library-storage-cleanup-20261001.json) records the exact hashes and measurements.

See [database architecture](database-architecture.md) and [operations/recovery](v2-cutover-runbook.md). No migration milestone remains open.
