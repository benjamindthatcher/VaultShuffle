# M3-F catalogue and game transform checkpoint

Status: bounded implementation complete for the owned catalogue/game scope.
The transform remains pure: it does not read the source project, open a remote
connection, apply SQL, or claim export, snapshot, parity, cutover, or M3
completion.

The shared `GameMap` contract in
[`docs/v2-claude-domain-transforms.md`](v2-claude-domain-transforms.md) is
implemented in `games.ts`: exact canonical AppID text, complete-union numeric
ordering, explicit same-run identity, labelled stubs, duplicate/missing
reference failures, and throwing lookup for null or unknown identities.

`catalogue.ts` now covers every `catalog_games` source column. It emits games,
metadata, features, sightings, US offers/prices, legacy classification
evidence, and reconciliation records. Developer/publisher values are preserved
with target bounds. The optional dedicated `catalog_game_sightings` input is
checked against the duplicated catalogue count and seen instants; sighting-only
AppIDs retain a nullable target game identity. Retired creation/retry
timestamps are still parsed before rebuild, and source NOT NULL integer facts
cannot become target NULLs.

`catalogue-values.ts` preserves PostgreSQL array shape and SQL NULL elements,
scans JSON without IEEE numeric conversion, and measures configurable text
bounds in PostgreSQL characters. Required JSONB storage checks are returned as
loader gates because a pure transform cannot prove `pg_column_size`.

Validation completed on 10–11 September 2026:

* `node --experimental-strip-types --test lib/v2/migration/transform/games.test.ts` — 34 passed.
* `node --experimental-strip-types --test lib/v2/migration/transform/catalogue.test.ts` — 68 passed.
* `node --experimental-strip-types --test lib/v2/migration/transform/catalogue-values.test.ts` — 26 passed.
* The combined owned transform command (`games.test.ts`, `catalogue.test.ts`,
  and `catalogue-values.test.ts`) — 128 passed.
  The parser rejects lone Unicode surrogate escapes and accepts a valid pair,
  matching PostgreSQL JSONB input.
* Owned transform strict TypeScript compilation — passed.
* Owned ESLint over `games*`, `catalogue*`, and `catalogue-values*` — passed.
* Disposable PG17.6 database `vaultshuffle_m3_catalogue_20260910` replayed the
  immutable M1/M2 and current M3 migrations. Generated transform rows inserted
  into games, metadata, features, sightings, offers, prices, and review
  decisions; the result was `catalogue-transform-pg17-ok` with 1 row in each
  destination, plus `jsonb-precision-ok` and `digest-shape-ok`. Four bounded
  adversarial inserts produced `developer-bound-check=pass`,
  `weighted-tags-shape-check=pass`, `offer-price-order-check=pass`, and
  `sighting-digest-shape-check=pass`. The cluster was private Unix-socket-only
  and disposable.
* The pre-applied-index `python3 database/v2/migration/tests/test_manifest_validator.py`
  run had 97 passed and coverage validation passed. The current applied-index
  run is recorded below at 98 OK. The intentional strict-final-load check
  remains fail-closed with 1 unresolved source column and 5 relation-level open
  decisions; this is the expected pre-source-value gate, not a catalogue test
  failure.

The physical SQL and contract are read-only inputs. The coordinated final4
hashes are SQL
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a` and
contract
`46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`.
The implementation records remaining destination gaps in
[`docs/v2-m3-catalogue-contract.md`](v2-m3-catalogue-contract.md): target
bookkeeping defaults, provider/review enrichment, popularity observation date,
retry scheduling, nonnumeric duration-provider IDs, and later quarantine/seed
modules. They are explicit findings for integration, not fabricated values.

## Applied-state refresh (11 September 2026, layer A — complete)

The M3 migration is applied and its local file was RENAMED, not edited, to
`database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql`.
Verified on disk: `shasum -a 256` returns the immutable
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`. No `.sql`
file was opened for writing in this batch.

Refreshed:

