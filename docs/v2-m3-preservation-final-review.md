# Root completed review: preservation follow-up corrections

The 125-unit / 26-PG-test return is saved in the follow-up checkpoint. The
retired-family access fix and segregated completion exceptions are good
directions, but the following prevent acceptance. This is a bounded correction
of reproduced/code-visible failures, not a request to redo the whole review.
Use **Opus 5 / High** for this concrete data-integrity correction batch. Root
has supplied the specific defects and acceptance cases. No native subagents.

1. **The proposed loss-time exception is too broad.** The binding batch allows
   NULL access_lost_at only for source Wishlist + unknown loss reason. The
   proposal instead permits any nonnull legacy_ownership, including Owned.
   Require exactly Wishlist with a NULL-safe boolean expression. Test Owned,
   NULL, Wishlist, invalid literal, and runtime reasons. Keep the existing
   runtime default and nonnull behavior outside the authorized legacy case.
2. **Distinct recency facts still expire.** library.ts saves divergent raw
   last_played_at only in migration.legacy_library_evidence.evidence and marks
   the row otherwise loadable. That staging is purged 30 days after cutover;
   it is not lasting preservation as required by the binding batch. Preserve
   distinct raw/observed play facts in the smallest sparse durable destination
   (extend the local proposal only where needed), or produce an explicit
   exception blocking final load until a durable disposition exists. Do not
   claim a writer invariant as a source-schema guarantee. Include one-null and
   inverted as well as unequal-nonnull cases; don't silently replace either
   raw source timestamp with the other.
3. **Baseline suppression lacks an ownership/destination proof.** The branch
   `else if (observedMinutesTarget !== null)` in library.ts marks baseline-only
   suppression resolved with destination app.library_games for every source
   row. Wishlist and family rows do not enter that table. Suppression must
   identify the actual durable destination for this row, or remain a blocking
   exception. Do not drop the only source metric under a false redundancy
   claim. Likewise ensure family metrics cannot become personal game_activity
   simply because a family row has nonnull minutes; preserve uncertain source
   attribution separately rather than assign lender data to the account.

Own only the same preservation files and SQL proposal as the prior batch.
Catalogue/game/M3-G modules and all applied migrations remain read-only.
Check the related exception accounting and privacy/deletion behavior once as
part of the finished correction. Any nonempty exception must be visible to
the later loader's pre-commit gate; no raw values in diagnostics/chat.

Tighten the SQL proposal's constraint replacement to the known frozen
constraint definitions/names and fail on drift instead of guessing through
broad text matches. Update stale claims in the proposal/checkpoint/contract
(for example, the proposal currently describes two new columns but adds one).
Run focused regressions, strict TS/lint and one fresh local PG gate with the
proposal, preserving all earlier meaningful cases. Return exact results and
any remaining blockers. No remote operations, SQL apply to the target, source
access/auth changes, commits or deployments. Stop after the completed batch;
root will review once it finishes.
