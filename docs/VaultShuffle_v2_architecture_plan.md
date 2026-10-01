# VaultShuffle V2: delivered architecture

The V2 plan is complete. Production moved to Virginia project `vbjtbwelnhbbdfrqczyf` on 1 October 2026; V1 has since been deleted by the user. The 26 immutable launch migrations, additive storage follow-ups, current runtime and final acceptance receipts define the delivered implementation. This document is no longer a migration work queue.

The private `app`, `catalog`, `reco`, `ops` and `migration` domains remain the foundation. Shared game facts stay separate from personal ownership, activity and sparse authored state. Stable public IDs, existing session cookies, tenant access, Family semantics, collection membership, Wishlist and recommendation behaviour were preserved.

Library Blacklist is permanent and undated, with manual reactivation. Vault snoozes remain separate. Validated HLTB plus human overrides supply durations; IGDB data, workers and hosted settings are retired. Missing durations remain unknown.

The current app uses verified TLS, parameterized repositories, small transaction pools and non-owner app/worker roles. Forced RLS, compound foreign keys and session-derived tenant context enforce ownership. Complete imports are bounded, atomic and fenced; provider quota/cooldown state is retained. No runtime depends on the removed one-off migration tooling.

Post-launch cleanup archived unused transfer and legacy preservation values locally after actual restore verification. The Library retains original Added strings in its compact existing relation; current ownership, playtime, authored state and history stay live. Measured V2 storage fell from 469.3 MB to 249.5 MB (46.8%). The original 50–75% whole-database V1-to-V2 target was not demonstrated; the earlier V1 snapshot had fewer accounts and games. See the [Library storage acceptance](../database/v2/final-library-storage-cleanup-20261001.json) for exact scope and measurements.

The approved release also includes Wishlist/regional prices, VaultShuffle Purple and stationary controls, the original landing-page exception, public pages, simpler profile flow, Dashboard/Library/Playing Next refinements and Vault/recommendation work. No redesign or additional Blacklist state was introduced.

See [current architecture](database-architecture.md), [completion status](v2-execution-status.md), [operations and recovery](v2-cutover-runbook.md) and [release record](v2-release-inventory.md). Future schema work uses additive migrations. Historical setup code and plans remain recoverable from Git through `74f482c`.