* `database/v2/migration/manifest/build_destination_index.py` — applied M3
  filename, `applied = True` for all three migrations, a new per-source
  `applied_at` (`2026-09-10T23:26:54Z` for M3), and docstring/`boundary_note`
  rewritten from "M3 is a proposal" to the applied-and-immutable state, with
  the explicit caveat that `applied` is not a claim about root's outstanding
  remote schema/security/rollback verification.
* `database/v2/migration/manifest/physical-destination-index.json` and
  `disposition-manifest.json` — regenerated, not hand-edited.
* `database/v2/migration/tests/test_manifest_validator.py` — `M3_MIGRATION`
  now points at the applied filename (its absence was breaking two
  `setUpClass` calls and silently dropping the 14 `TestRetentionClasses`
  tests), plus one new guard,
  `test_index_records_the_applied_m3_file_at_its_immutable_hash`.
* `database/v2/migration/tests/test_probe_safety.py` — the
  `if __name__ == "__main__"` runner sat ABOVE
  `TestNonPublicSchemaDispositions`, so the documented standalone command ran
  16 of 22 tests and silently skipped that class. The runner is now last.
* `database/v2/M3-contract.md` and `database/v2/M3-checkpoint.md` — applied
  filename, applied-state notes, refreshed sidecar/manifest hashes.

Local totals verified rather than copied: **92 relations / 991 columns** across
all six private schemas — app 31/313, catalog 13/194, migration 25/239,
ops 15/166, reco 5/44, support 3/35 — now 92 applied and 0 proposed.

Refreshed hashes: contract `2d7a77eb38f69cf6985ebf1b803bd187cc3f1b5033f9468da7480f044da3a68e`
(was `46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`),
sidecar `095797f57b21c3fc0bb063351bdb1a49f33f4ef49075f3b50fe1ba056e5607b1`,
disposition manifest `98355df376c5793ca8b3e37ebaab08869c8cd9e3084bcdde2ad8f616f6f4f843`.

Commands and results:

* `python3 -m unittest discover -s database/v2/migration/tests` — 120 tests OK
  (the 119-test baseline plus the one new applied-file guard).
* `python3 database/v2/migration/tests/test_manifest_validator.py` — 98 OK.
* `python3 database/v2/migration/tests/test_probe_safety.py` — 22 OK (16 before
  the runner fix).
* `python3 database/v2/migration/manifest/build_destination_index.py --check` —
  `92 relations (92 applied + 0 proposed), 991 columns`.
* `python3 database/v2/migration/manifest/build_manifest.py --check` —
  `44 relations / 486 columns`.
* `python3 database/v2/migration/validate/validate_manifest.py` — exit 0;
  `--final-load` still exits 1 on 1 unresolved column and 5 relation-level open
  decisions, which is the intended pre-source-value gate.

## Bounded boundary correction (11 September 2026, root catalogue review)

Root reproduced three concrete boundary defects with synthetic local values
only, in [`docs/v2-m3-catalogue-review.md`](v2-m3-catalogue-review.md), and
transferred `games*`/`catalogue*` ownership for this fix. All three are fixed
in-place; no other domain, migration, or SQL file was touched.

1. **Source-kind mismatch.** Neither the `catalog_games` row loop nor the stub
   loop in `transformCatalogue` checked that the row it was about to emit
   agreed with the map's own resolution of that AppID's provenance. A game map
   entry now exposes its `source_kind` through the new `gameMapEntryKind`
   export (`games.ts`); `transformCatalogue` checks it in both directions —
   a `catalog_games` row must resolve as `"catalog_games"`, a stub row must
   resolve as `"stub"` — and fails with the new `catalogue_source_kind_mismatch`
   code on disagreement.
2. **External stub validation.** `transformCatalogue` previously cast an
   incoming `stubs[]` element straight to `GameStubTargetRecord` with no
   validation, so a copied record with a `null`/tampered title, a mismatched
   `normalized_sort_title`, or a forged `title_source` was emitted as though it
   were a genuine built stub. The same validation `buildGameMap` already
   applies when it builds a stub is now re-exported as
   `validateGameStubTargetRecord` (`games.ts`) and `transformCatalogue` runs
   every incoming stub through it before use, failing with the new
   `catalogue_stub_invalid` code. A stub this module built itself always
   revalidates unchanged.
