# M3-H provider/legacy-catalogue evidence transform contract

Status: bounded pure transform contract. The implementation reads accepted
`string | null` source cells and returns typed load records; it does not read
a source project, open a database connection, or apply a target migration.
The physical M3 schema is an input to this contract, not a claim that the
source has been exported or loaded.

The implementation is in
[`lib/v2/migration/transform/provider-shared.ts`](../lib/v2/migration/transform/provider-shared.ts)
(shared vocabulary),
[`lib/v2/migration/transform/catalogue-provenance.ts`](../lib/v2/migration/transform/catalogue-provenance.ts)
(quarantine, ingest-queue archive, seed-run provenance, guest-pool coverage),
and
[`lib/v2/migration/transform/duration-provider.ts`](../lib/v2/migration/transform/duration-provider.ts)
(duration estimates/aliases/reviews/import-runs, duration-job archive). All
three modules consume the same-run `GameMap` from
[`games.ts`](../lib/v2/migration/transform/games.ts) and, where a reviewer is
named, the same-run account map indexer from
[`library-shared.ts`](../lib/v2/migration/transform/library-shared.ts) —
neither map is rebuilt here.

## Scope: nine source relations, 95 columns, all accounted

| Source relation | Columns | Disposition | Target |
|---|---|---|---|
| `game_duration_estimates` | 16 | migrated | `catalog.duration_estimates` |
| `game_duration_aliases` | 7 | migrated | `catalog.duration_aliases` |
| `catalog_duration_reviews` | 7 | migrated | `catalog.review_decisions` (`decision_kind='duration'`) |
| `catalog_game_quarantine` | 14 | migrated | `catalog.review_decisions` (`decision_kind='quarantine'`) |
| `catalog_ingest_queue` | 16 | archive + durable terminal/lifecycle state | `migration.legacy_ingest_queue_archive`, `catalog.appid_terminal_rejections`, `catalog.provider_state` |
| `game_duration_jobs` | 11 | archive + durable terminal/lifecycle state | `migration.legacy_duration_job_archive`, `catalog.provider_state`, `catalog.appid_terminal_rejections` |
| `catalog_seed_runs` | 9 | migrated | `catalog.seed_runs` |
| `catalog_duration_import_runs` | 12 | migrated | `catalog.duration_imports` |
| `guest_catalogue_pool` | 3 | coverage accounting only | none |

16+7+7+14+16+11+9+12+3 = 95, matching the batch's stated column count. Every
column not written to a target has an explicit retirement entry
(`INGEST_QUEUE_RETIRED_SOURCE_COLUMNS`, `DURATION_JOBS_RETIRED_SOURCE_COLUMNS`)
naming the surviving fact, following `catalogue.ts`'s own
`CATALOGUE_RETIRED_SOURCE_COLUMNS` pattern. Three columns per queue
(`next_attempt_at`, `updated_at`, and for the queue also the terminal status
fields) moved OUT of those retirement lists in the 11 September durability
review and into the durable destinations below; each module now also exports a
`*_DURABLE_RETRY_COLUMNS` map naming where the fact went, so a retirement claim
and a preservation claim are both checkable.

## Game-identity resolution: mandatory versus optional

Every AppID resolves through the same-run `GameMap` (`lookupGameId`/
`hasGameId`/`gameMapEntryKind` from `games.ts`), but whether a miss is an
error depends on what the source itself guarantees:

* **Optional (a miss is a real, valid case, not a failure):** duration
  estimates (an estimate can exist for an app the catalogue never held),
  duration aliases (an alias exists precisely to rescue an app whose identity
  did *not* match), quarantine (a quarantined app is frequently absent from
  `catalog_games` by definition), and the guest pool's coverage count.
* **Mandatory (a miss is `provider_game_unmapped`):** `catalog_duration_reviews`,
  because the source enforces `steam_appid references catalog_games` — an app
  without a catalogue row cannot have a review row in a genuine export, so a
  miss here indicates a transform-boundary problem, not a real source state.

## `catalog.review_decisions`: two decision kinds, one precedence ladder

Both `catalog_game_quarantine` and `catalog_duration_reviews` write
`catalog.review_decisions`, reusing `catalogue.ts`'s
`CATALOGUE_DECISION_PRECEDENCE` ladder exactly as that module's own comment
anticipated ("The higher tiers are reserved, not implemented"):

* Quarantine: `precedence_rank` is `automatic_quarantine` (40) or
  `manual_quarantine` (70), keyed on the source's own `source` column
  (`'automatic'`/`'manual'`).
* Duration review: always `manual_duration_review` (90) — a hand-authored
  review is the highest tier a human can produce today.

