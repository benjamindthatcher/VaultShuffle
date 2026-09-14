# M3-F catalogue and game transform contract

Status: bounded pure transform contract. The implementation reads accepted
`string | null` source cells and returns typed load records; it does not read a
source project, open a database connection, choose a provider, or apply a
target migration. The physical M3 schema is an input to this contract, not a
claim that the source has been exported or loaded.

The implementation is in
[`lib/v2/migration/transform/games.ts`](../lib/v2/migration/transform/games.ts),
[`lib/v2/migration/transform/catalogue.ts`](../lib/v2/migration/transform/catalogue.ts),
and [`lib/v2/migration/transform/catalogue-values.ts`](../lib/v2/migration/transform/catalogue-values.ts).
The shared map shape is defined in
[`docs/v2-claude-domain-transforms.md`](v2-claude-domain-transforms.md).

## Run identity and game map

`buildGameMap` receives one explicit `runId` and lowercase 64-character
`snapshotHash`. It validates every catalogue identity, explicit stub, and
relationship reference against that run before numbering the complete union.
AppIDs remain their exact canonical decimal text and are checked in the range
1 through 4,294,967,295. The union is sorted by its bigint value before
`catalog.games.id` values are assigned, so row order cannot change a foreign
key. Duplicate identities, conflicting source kinds, missing references,
malformed maps, and target integer overflow fail with a stable code and count.

The returned `GameMap` is the only game identity map shared with the library
transform. `lookupGameId` throws for a missing or null identity. A stub is
created only from explicit evidence and is labelled `source_kind = 'stub'`;
its fallback title is `Steam App <appid>`, with no fabricated timestamps.
Catalogue identity does not imply ownership or access.

## Catalogue outputs

`transformCatalogue` accepts the complete 58-column `catalog_games` row and,
optionally, the four-column `catalog_game_sightings` row. It returns records for
the following physical destinations. `catalog.games.id` is not a loader-generated
value: it is the deterministic identity `buildGameMap` assigned, carried through
unchanged. Offer IDs and review decision IDs, which the source has no analogue
for at all, are the ones left for the loader; `offer_ref` is this transform's own
deterministic local join key, not a target identity.

A catalogue row's and a stub row's `source_kind` are not independently asserted:
both are checked against the same-run map's own resolution for that AppID
(`catalog_games` for a real catalogue identity, `stub` for one the map only
accepted because a reference required it), so a row cannot claim a provenance
the map disagrees with in either direction.

| Source fact | Transform output | Preservation rule |
|---|---|---|
| `steam_appid`, `name`, `normalized_name`, `first_seen_reason`, `first_seen_at`, `last_seen_at`, `updated_at` | `catalog.games` | AppID text is kept; names use PostgreSQL character and trim bounds; instants retain UTC microseconds. |
| `developer`, `publisher`, `short_description`, `capsule_url`, `header_url`, `release_date`, `genres`, `categories`, `tags`, `metadata_fetched_at` | `catalog.game_metadata` | Nullable text stays nullable; developer/publisher are bounded to 1000 characters; the civil date stays a date; arrays preserve order and SQL NULL elements. A legacy numeric tag map becomes a key-sorted `[{tag,weight}]` array without converting numeric tokens through JavaScript numbers; an existing valid array remains unchanged. |
| `main_story_minutes`, `main_extras_minutes`, `completionist_minutes`, duration source/id/time/confidence/status/kind/override, platform flags, Deck value/time, review counts, popularity values and tag lifecycle fields | `catalog.game_features` | Minutes and counts are checked as exact nonnegative integers; bigint values remain decimal text; NULL is distinct from zero; platform NULL becomes `unknown`; Deck 0/1/2/3 remains four-way while its tri-state projection is separate. |
| `import_sighting_count`, `first_seen_at`, `last_seen_at` | `catalog.game_sightings` | The duplicate facts are emitted from the catalogue row when no dedicated row is supplied. If `catalog_game_sightings` is supplied, its dedicated import-sighting timestamps take this destination while the catalogue timestamps remain independently preserved in `catalog.games`; the one shared import counter must still agree. |
| `is_free`, `price_currency`, `price_initial`, `price_final`, `discount_percent`, `metadata_fetched_at` | `catalog.offers` and `catalog.offer_prices` | Only the structural US/USD observation is accepted; no conversion or region inference occurs. Provider and `retention_until` are explicit policy inputs. Prices retain NULL/zero and fail if the target check would be violated. |
| `steam_type` | `catalog.review_decisions` | The source `CHECK` forces `game`; it is retained as `catalogue_type` evidence at precedence 10 and never used to overwrite `catalog.games.game_type`. Reviewer, review time, or manual attribution is not invented. |
| `users_that_imported` | `reconciliation` | This denormalised count has no compact catalogue target. It remains source evidence for comparison with a later distinct-account recomputation; it is never silently replaced. |

