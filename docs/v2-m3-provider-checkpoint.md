# M3-H provider/legacy-catalogue evidence transform checkpoint

Status: bounded implementation complete for the owned M3-H scope, executed
autonomously in one Sonnet 5 / Medium batch, no native subagents. Both parts
of the handoff (`docs/v2-m3-h-provider-transform-batch.md`) are done: the
cache performance follow-up on `games.ts`, and the nine remaining
provider/catalogue source relations.

## Part 1: the cache performance follow-up

`indexGameMap` (`games.ts`) checked `isFullyFrozenGameMap` — an O(entries)
scan — before consulting `INDEX_CACHE`, so a cache HIT cost as much as a
miss. Fixed by checking the cache first unconditionally; the frozen-graph
check now runs only on a miss, at most once per distinct frozen map object
(safe because `Object.freeze` is irreversible). Added a deterministic
regression, no timing threshold: `a cached frozen map's repeated lookup does
not rescan entries` (`games.test.ts`) wraps the entries array in a `Proxy`
that counts indexed reads and asserts the count stops growing after the
first `lookupGameId` call across 50 further repeated lookups on the same map
object. Full account in
[`docs/v2-m3-catalogue-checkpoint.md`](v2-m3-catalogue-checkpoint.md).

* `node --experimental-strip-types --test lib/v2/migration/transform/games.test.ts lib/v2/migration/transform/catalogue.test.ts lib/v2/migration/transform/catalogue-values.test.ts` — **143 passed, 0 failed.**

## Part 2: the nine remaining relations

Three new modules, following the same pure/typed/stable-error-code discipline
as `catalogue.ts` and reusing its shared vocabulary rather than duplicating
it:

* [`provider-shared.ts`](../lib/v2/migration/transform/provider-shared.ts) —
  the `ProviderTransformError`/`ProviderErrorCode` type, run-identity
  validation, scalar/text/enum/array/JSON readers (thin wrappers over
  `scalars.ts` and `catalogue-values.ts`), and the shared
  `ReviewDecisionTargetRecord` shape both `catalog_game_quarantine` and
  `catalog_duration_reviews` write.
* [`catalogue-provenance.ts`](../lib/v2/migration/transform/catalogue-provenance.ts) —
  `transformGameQuarantine`, `transformIngestQueueArchive`,
  `transformSeedRuns`, `transformGuestCataloguePool`.
* [`duration-provider.ts`](../lib/v2/migration/transform/duration-provider.ts) —
  `transformDurationEstimates`, `transformDurationAliases`,
  `transformDurationReviews`, `transformDurationImportRuns`,
  `transformDurationJobArchive`.

All 95 source columns across the nine relations are accounted for: written to
a target column, or named in `INGEST_QUEUE_RETIRED_SOURCE_COLUMNS` /
`DURATION_JOBS_RETIRED_SOURCE_COLUMNS` with the surviving fact. Full
disposition table and the mandatory-versus-optional game-map resolution rule
are in
[`docs/v2-m3-provider-contract.md`](v2-m3-provider-contract.md).

Notable transform decisions, each recorded in the contract:

* `catalog_game_quarantine.last_detected_at` (a third instant the target has
  no column for) is named explicitly inside `review_decisions.source_payload`
  rather than dropped.
* `catalog_duration_reviews` has no `created_at`; the review's own
  `reviewed_at` — an already-validated real source value — is reused rather
  than a wall-clock instant being invented.
* `guest_catalogue_pool` has no migration destination at all. The transform
  returns one aggregate coverage record (counts and bounds), never a per-row
  array, so it cannot become an accidental retention path for a relation
  explicitly told it has none.
* Both `catalog_ingest_queue` and `game_duration_jobs` archive only earned
  failure/rejection history; in-flight work (leases, retry schedules,
  scheduling priority) is retired, matching plan 14.2's "queues are rebuilt,
  not resumed."

### Evidence

* Owned pure-transform suites, run together once:
  `node --experimental-strip-types --test lib/v2/migration/transform/catalogue-provenance.test.ts lib/v2/migration/transform/duration-provider.test.ts`
  — **40 passed, 0 failed.**
* Combined cross-domain gate (every M3 domain's `*.test.ts` in one run):
  `node --experimental-strip-types --test lib/v2/migration/transform/*.test.ts`
  — **480 passed, 0 failed.**
* `npm run typecheck` — clean across the whole project.
* `npx eslint lib/v2` — clean.
* One synthetic PG17 constraint gate,
  [`provider-constraints.integration.ts`](../lib/v2/migration/transform/provider-constraints.integration.ts),
  run against a fresh disposable cluster with M1+M2+M3 replayed
  (`node_modules/.cache/vaultshuffle-m3h-20260911-data`, socket
  `/tmp/vs-m3h-20260911`, port `55485`, user `vsm3h`, database
  `vaultshuffle_m3h`) — **14 passed, 0 failed.** It proves: every relation's
  typed output is accepted by the real applied schema
  (`catalog.duration_estimates`, `catalog.duration_aliases`,
  `catalog.review_decisions` in both decision kinds, `catalog.duration_imports`,
  `catalog.seed_runs`, `migration.legacy_duration_job_archive`,
  `migration.legacy_ingest_queue_archive`); four of the CHECK constraints this
  domain's TypeScript already enforces are also real, independent of the
  transform, via a raw adversarial insert (`(steam_app_id, provider)`
  uniqueness, the `response_kind`/`source_url` pairing, `seed_runs`
  accepted-above-requested, `duration_imports` completed-before-created); and
  deleting a `catalog.games` row detaches every dependent row via
  column-specific `SET NULL`, never a cascade delete. The cluster was stopped
  afterward (`pg_ctl ... stop -m fast`).

### A drive-by finding, not fixed (out of scope this batch)

While reading `library-shared.ts` to reuse its `indexAccountMap` (the same
account-map indexer `commitments-shared.ts` already reuses for the M3-G
domain), its `ConflictCollector.record` method was found to contain a raw
embedded NUL byte used as a composite-key delimiter — the same class of bug
found and fixed in `library-constraints.integration.ts` during the prior
catalogue-review batch. It makes `file(1)`/non-`-a` `grep` treat the source
file as binary; it does not affect JS runtime behavior. `library-shared.ts`
is explicitly out of this batch's ownership (root's handoff: "No
library/family/history/M3-G edits" — a separate concurrent thread owns
library preservation fixes), so it was left untouched and is reported here
for whichever thread next owns that file.

## Boundaries respected

No SQL file was opened for writing (migration hashes verified unchanged
below). No remote query, export, credential/auth action, provider activation,
or deployment occurred. No native subagents were used. No file outside
`games*`, `catalogue*` (cache follow-up only) and the new
provider/duration/catalogue-provenance modules, tests, contract and this
checkpoint was modified.

```
54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389  20260906093036_m1_private_foundation.sql
f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba  20260907163356_m2_jobs_quota_publish.sql
605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a  20260910232654_m3_preservation_schema.sql
```

## Remaining gates (outside this batch's scope)

Root's own physical-contract sign-off on the applied target, real
consistent source-data export/snapshot, per-account parity/reconciliation,
the staged loader, and measured storage gates all remain outstanding for the
overall M3 milestone — unchanged by this batch and not claimed here.
