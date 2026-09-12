# M3-H: remaining catalogue/provider evidence transforms

One Claude implementation thread, **Sonnet5 / Medium**, no native subagents.
Continue from the current concise execution ledger and stable shared map,
scalar and exact-value interfaces. Root handles preservation migration review
in the other thread; these domains do not overlap.

## First: finish the catalogue cache correction

Root reviewed the 142-test return. `indexGameMap` calls
`isFullyFrozenGameMap` before checking INDEX_CACHE; that helper scans every
entry on every lookup, making the promised frozen-map O(1) path O(N) again.
Check the cache before rescanning eligibility. Only immutable validated graphs
enter the cache already, so cached entries can safely return immediately.
Mutable maps must still revalidate. Add a deterministic regression that proves
repeated frozen-map lookup does not iterate entries (avoid timing thresholds),
then run the owned catalogue suite. No other catalogue redesign is needed.

## Main batch

Implement pure typed transforms for the remaining source catalogue/provider
relations under disposition files `03-catalogue.json` and
`04-duration-provider.json`:

- game_duration_estimates, game_duration_aliases, catalog_duration_reviews;
- catalog_game_quarantine;
- catalog_ingest_queue, game_duration_jobs (terminal facts and bounded archive,
  not live resumption of old leases);
- catalog_seed_runs, catalog_duration_import_runs;
- guest_catalogue_pool: explicit deterministic rebuild input/disposition with
  coverage accounting, not retention of a canonical whole-library array.

Use the actual immutable M1/M2/M3 physical contract and the per-column
dispositions, not historical comments claiming those target tables are absent.
Relevant plan sections5.4,7,13,14 and docs/v2-m3-b-database-batch.md govern.
All 95 source columns in these nine relations require an explicit accounted
destination, rebuild/archive disposition or stable blocker. Prefer a small
number of cohesive modules and shared existing helpers over boilerplate.

Preserve exact AppIDs/provider IDs, integer minutes, decimal/JSON precision,
NULL versus zero, confidence labels/sample counts, aliases, status/errors,
reviewer and manual-override provenance. Catalogue identity does not confer
access. Provider observations, derived winner and human decisions remain
separate; follow recorded classification/quarantine precedence and existing
resolver semantics. Do not invent a provider, timestamp, probability, lease or
manual attribution to fit the target. Missing game maps may remain nullable
only where the physical contract permits, retaining the original AppID. Keep
useful terminal failures durable; old queues are evidence/rebuild inputs and
must not activate on preview. Raw evidence belongs in private bounded output.

Own new provider/duration/legacy-catalogue transform modules and tests under
lib/v2/migration/transform, their new contract/checkpoint, plus games* and
catalogue* only for the cache follow-up. No library/family/history/M3-G edits,
no SQL/manifest/index edits. Report concrete physical gaps to root rather than
change a schema or silently drop a source fact.

Acceptance: deterministic same-run outputs/count accounting under source-order
permutation; meaningful adverse cases for exactness, conflicting identities,
precedence, unknowns and unrepresentable target values; owned strict TS/lint;
one synthetic actual-PG output/constraint gate against immutable M1/M2/M3 on
an isolated disposable cluster. Reuse existing PG binaries/harness patterns,
never sibling fixtures. Do not repeat previously accepted domain gates unless
the cache change affects them. Bank exact completed commands/results and the
remaining physical/semantic blockers in docs/v2-m3-provider-checkpoint.md and
docs/v2-m3-provider-contract.md. Stop with a compact completed return.

No remote queries/export, credentials/auth changes, target apply/load,
provider activation, deployments, commits or native agents. M3 remains
incomplete until the actual export, loader and parity/storage gates pass.