The optional `catalog_game_sightings` input preserves sightings that have no
`catalog_games` row by writing a nullable target `game_id`. A sighting AppID is
resolved through the same map when an entry exists; an otherwise valid AppID
keeps `game_id = NULL` rather than creating a catalogue game. Its non-null
source count and first/last instants are checked against the target ordering
constraint. Duplicate dedicated rows and disagreements in the single shared
import counter fail closed. Timestamp differences do not compete: the
dedicated timeline goes to `catalog.game_sightings`, while `catalog.games`
retains the catalogue row's own first/last-seen timeline.

Offers are sorted by mapped game ID before `offer_ref` is assigned, then price
rows are rewritten to that key. This makes a retry over a permuted COPY order
produce the same offer/price join. A free row with no stated currency may
produce an offer without a price row; an amount or discount with no currency is
an unresolved conflict. The policy provider is bounded but is not claimed to be
a provider observation from the source.

## Exact value handling

`parsePgTextArray` handles PostgreSQL one-dimensional array output, including
quoted commas, quotes, backslashes, empty strings, and SQL NULL elements. It
refuses multidimensional and non-default-bound arrays rather than flattening
them. `inspectJsonDocument` scans JSON grammar with bounded depth, value count,
character length, and Unicode surrogate validity. It never calls `JSON.parse`
and returns the original JSON text plus UTF-8 byte evidence. The loader must still execute the target
`jsonb_typeof` and `pg_column_size` checks because encoded server storage size
cannot be proven by a pure transform.

Source NOT NULL integer, boolean, enum, date, and timestamp cells are rejected
when absent; nullable cells remain NULL. PostgreSQL character length is counted
by code point, and timestamps are compared by exact epoch microseconds. No
`Date`, IEEE number conversion of bigint/JSON values, wall-clock provenance,
truncation, unit conversion, or silent repair is used.

## Explicit destination gaps

The source has no facts for several target bookkeeping or enrichment columns.
The transform therefore leaves these target defaults or later modules to fill:

* `catalog.games.game_type`, `lifecycle_status`, and target `created_at`; the
  forced legacy `steam_type` evidence is retained separately.
* `catalog.game_metadata.provider_name` and `provider_revision`.
* `catalog.game_features.feature_revision`, `family_compatibility`, numeric
  `duration_confidence`, derived `review_score`, and
  `popularity_observed_on`; `source_captured_at` is kept as the distinct
  `source_captured_on` civil date.
* `catalog.offers.source_offer_id` and
  `catalog.offer_prices.source_observed_at`.
* Retry lease clocks (`tags_processing_started_at` and `tags_next_attempt_at`)
  are validated then rebuilt from the target lifecycle after cutover. Failure
  count and last error remain durable evidence.

`duration_source_game_id` is a source text value for a target bigint. Exact
positive canonical decimal text is accepted; nonnumeric, zero, or differently
spelled text is a reported physical gap rather than a coerced number. The
provider/duration resolver, quarantine input, seed/import-run provenance,
guest-pool rebuild, and any source-specific classification decision above the
legacy evidence row belong to later modules.

The physical contract's retention classes remain authoritative. Catalogue
sighting and provider evidence is shared catalogue evidence without an account
key; raw migration evidence follows the bounded `staging-30d-post-cutover`
class after validated cutover. This transform creates no export, freeze,
parity, snapshot-consistency, or final-cutover-fencing claim.

## Required load gates

Before target commit, the loader must bind the same run identity to every map,
row and output, decode the snapshot digest to exactly 32 bytes, execute the
`jsonb_typeof`/`pg_column_size` checks for genres, categories and weighted tags,
verify foreign-key and unique-key counts, and record the stable conflict rows.
Because `catalog.games.id` is `generated always as identity`, the loader must
insert the map's deterministic IDs with a controlled identity-override and
sequence-advance strategy; blindly copying those IDs is not a valid load.
`catalog.games.updated_at` is `not null default now()`; a stub's transform
output carries `updated_at: null` because the source has no update instant for
a row it never held, and the loader must translate that into omitting the
column (letting the default apply) or another explicit default-bookkeeping
rule — never a literal `NULL` insert into a `not null` column. `first_seen_at`
and `last_seen_at` are nullable in the target, so a stub's `null` there loads
as-is; only `updated_at` needs this loader bookkeeping. This is a loader
insert-shape requirement, not a claim that the stub has a source `updated_at`
to give.
The final-load strict mode must reject unresolved source decisions, sighting
conflicts, unmapped required identities, non-US price evidence, and any target
constraint violation. Snapshot consistency and final-cutover fencing are
separate gates: one proves all relation reads came from one snapshot, while the
other prevents a cutover from racing a writer; neither is claimed by this pure
module.