`catalog_game_quarantine.last_detected_at` has no column of its own on
`catalog.review_decisions` (which has one `created_at`/`updated_at`, not the
source's three distinct instants). It is named explicitly inside
`source_payload` as `{"last_detected_at": "<instant>"}` rather than being
silently dropped or overwriting a real column.

`catalog_duration_reviews` has no `created_at` column at all — the review's
own `reviewed_at` is reused for `created_at` rather than a wall-clock instant
being invented. This is a real, already-validated source value moved into a
differently-named target column, not a fabrication; `decision_status` is
fixed to `'retained'` for every duration review since the source carries no
separate pending/approved workflow state, mirroring `catalogue.ts`'s own use
of the literal `'retained'` for its `catalogue_type` rows.

`reviewer_user_id` resolves through the same-run account map (nullable): a
review by a since-deleted account keeps `reviewer_account_id: null` rather
than being dropped, per the settled ruling that the shared decision outlives
the account.

## `guest_catalogue_pool`: coverage accounting, not row retention

The pool is a fully derived presentation cache with no migration destination
at all — the v2 guest surface rebuilds it from `catalog.games` after cutover.
`transformGuestCataloguePool` therefore returns ONE aggregate coverage record
(row/distinct/duplicate/mapped/unmapped counts and position/instant bounds),
never a per-row array. Retaining the row array would functionally re-create a
migration destination for a relation this domain has been told has none.

## Queues: rebuilt work, but durable terminal and backoff state

`catalog_ingest_queue` and `game_duration_jobs` are queues the v2 pipeline
rebuilds from current demand after cutover; in-flight work is never resumed.
The raw rows go to `migration.legacy_ingest_queue_archive` and
`migration.legacy_duration_job_archive`, which carry the shared
`staging-30d-post-cutover` retention class as a target default.

Root's 11 September durability review (`docs/v2-m3-codex-dispatch-20260911.md`,
batch A step 2) rejected the earlier "archive-only" reading: an archive that
expires cannot be the only home of a terminal verdict, and the earlier
retirement notes claimed a rebuild ("retry scheduling, rebuilt from
`tags_status`/`attempts` after cutover") that nothing performs. What actually
happens once the row is gone is readable in the source writers:

* `ensure_catalogue_entries`
  (`supabase/migrations/20260829224231_reparent_product_data_to_app_accounts
  .sql:157-172`) queues any requested AppID with **no `catalog_games` row** —
  which is exactly what a rejected AppID is, because the classifier refused to
  store it (`lib/catalogue.ts:206-238`). While the queue row exists, the
  `on conflict` branch keeps `status = 'rejected'` and the app is never
  re-fetched. Delete it and the next import inserts a fresh `pending` row at
  `attempts = 0`, and the fetch/classify/quarantine/reject cycle repeats
  permanently. `lib/catalogue.ts:167-177` records that this churn (~80 retries
  per entry) already happened once.
* `lib/duration-worker.ts` writes `failed` after `MAX_ATTEMPTS` (line 140-143),
  keeps the only record of effective backoff in a `retry` row's fence (line
  145), and writes `needs_review` verdicts such as `duration_not_found` or
  `known_title_no_provider_times` (line 117-127) that re-running cannot change.

So three durable destinations now carry what the archive cannot:

| Source | Case | Durable destination |
|---|---|---|
| `catalog_ingest_queue` | AppID **with** a catalogue row | `catalog.provider_state` (`evidence_kind='metadata'`) |
| `catalog_ingest_queue` | terminal (`rejected`/`failed`) on an AppID with **no** catalogue row | `catalog.appid_terminal_rejections` (`evidence_kind='ingest'`) |
| `game_duration_jobs` | AppID **with** a catalogue row | `catalog.provider_state` (`evidence_kind='duration'`) |
| `game_duration_jobs` | terminal on an AppID with **no** catalogue row | `catalog.appid_terminal_rejections` (`evidence_kind='duration'`) |
| `catalog_games.tags_*` scheduling | any catalogued app with tag evidence | `catalog.provider_state` (`evidence_kind='tags'`) |

The split is the physical schema's own: `catalog.provider_state.game_id`
references `catalog.games`, so it physically cannot hold a rejected identity —
which is why M3 created `catalog.appid_terminal_rejections` keyed by AppID, and
why the M3 comment on both staging tables says terminal verdicts are extracted
"before expiry". `catalog.games` keeps the descriptive half of the tags
lifecycle (source, status, fetched_at, failure_count, last_error) and
`catalog.provider_state` the scheduling half (`next_attempt_at`,
`processing_started_at`), which `catalog.games` has no column for.

Three rules constrain what is written there:

* **No invented provider attribution.** Neither queue records a provider — one
  row per AppID, with the worker choosing which provider to call — so both use
  the schema's own `'unknown'` (`UNATTRIBUTED_PROVIDER`). For tags,
  `tags_source` describes the last successful content and the current worker
  leaves it untouched when a refresh is queued or fails. A `ready` result may
  therefore use its real `tags_source`; pending, processing and failed attempt
  state stays honestly attributed to `'unknown'`.
* **No status invented to fit.** `retry` becomes `failed` **with its fence**
  (the only target status whose CHECK permits both a fence and a lease);
  `rejected` becomes `no_match`; a `needs_review` conflict awaiting a person
  becomes `review_required`, not a terminal rejection. A fence or lease is
  written only where the target CHECK allows it, and is otherwise left to the
  archive rather than forced into a column that would reject it.
* **No truncation of a verdict.** `reason` (5000) and `last_error` (2000) fail
  closed (`provider_text_bounds`) rather than storing a shortened rejection
  reason in the copy that outlives the archive. A verdict with no source text
  states the source facts (relation, status, attempt count) instead.

An uncatalogued nonterminal row with a live retry fence has no lossless durable
destination: `catalog.provider_state` requires `game_id`, while
`catalog.appid_terminal_rejections` accepts terminal verdicts only. The
transform raises `provider_physical_gap` for that exact case instead of letting
the fence expire with staging. It also blocks an uncatalogued `ready` ingest row
(contradictory to the writer that stores the catalogue row before marking
ready) and an uncatalogued nonterminal duration `needs_review` verdict. These
are counted final-load blockers if present in the real export; due rows without
a fence remain rebuildable work and in-flight leases are never resumed.

`catalog.provider_state` is per-game evidence and dies with its
`catalog.games` row (`on delete cascade`); the AppID verdict has no catalogue
row to die with and survives, which is the point of keying it by AppID. Both
behaviours are asserted in the physical gate.

## Exact value handling

Reuses the same scalar/array/JSON primitives `catalogue.ts` already relies on:
`parsePgTimestamptz`/`parseCivilDate`/`parsePgInteger` from `scalars.ts`, and
`parsePgTextArray`/`inspectJsonDocument`/`encodeJsonStringArray` from
`catalogue-values.ts` — so `catalog_game_quarantine.genres`/`categories`
(`text[]`) and every `jsonb` evidence/manifest column follow the identical
exact-preservation rules already proven for the M3-F catalogue domain: no
`Date`, no IEEE numeric conversion of bigint/JSON values, no silent repair.
An UNVALIDATED source enum (`catalog_game_quarantine.steam_type`,
`catalog_duration_import_runs.status`) is asserted against the target's
declared value domain at consumption rather than assumed, matching the same
value-domain discipline `catalogue.ts` applies to
`catalog_games.first_seen_reason`.

## The cache performance follow-up (11 September 2026)

Root's M3-H handoff flagged a remaining regression in `games.ts`'s
`indexGameMap`: the fix from the prior catalogue-review batch checked
`isFullyFrozenGameMap` (an O(entries) scan) *before* consulting
`INDEX_CACHE`, so a cache HIT cost as much as a miss. `indexGameMap` now
checks the cache first, unconditionally, and only runs the frozen-graph check
on a miss — safe because `Object.freeze` is irreversible, so a map already in
the cache cannot have un-frozen itself since it was cached. A deterministic
regression (a `Proxy` counting indexed reads, no timing threshold) proves a
cached frozen map's repeated lookup touches no entry after the first call.
See [`docs/v2-m3-catalogue-checkpoint.md`](v2-m3-catalogue-checkpoint.md) for
the full account; this module's tables above are unaffected by that fix.

## Errors

Every transform throws `ProviderTransformError` (`provider-shared.ts`) with a
stable `providerCode`, the source relation/field, and a count — never a
title, URL, payload, error message, or AppID/UUID value. A `GameMapError`
(unmapped/malformed identity) and an `AccountMapIndex`/`LibraryTransformError`
failure (unmapped/malformed reviewer) are converted to the domain's own codes
at the boundary exactly as `catalogue.ts` converts `GameMapError`.

## Required load gates (unchanged pattern, new relations)

The loader must still: bind one run identity across every map, row and
output; execute the `jsonb_typeof`/`pg_column_size` checks for `evidence`,
`manifest` and quarantine `genres`/`categories` (a pure transform can measure
UTF-8 text length but not encoded/possibly-TOASTed storage size); verify the
`(steam_app_id, provider)` uniqueness on `catalog.duration_estimates`; and
apply the identity-override/sequence-advance strategy already required for
every `generated always as identity` column this batch touches
(`catalog.duration_estimates.id`, `catalog.review_decisions.id`). Snapshot
consistency and final-cutover fencing remain separate gates this pure module
does not claim.
