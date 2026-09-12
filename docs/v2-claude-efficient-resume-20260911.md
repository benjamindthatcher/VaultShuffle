# Claude continuation — 11 September 2026, 10:31 UTC

This handoff supersedes the earlier three-agent / Opus / Ultracode / max
strategy and all earlier ownership banners. The user now prioritizes lowest
cost and latency consistent with correctness. Claude has usage again.

## Current execution policy

Claude is the primary worker while allowance is available. Use one Claude
thread by default, at most two for distinct useful purposes. Do not spawn
native subagents. Choose model and effort per batch: cheaper low/medium for
simple work, capable medium for normal implementation, stronger/high only for
complex architecture, concurrency, RLS/security or data-integrity decisions.
Highest model/effort requires an actual need. No duplicate reassurance reviews
or consensus loops. Codex fallbacks follow the same dynamic policy; old max
Luna instructions are superseded. Root retains cross-domain decisions and
milestone signoff. Work in substantial autonomous batches and checkpoint before
limits; report completion/blockers, not routine activity.

This existing Claude thread is set to **Sonnet 5 / Medium** for bounded pure
implementation and test completion. Request a targeted escalation when a
specific unresolved high-risk decision requires it, with evidence and affected
contract. Do not revive the old native agents or auto-continue their prompts.

## Ownership and current facts

All three Codex workers are stopped: catalogue returned, the other two hit
allowance limits. There is no overlapping implementation. This one Claude
thread now owns `library*`, `family*`, `history*`, `collections*`,
`commitments*`, `draws*` under `lib/v2/migration/transform/`, their tests and
paired domain contracts/checkpoints. Complete the two unfinished batches
sequentially from disk. Root owns catalogue review and execution ledger.

Catalogue/game worker returned 128 passing tests (34 games, 68 catalogue,
26 exact values), strict TypeScript/lint and prior actual PG output checks.
Leave `games*`, `catalogue*`, identity/scalars/sessions/capabilities and
`database/v2/migration/**` stable unless a concrete integration issue is
reported to root. Manifest/probe gate is 120 tests; destination index 92 applied
relations / 991 columns. Final-load intentionally fails on 1 source column and
5 relation decisions pending snapshot/cutover evidence.

M1/M2/M3 migrations are applied and **immutable**. M3 file is
`database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql`,
SHA256 `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.
Root accepted target schema, grants/RLS and transactional fixture cleanup:
92 tables / 991 columns, zero browser private privileges, zero surviving
accounts/games/runs. Evidence `database/v2/m3-target-validation-20260911.json`.
No repeated remote verification or migration apply is needed. Advisors remain
pending tool availability. New physical gaps require a new reviewed migration.

## The batch to finish

1. Read the current library checkpoint and M3-F assignment, inspect current
   owned files including `library-constraints.integration.ts`. Latest verified
   unit suite was 121 tests with targeted strict TS/lint. Finish the actual local
   PG17 output/constraint gate and return exact blockers. Three reported cases
   need concrete evidence: wishlist access-loss timestamp/reason, missing
   activity observation time, completion undo predating occurrence. Preserve
   the source facts; do not manufacture a clock or silently erase a row to
   satisfy target constraints. Report whether each case is a genuine physical
   gap, transform error, or explicit loader-policy decision. Do not edit SQL.
2. Complete M3-G from `docs/v2-m3-g-commitment-transform-batch.md` and current
   files. `collections.ts`/test, `commitments.ts`/test, `draws.ts` and shared
   module exist. The checkpoint's old claim that only the shared file exists
   is historical and must be corrected. Draw tests and final owned validation
   remain unfinished. Consume the shared account/GameMap/library-row-map APIs,
   preserve tenant ownership, exact measurements and distinct selection,
   impression/action facts. Run meaningful domain tests, targeted strict TS/
   lint, and a synthetic PG17 constraint gate. Then run the combined pure
   transform tests once to catch interface integration errors.

Do not repeatedly re-read large accepted modules or rerun earlier gates without
a changed dependency. Fix routine implementation/debugging autonomously; bank
actual test totals, file paths, commands and remaining blockers in each domain
checkpoint. End with a compact completed return and notify root via the existing
coordination path if available. Do not claim M3 or overall work complete.

## Boundaries

Repository `/Users/benthatcher/Documents/GitHub/VaultShuffle`, branch
`codex/v2-architecture`, latest observed HEAD `b51dcd163a923bba0315dac125fa7d945690d4e9`.
Preserve dirty files and user footer commits. No commits, pushes, production
writes, remote queries/loads, source credential/auth actions, provider activation
or deployment. Local synthetic tests authorized. PG17 binaries are read-only at
`node_modules/.cache/vaultshuffle-pg17-20260910`; use a dedicated disposable
data directory/socket/port, never disturb sibling evidence clusters. Root
retains source snapshot prerequisites, architectural decisions and approvals.

The Ireland/Virginia databases both use UTC; preserve exact microseconds and
civil dates, never apply a geographic offset. Dated source audits are not the
real consistent export or source-value parity. Remaining later work includes
provider/duration/config/support/ops transforms, staged loader, real export and
per-account parity/storage gates. M3 is the first incomplete milestone.