3. **Mutable-map cache staleness.** `indexGameMap`'s `WeakMap` cached an index
   by the map object's identity regardless of whether the map was actually
   immutable, so a caller that mutated a plain (non-frozen) map object in
   place after its first lookup kept getting the pre-mutation index. The cache
   is now consulted and populated only when the map, its `run_identity`, its
   `entries` array, and every entry are all `Object.isFrozen` — exactly the
   graph `buildGameMap` itself produces. A mutable map is fully re-indexed on
   every call instead, so a later edit is never masked; a frozen,
   builder-produced map still gets the original O(1) cached lookup. No
   caller's map is ever frozen by this module to make it eligible.

**Follow-up correction (11 September 2026, M3-H handoff):** the fix above
still called `isFullyFrozenGameMap` — itself an O(entries) scan — before
checking `INDEX_CACHE`, so every cache HIT paid the same cost as a miss and
the promised O(1) path for a large frozen map was actually O(N) again.
`indexGameMap` now checks `INDEX_CACHE.get(map)` first, unconditionally; only
a cache miss performs the frozen-graph check, so it runs at most once per
distinct frozen map object. This is safe because `Object.freeze` is
irreversible: a map already in the cache cannot have un-frozen itself since it
was cached. Added a deterministic regression (no timing threshold): a `Proxy`
around the entries array counts indexed reads, and the test asserts that count
stops increasing after the first `lookupGameId` call even across 50 further
repeated lookups on the same map object
(`a cached frozen map's repeated lookup does not rescan entries`,
`games.test.ts`). 143/143 owned catalogue tests pass; typecheck/lint clean.

Also corrected per root's review: the contract's blanket claim that target
identity columns "stay out of the source record" was wrong for
`catalog.games.id`, which is this transform's own deterministic output, not a
loader-generated value; only offer IDs and review decision IDs are
loader-generated. And the loader requirement for a stub's `updated_at: null`
was clarified: `catalog.games.updated_at` is `not null default now()`, so the
loader must omit the column (or apply another explicit default) rather than
insert a literal `NULL` — `first_seen_at`/`last_seen_at` are nullable in the
target and need no such handling. See
[`docs/v2-m3-catalogue-contract.md`](v2-m3-catalogue-contract.md) for the
corrected text.

Focused regressions added (14 new tests): `games.test.ts` gained
`gameMapEntryKind` coverage, a mutable-map cache-staleness regression, and
seven `validateGameStubTargetRecord` tests (a genuinely built stub passing
unchanged, plus one per rejected tamper: null/missing title, substituted
fallback title, mismatched normalized title, wrong `title_source`,
out-of-bounds title length, and malformed relation/field/reason/hash);
`catalogue.test.ts` gained the two-direction `catalogue_source_kind_mismatch`
tests and three `catalogue_stub_invalid`/regression-guard tests.

Verification run once, after the fix:

* `node --experimental-strip-types --test lib/v2/migration/transform/games.test.ts lib/v2/migration/transform/catalogue.test.ts lib/v2/migration/transform/catalogue-values.test.ts`
  — **142 passed, 0 failed** (128 previously-accepted tests + 14 new
  regressions; no prior test was changed).
* `npm run typecheck` — clean.
* `npx eslint lib/v2/migration/transform/games.ts lib/v2/migration/transform/games.test.ts lib/v2/migration/transform/catalogue.ts lib/v2/migration/transform/catalogue.test.ts` —
  clean.

No SQL was edited, no other domain's owned files were touched, and no physical
PostgreSQL gate was re-run for this correction (the fix is pure-transform
logic and cache behavior; it changes no typed output shape the prior 12-test
M3-G and 25-test library PG17 gates depend on).
