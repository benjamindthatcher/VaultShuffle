# Coordinated release record

All seven groups approved by the user were released together on 1 October 2026:

1. V2 database, permanent Blacklist and HLTB-only migration.
2. Wishlist and regional prices.
3. VaultShuffle Purple and stationary controls, retaining the approved original landing-page styling.
4. Landing preview, public pages/blog and release notes.
5. Profile flow simplification.
6. Dashboard, Library and Playing Next refinements.
7. Vault setup and recommendation refinements.

The optional legacy worker-logging patch was excluded and remains at `docs/release-candidates/worker-logging-diagnostics.patch`. Redundant old Wishlist/classifier/preview worktree copies were excluded. Those worktrees and branches were not reset, merged wholesale or deleted.

The final release/IGDB-settings cleanup commit was `74f482c90de574db75078740e1e645e4bb78b2de`, with READY deployment `dpl_AcAFXP69KdKHmm427mN1k42To4fJ` and healthy public routes. Production uses Virginia V2; V1 has since been deleted by the user. No further release selection is pending.

Historical branch comparisons and preparation notes remain in Git through that commit. See [completion status](v2-execution-status.md) and [the final acceptance receipt](../database/v2/final-cutover-acceptance-20261001.json).
