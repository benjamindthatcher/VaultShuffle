# Root decisions and preservation follow-up — 11 September 2026

The first Claude thread (Sonnet5/Medium) is finishing the three catalogue
boundary fixes. This second thread (Sonnet5/High) now owns the preservation
follow-up below: library/family/history transforms and paired tests/docs, its
own gap review, and a **new local SQL proposal with focused SQL tests**. No
overlap with catalogue or M3-G files. No native agents. Do not change applied
migrations, generated manifest/index or root ledger. Finish this coherent
batch autonomously, then return; root will review the completed results.

## Correct the review's unsupported claims first

Root verified that the review's claim “Wishlist items were never owned” is
false for this repository. `lib/steam-import-jobs.ts:195-221` demotes previously
Owned personal games absent from an import to Wishlist. The family removal
writer `supabase/migrations/20260901193000_share_a_family_library.sql:255`
also preserves authored rows as Wishlist. `lib/games.ts:65` explicitly skips
Wishlist because the feature was removed. Preserve the literal as legacy
provenance; infer neither “never owned” nor “definitely previously owned” from
that literal alone. A source-schema-valid case is not a measured real export.

Use the latest writer definitions, including
`supabase/migrations/20260831175217_add_steam_playtime_refresh.sql`, not just
the earlier August25 implementation. Neither the source schema nor dated
aggregates prove `recency_evidence_at` is non-null iff any other field exists.
The review also contradicts the actual transform: it currently maps target
last_played_at from `row.lastPlayedAt`, not `row.lastObservedPlayedAt`.
Remove unsupported claims and settle exact field semantics from actual code.

Dropping NOT NULL does not preserve the old non-null requirement for a subset
without a new CHECK. Avoid that false assertion in the review's SQL tests.
Do not relabel a loader's intentionally unresolved output as silent loss: the
final-load gate must refuse all unresolved exceptions before target commit.

## Binding preservation decisions

1. **Legacy retirement:** preserve source Wishlist as a literal, without
   invented prior ownership, loss reason or timestamp. `loss_reason='unknown'`
   remains valid; do not add Wishlist as a loss reason. Draft the smallest new
   migration allowing a null `access_lost_at` only for explicitly labelled
   legacy-Wishlist/unknown-reason evidence, while preserving the non-null
   requirement/default for normal runtime access loss. A nullable
   `legacy_ownership` source-fact column (`Owned`/`Wishlist`) is preferable to
   defaulting all rows to invented legacy ownership. Use a NULL-safe CHECK:
   SQL UNKNOWN must not accidentally allow an unlabelled null loss timestamp.
   Carry this new source label in typed output and loader contract. Preserve
   any distinct last-observed/last-played facts rather than borrowing a generic
   row-update clock for loss time.
2. **Family retirement:** the source family-removal writer proves that
   `ownership='Wishlist', access_source='family'` is a supported tombstone,
   not grounds to restore Family access. Preserve authored/history/legacy
   facts and source ownership/access origin, but emit no active
   family_game_access for it. Do not convert lender minutes to personal
   measurements. Add a regression based on that actual writer. If durable
   provenance needs a small additional column, include its concrete proposal
   and justify it; do not put the sole lasting evidence in 30-day staging.
3. **Recency:** receipt/evidence time is distinct from a last-played instant.
   Use the source `recency_evidence_at` where its writer proves that meaning,
   preserve the source kind, exact microseconds and actual precise/imprecise
   semantics. Never drop distinct source evidence simply because one time is
   null. Suppress only a provably redundant baseline activity record whose
   exact minutes already survive durably elsewhere, with explicit accounting.
   Review last_played_at versus last_observed_played_at divergence and preserve
   both distinct facts where they matter; do not pick one and discard the
   other as an optional “fidelity improvement”. Unexpected valid-source
   combinations remain an explicit exception/final-load blocker with exact
   private evidence. Do not fabricate a play-session interval from a receipt
   timestamp. Prefer transform fixes over schema changes unless unavoidable.
4. **Inverted completion clocks:** keep runtime ordering constraints. Emit a
   separate bounded typed exception stream carrying the complete exact event
   facts and same-run identity; omit those rows from active load arrays and
   registry so no dangling ID or accidental active completion is produced.
   Count every source event exactly once across loadable and exception paths.
   Nonempty exceptions **block final load/commit**, never count as successful
   parity or silently expire. The verified private export remains intact until
   resolved; if a real snapshot contains one, its durable disposition needs
   root review before M3 can pass. No new anomaly table is justified yet by the
   dated audit (0 of 13,157); future checks must run inside the real export
   snapshot, not as a separate HTTP audit claimed equivalent.

## Ownership, validation and return

Own `library*`, `family*`, `history*` under `lib/v2/migration/transform/` and
paired domain docs, `docs/v2-m3-legacy-gap-review.md`, plus
`database/v2/proposals/m3_legacy_preservation_followup.sql` and a paired local
SQL test file. Consume stable shared account/game/scalar contracts. Do not
edit `games*`, `catalogue*`, `collections*`, `commitments*`, `draws*`, any
applied SQL, package configuration, manifest/index or execution ledger.

Run meaningful focused regressions for the decisions above, owned strict
TS/lint, and one fresh isolated PG17 gate with immutable M1/M2/M3 followed by
the proposal. Check normal runtime rejection, explicit legacy acceptance,
NULL bypass, source fact round-trips, tenant/deletion behavior for any newly
stored personal facts, and exact event counts across exceptions. Reuse the
existing harness; do not create a new test framework or repeat earlier
unrelated gates. Bank exact commands and remaining blockers. No real source
query/export, target apply/load, auth mutation, provider activation, commits,
deployment or production change. The SQL remains a proposal until root
reviews the exact finished diff and decides its migration/apply gate.
