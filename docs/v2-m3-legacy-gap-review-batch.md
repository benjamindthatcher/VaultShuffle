# Bounded review: three legacy preservation gaps

11 September 2026. This second Claude thread is a **read-only design/review**
batch at **Sonnet 5 / High** because it decides how source facts survive stricter
target constraints. The primary Sonnet5/Medium thread owns implementation of
library/family/history, commitments/collections/draws, and catalogue corrections.
Do not edit its files or spawn native subagents. Root retains final decisions.

Read the current concise `docs/v2-execution-status.md`, plan sections5.2/5.3,
13/14, and the library contract/checkpoint and integration harness. The last
worker run reports 121 unit tests, strict TS/lint and **25 real PG17 constraint
tests** passing, including expected rejection tests for these cases. This
proves synthetic representability gaps, not their presence in a real snapshot.

## Questions to resolve

1. Wishlist tombstones have no proven access-loss instant. Transform emits
   `access_lost_at=NULL`, `loss_reason='unknown'`, `retired_origin='wishlist'`.
   `app.retired_library_games.access_lost_at` is NOT NULL/default now; reason
   accepts complete_snapshot/manual/unknown. Do we truly need a new origin
   column, or is the source origin already preserved durably elsewhere? Do not
   conflate origin with reason. Plan14.2 requires retired measurements, not
   invented prior ownership or a fabricated loss date.
2. Activity with useful last-played/minute evidence can lack
   `user_games.last_observed_played_at`; `app.game_activity.observed_at` is NOT
   NULL/default now. Verify actual legacy writer meanings and all available
   evidence timestamps before calling this an unavoidable gap. Observation
   receipt time and the last-played instant are different facts. If no source
   observation time is provable, recommend the smallest lossless representation
   compatible with the plan and future runtime queries. No wall-clock substitute.
3. A completion with `undone_at < occurred_at` is rejected by both
   `app.completion_events` and `app.unknown_completion_history`. Establish whether
   source schema permits this. Recommend preserving exact event identity,
   occurred/undone status and raw times without silently making it active,
   clamping/reordering the facts or discarding it. Preserve normal runtime
   invariants; avoid creating a broad new history subsystem for a rare anomaly.

## Return and limits

Own only `docs/v2-m3-legacy-gap-review.md`. Return a concise decision table,
specific source/target line references and evidence, recommended smallest
physical/transform/loader changes where truly necessary, and meaningful
acceptance tests. Distinguish an actual source observation, a valid-schema
synthetic case and an impossible input; do not manufacture a real-data claim.
Use one coherent recommendation per case with tradeoffs only where material.
Escalate to root if a product/architecture decision is unavoidable.

No code/SQL edits, remote queries, source exports/auth changes, credentials,
target mutations, commits, package changes or duplication of the first thread's
validation. Do not independently rerun its suite for reassurance. Applied
M1/M2/M3 SQL is immutable, M3 SHA256
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.
Any recommended physical change is a later **new** migration for root review;
none is authorized to apply in this batch. Work autonomously and stop with the
completed recommendation/checkpoint. Do not read the historical 61KB ledger
unless a specific unresolved historical decision requires it.
