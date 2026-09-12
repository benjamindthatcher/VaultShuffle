# Completed root catalogue boundary review — 11 September 2026

The returned 128-test catalogue/game batch is close to acceptance. Root reviewed
the exact-value scanner, complete-union numbering, source-column handling,
sighting reconciliation, deterministic offer joins and explicit loader gates.
Three concrete boundary defects reproduced using only synthetic local values:

1. `transformCatalogue` accepts a stub whose GameMap entry says
   `source_kind: 'catalog_games'`, then emits `source_kind: 'stub'`. It also does
   not check the inverse provenance disagreement for a catalogue source row.
   Require each emitted row's source kind to agree with the validated same-run
   map entry. Do not add a per-row linear scan.
2. `transformCatalogue` accepts a copied stub record with `title: null` and
   emits a supposedly valid target game with that title. The builder validates
   stubs, but the public transform's boundary accepts external records and
   currently only checks AppID, game ID and snapshot. Validate the published
   stub shape/title/normalization/provenance at consumption, preferably reusing
   the existing rule. Valid built stubs must retain exact text and behavior.
3. `games.ts` caches validated maps by object identity even when mutable. Root
   copied a built map, looked up AppID70 as game1, changed its entry to game22,
   and the lookup still returned1. The serialized map then disagrees with
   emitted joins. Only cache a fully immutable graph (root, run identity,
   entries array and each entry), or use another explicit immutable boundary;
   mutable external maps must be revalidated without stale cached IDs. Preserve
   O(1) repeated lookup for normal frozen builder results. Do not silently
   mutate a caller's map to obtain immutability.

All three reproduced under `node --experimental-strip-types --input-type=module`
with `buildGameMap`, `lookupGameId` and `transformCatalogue`, a synthetic stub
AppID70 and run `root-catalogue-review`. No source or target query occurred.

Add focused regressions for these observed failures, run the three owned
catalogue suites, targeted strict TS/lint, and return exact totals. Existing
physical SQL and all other domains are immutable/read-only in this follow-up.
Update the catalogue contract's statement that game identity stays out of the
source record: the actual output includes deterministic `id`, while offers and
review decisions use loader-generated IDs. Retain the existing loader identity
override/sequence gate and clarify that a stub's absent source `updated_at`
requires omission/default bookkeeping in the loader, not a literal NULL into a
NOT NULL target column. These are loader requirements, not source timestamps.

Ownership: root has finished this review and performs no implementation here.
Claude may take `games*`, `catalogue*` and their paired tests/contract/checkpoint
for this bounded correction after its current two domain batches. No second
reviewer or model escalation is required for these concrete local fixes.
