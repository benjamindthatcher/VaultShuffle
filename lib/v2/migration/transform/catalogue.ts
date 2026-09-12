import { Buffer } from "node:buffer";
import { ExportError } from "../shared/redaction.ts";
import {
  CatalogueValueError,
  encodeJsonStringArray,
  inspectJsonDocument,
  parsePgTextArray,
  pgBtrim,
  pgLength,
} from "./catalogue-values.ts";
import {
  GameMapError,
  gameMapEntryKind,
  hasGameId,
  lookupGameId,
  parseSteamAppIdText,
  validateGameStubTargetRecord,
  type GameMap,
  type GameMapRunIdentity,
  type GameStubTargetRecord,
  assertGameMapRunIdentity,
} from "./games.ts";
import {
  parseCivilDate,
  parsePgInteger,
  parsePgTimestamptz,
  ScalarError,
  type CivilDate,
  type PgTimestamp,
} from "./scalars.ts";

/**
 * The `catalog_games` disposition.
 *
 * `catalog_games` is the widest relation in the source at 58 columns, and it
 * fans out into the catalogue destinations `catalog.games`,
 * `catalog.game_metadata`, `catalog.game_features`, `catalog.game_sightings`,
 * `catalog.offers`, `catalog.offer_prices` and one minimal
 * `catalog.review_decisions` row of legacy classification evidence.
 * Every column is accounted for here: mapped, or named in
 * `CATALOGUE_RETIRED_SOURCE_COLUMNS` with the fact that replaces it.
 *
 * This module is pure.  It reads no clock, opens no file, and issues no query.
 * Where the source cannot supply a value the target requires, it fails with a
 * stable code instead of inventing one.
 */

/** COPY cells stay `string | null` until a reviewed conversion consumes them. */
export type CatalogueCell = string | null;

export type CatalogueErrorCode =
  | "catalogue_run_invalid"
  | "catalogue_mixed_run_identity"
  | "catalogue_input_invalid"
  | "catalogue_count_limit"
  | "catalogue_duplicate_row"
  | "catalogue_game_unmapped"
  | "catalogue_source_kind_mismatch"
  | "catalogue_stub_invalid"
  | "catalogue_map_unmatched"
  | "catalogue_text_bounds"
  | "catalogue_invalid_timestamp"
  | "catalogue_invalid_date"
  | "catalogue_invalid_integer"
  | "catalogue_invalid_boolean"
  | "catalogue_invalid_enum"
  | "catalogue_seen_order_conflict"
  | "catalogue_sighting_conflict"
  | "catalogue_json_shape_conflict"
  | "catalogue_array_conflict"
  | "catalogue_deck_detail_invalid"
  | "catalogue_duration_source_game_id_unrepresentable"
  | "catalogue_price_conflict"
  | "catalogue_price_currency_unstated"
  | "catalogue_price_discount_without_currency"
  | "catalogue_offer_policy_missing"
  | "catalogue_offer_policy_invalid"
  | "catalogue_classification_unresolved"
  | "catalogue_physical_gap";

const CATALOGUE_MESSAGES: Readonly<Record<CatalogueErrorCode, string>> = {
  catalogue_run_invalid: "The catalogue transform run identity is invalid.",
  catalogue_mixed_run_identity: "Catalogue rows do not belong to one explicit migration run.",
  catalogue_input_invalid: "The catalogue transform input shape is invalid.",
  catalogue_count_limit: "The catalogue transform row bound was exceeded.",
  catalogue_duplicate_row: "The source contains duplicate catalogue rows for one AppID.",
  catalogue_game_unmapped: "A source catalogue row has no entry in the supplied same-run game map.",
  catalogue_source_kind_mismatch: "A row's source disagrees with the game map's provenance for the same AppID.",
  catalogue_stub_invalid: "A supplied catalogue stub record does not satisfy the documented stub validation rule.",
  catalogue_map_unmatched: "The game map claims a catalogue identity the source rows do not contain.",
  catalogue_text_bounds: "A source text value cannot satisfy the target bounds without loss.",
  catalogue_invalid_timestamp: "A source timestamp is invalid, unsupported, or absent where the source forbids null.",
  catalogue_invalid_date: "A source civil date is invalid or absent where the source forbids null.",
  catalogue_invalid_integer: "A source integer is malformed or outside the destination range.",
  catalogue_invalid_boolean: "A source boolean cell is not PostgreSQL COPY boolean text.",
  catalogue_invalid_enum: "A source code is outside the destination vocabulary.",
  catalogue_seen_order_conflict: "The source first-seen and last-seen instants violate the target ordering check.",
  catalogue_sighting_conflict: "The duplicated catalogue sighting facts disagree across source relations.",
  catalogue_json_shape_conflict: "A source JSON document is not the shape the destination column requires.",
  catalogue_array_conflict: "A source PostgreSQL array cannot be encoded without shape loss.",
  catalogue_deck_detail_invalid: "The source Steam Deck category is outside the preserved four-way domain.",
  catalogue_duration_source_game_id_unrepresentable:
    "The source duration provider identifier is not representable in the target bigint column.",
  catalogue_price_conflict: "The source price observation violates a target price check.",
  catalogue_price_currency_unstated: "A source price amount has no stated currency and no currency may be assumed.",
  catalogue_price_discount_without_currency: "A source discount has no stated currency and no offer price to carry it.",
  catalogue_offer_policy_missing: "An offer observation exists but no explicit offer policy was supplied.",
  catalogue_offer_policy_invalid: "The supplied offer policy is malformed or cannot satisfy a target check.",
  catalogue_classification_unresolved:
    "The legacy classification evidence is not the forced value the precedence rule was settled for.",
  catalogue_physical_gap: "The current target contract cannot represent this catalogue fact safely.",
};

export type CatalogueDiagnostic = Readonly<{
  code: CatalogueErrorCode;
  relation: string;
  field: string | null;
  count: number;
}>;

/**
 * A catalogue error carries a stable code, a source relation/field and a
 * count.  It never carries a title, a URL, a tag document, a price or an
 * AppID.
 */
export class CatalogueTransformError extends ExportError {
  readonly catalogueCode: CatalogueErrorCode;
  readonly diagnostics: readonly CatalogueDiagnostic[];

  constructor(code: CatalogueErrorCode, diagnostic: CatalogueDiagnostic) {
    super(code, CATALOGUE_MESSAGES[code], {
      relation: diagnostic.relation,
      field: diagnostic.field,
      count: diagnostic.count,
    });
    this.name = "CatalogueTransformError";
    this.catalogueCode = code;
    this.diagnostics = Object.freeze([Object.freeze({ ...diagnostic })]);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), diagnostics: this.diagnostics };
  }
}

function catalogueFailure(
  code: CatalogueErrorCode,
  relation: string,
  field: string | null = null,
  count = 1,
): never {
  throw new CatalogueTransformError(code, { code, relation, field, count });
}

const SOURCE_RELATION = "catalog_games";
const SIGHTING_SOURCE_RELATION = "catalog_game_sightings";
const RUN_ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_TEXT = /^[0-9a-f]{64}$/;
const PG_BIGINT_MAX = BigInt("9223372036854775807");
const TARGET_INTEGER_MAX = BigInt("2147483647");
const TARGET_SMALLINT_MAX = BigInt("32767");
const ZERO = BigInt(0);

/* -------------------------------------------------------------------------
 * Published constants: what this transform writes, leaves, and retires.
 * ---------------------------------------------------------------------- */

/**
 * Target columns this transform deliberately does not write.
 *
 * `catalog.games.game_type` is the important one.  The source
 * `CHECK (steam_type = 'game')` forces every row to claim to be a game, so the
 * source carries no provider classification to assert; D-CAT-1 settles that
 * the legacy value is recorded as evidence in `catalog.review_decisions` and
 * never rewrites `game_type`.  Leaving the column to its M1 default is that
 * decision, not an oversight, and the evidence row is what a later resolver
 * reads.
 */
export const CATALOGUE_UNWRITTEN_TARGET_COLUMNS = Object.freeze({
  "catalog.games.game_type": "D-CAT-1: legacy classification is evidence in catalog.review_decisions, not an assertion.",
  "catalog.games.lifecycle_status": "The source has no lifecycle fact; the M1 default 'active' applies.",
  "catalog.games.created_at": "The v2 row creation clock. The source first-seen instant is catalog.games.first_seen_at.",
  "catalog.game_metadata.provider_name": "The source records no metadata provider; tags_source is a separate fact (D-CAT-8).",
  "catalog.game_metadata.provider_revision": "The source records no provider revision.",
  "catalog.game_features.feature_revision": "A target bookkeeping counter with no source fact.",
  "catalog.game_features.family_compatibility": "The source has no family-sharing observation; 'unknown' is the honest default.",
  "catalog.game_features.duration_confidence":
    "D-CAT-3: an ordinal label has no defensible numeric image. The label is preserved; the probability stays NULL.",
  "catalog.game_features.review_score":
    "D-CAT-4: the review triple is preserved exactly and the displayed score is derived from it. Writing a rounded numeric(5,2) here would add a value that disagrees with the derivation whenever review_total is NULL or zero.",
  "catalog.game_features.popularity_observed_on":
    "The source has one popularity date, mapped to source_captured_on. Copying it here as well would claim two observations.",
  "catalog.offers.source_offer_id": "The source records no provider offer identifier.",
  "catalog.offer_prices.source_observed_at":
    "The source records no provider-side observation instant, only the instant its own row was written.",
  "catalog.game_sightings.updated_at":
    "A target bookkeeping clock. The source sighting facts are the two seen instants, which are written; the M3 default applies.",
  "catalog.review_decisions.name":
    "The catalogue title is preserved in catalog.games.title. Copying it onto the evidence row would create a second title to disagree with.",
  "catalog.review_decisions.matched_rule":
    "The legacy steam_type value was forced by a source CHECK, so no rule matched it. A quarantine module supplies this for its own decisions.",
  "catalog.review_decisions.genres":
    "The metadata arrays are preserved in catalog.game_metadata. A quarantine decision snapshots them as its evidence; a forced type has no such snapshot.",
  "catalog.review_decisions.categories":
    "The metadata arrays are preserved in catalog.game_metadata, for the same reason as the genres evidence column above.",
  "catalog.review_decisions.response_text":
    "A duration-review reply. The legacy classification row is not a review and has no provider response to record.",
  "catalog.review_decisions.response_kind":
    "A duration-review reply kind, paired with source_url by a target CHECK. Neither exists for forced legacy classification evidence.",
  "catalog.review_decisions.source_url":
    "A duration-review provider link. The legacy classification evidence cites a source relation and key instead.",
  "catalog.review_decisions.reviewer_account_id":
    "No human reviewed this. Attributing a forced source CHECK to an account would fabricate manual decision provenance.",
  "catalog.review_decisions.reviewed_at":
    "There was no review, so there is no review instant. The row's created_at/updated_at come from named source columns instead.",
  "catalog.review_decisions.review_notes":
    "Reviewer free text that does not exist for a forced legacy value; the fixed reason text carries the explanation.",
  "catalog.review_decisions.source_payload":
    "A per-decision evidence document. The forced steam_type is the whole evidence and is stored in its own column; the M3 '{}' default applies.",
} as const);

/**
 * Every catalogue destination column, classified.
 *
 * `CATALOGUE_UNWRITTEN_TARGET_COLUMNS` says why a column is left alone; this
 * says which columns the transform does write, and which the target or the
 * loader supplies.  Together they have to account for EVERY column of the
 * seven catalogue destinations, and the test asserts that against the
 * generated physical destination index rather than against this prose.  Without
 * that, a target column can quietly go unwritten -- which is exactly how
 * `catalog.game_metadata.release_date` came to be emitted on the wrong record.
 *
 * `written` names must also be keys of the corresponding emitted record, so the
 * declaration cannot drift away from the code.
 */
export const CATALOGUE_TARGET_COLUMNS = Object.freeze({
  "catalog.games": Object.freeze({
    // `id` is `generated always as identity`; the loader inserts the map's
    // deterministic identity with OVERRIDING SYSTEM VALUE and then advances
    // the sequence, which is what makes the legacy AppID map stable.
    written: Object.freeze([
      "id",
      "steam_app_id",
      "title",
      "normalized_sort_title",
      "title_source",
      "first_seen_at",
      "first_seen_reason",
      "last_seen_at",
      "updated_at",
    ]),
    target_generated: Object.freeze([] as readonly string[]),
    loader_resolved: Object.freeze([] as readonly string[]),
  }),
  "catalog.game_metadata": Object.freeze({
    written: Object.freeze([
      "game_id",
      "developer",
      "publisher",
      "short_description",
      "header_image_url",
      "capsule_image_url",
      "genres",
      "categories",
      "weighted_tags",
      "release_date",
      "fetched_at",
      "updated_at",
    ]),
    target_generated: Object.freeze([] as readonly string[]),
    loader_resolved: Object.freeze([] as readonly string[]),
  }),
  "catalog.game_features": Object.freeze({
    written: Object.freeze([
      "game_id",
      "deck_compatibility",
      "linux_compatibility",
      "windows_compatibility",
      "mac_compatibility",
      "deck_compatibility_detail",
      "deck_checked_at",
      "main_duration_minutes",
      "extras_duration_minutes",
      "completion_duration_minutes",
      "duration_source",
      "duration_source_game_id",
      "duration_source_updated_at",
      "duration_confidence_label",
      "duration_status",
      "duration_kind",
      "duration_manual_override",
      "review_positive",
      "review_negative",
      "review_total",
      "popularity_rank",
      "popularity_source",
      "popularity_metric",
      "popularity_low",
      "popularity_high",
      "popularity_ccu",
      "source_captured_on",
      "tags_source",
      "tags_status",
      "tags_fetched_at",
      "tags_failure_count",
      "tags_last_error",
      "updated_at",
    ]),
    target_generated: Object.freeze([] as readonly string[]),
    loader_resolved: Object.freeze([] as readonly string[]),
  }),
  "catalog.game_sightings": Object.freeze({
    written: Object.freeze([
      "steam_app_id",
      "game_id",
      "import_count",
      "first_seen_at",
      "last_seen_at",
      "source_snapshot_hash",
    ]),
    target_generated: Object.freeze([] as readonly string[]),
    loader_resolved: Object.freeze([] as readonly string[]),
  }),
  "catalog.offers": Object.freeze({
    written: Object.freeze([
      "game_id",
      "provider",
      "region_code",
      "is_free",
      "first_observed_at",
      "last_observed_at",
      "source_snapshot_hash",
    ]),
    target_generated: Object.freeze(["id"]),
    loader_resolved: Object.freeze([] as readonly string[]),
  }),
  "catalog.offer_prices": Object.freeze({
    written: Object.freeze([
      "observed_at",
      "currency",
      "price_initial_cents",
      "price_final_cents",
      "discount_percent",
      "is_free",
      "is_current",
      "retention_until",
      "source_snapshot_hash",
    ]),
    target_generated: Object.freeze(["id"]),
    // `offer_ref` is a transform-local join key; the loader substitutes the
    // generated catalog.offers.id for it.  `game_id`, `provider` and
    // `region_code` on the price record are that join's evidence, NOT columns
    // of catalog.offer_prices, which addresses an offer by offer_id alone.
    loader_resolved: Object.freeze(["offer_id"]),
  }),
  "catalog.review_decisions": Object.freeze({
    written: Object.freeze([
      "game_id",
      "steam_app_id",
      "decision_kind",
      "source_relation",
      "source_record_key",
      "source",
      "precedence_rank",
      "decision_status",
      "steam_type",
      "reason",
      "duration_manual_override",
      "created_at",
      "updated_at",
      "source_snapshot_hash",
    ]),
    target_generated: Object.freeze(["id"]),
    loader_resolved: Object.freeze([] as readonly string[]),
  }),
} as const);

/**
 * Source columns with no destination, and the fact that replaces each.
 *
 * A retirement is a claim that the fact survives somewhere else.  Each entry
 * names where, so the claim is checkable rather than asserted.
 */
export const CATALOGUE_RETIRED_SOURCE_COLUMNS = Object.freeze({
  import_sighting_count:
    "catalog_game_sightings.import_count holds the same counter with first/last seen instants and is archived in full, so exactly one copy survives. The value is reported per game in `reconciliation` for the conflict report.",
  created_at:
    "A duplicate load-time clock. The meaningful 'when did this app enter the catalogue' fact is preserved in catalog.games.first_seen_at.",
  users_that_imported:
    "A denormalised counter recomputable as the distinct account count in app.library_games. Recomputation will differ wherever a user has since been deleted; that difference belongs in the conflict report, reported per game in `reconciliation`.",
} as const);

/**
 * Two columns this module used to retire, and where they go instead.
 *
 * Root's 11 September durability review rejected the previous entries. The
 * claim was that `tags_next_attempt_at` is "rebuilt from tags_status after
 * cutover" — but a `failed` status alone does not say when the work becomes
 * eligible again, and nothing in the plan rebuilds a fence from it, so the
 * effective backoff would have been lost and every failed app re-attempted at
 * once after cutover. `catalog.provider_state` (M3) exists for exactly this:
 * it holds `next_attempt_at` and `processing_started_at` per
 * (game, provider, evidence_kind), which `catalog.games` does not.
 *
 * `tags_processing_started_at` is still not a resumed lease: it is carried
 * only where the target's own CHECK permits it (status `processing` or
 * `failed`), as evidence of the attempt that was in flight at the freeze,
 * and no worker reads it to continue that attempt.
 */
/**
 * `catalog.provider_state.provider` when current attempt ownership is not a
 * source fact. `tags_source` is the source of the last successful content and
 * can remain populated while a later refresh is pending or failed; it only
 * attributes a `ready` result.
 */
export const TAGS_UNATTRIBUTED_PROVIDER = "unknown";

export const CATALOGUE_TAGS_DURABLE_RETRY_COLUMNS = Object.freeze({
  tags_processing_started_at:
    "catalog.provider_state.processing_started_at (evidence_kind='tags'), retained as attempt evidence and never resumed.",
  tags_next_attempt_at: "catalog.provider_state.next_attempt_at (evidence_kind='tags'): the effective backoff fence.",
} as const);

/**
 * The explicit classification precedence ladder.
 *
 * The physical layer requires `precedence_rank` so a resolver can prove
 * manual > automatic > legacy rather than relying on row order.  The ladder is
 * published here so the later quarantine and duration-review modules slot
 * above legacy evidence without renumbering it.
 *
 * This module emits `legacy_catalog_games` only.  The higher tiers are
 * reserved, not implemented, and this module never resolves the ladder into a
 * `catalog.games.game_type` value: see `docs/v2-m3-catalogue-contract.md` for
 * the unresolved resolution rule that root still owes.
 */
export const CATALOGUE_DECISION_PRECEDENCE = Object.freeze({
  legacy_catalog_games: 10,
  automatic_quarantine: 40,
  manual_quarantine: 70,
  manual_duration_review: 90,
} as const);

/** The fixed provenance text on the legacy classification evidence row. */
export const LEGACY_CLASSIFICATION_SOURCE = "legacy_catalog_games_steam_type";
export const LEGACY_CLASSIFICATION_REASON =
  "The legacy source constrained catalog_games.steam_type to 'game', so the value is a forced classification with no provider observation behind it. Retained as evidence; it does not set catalog.games.game_type.";

/**
 * Checks the pure transform cannot prove and the loader must therefore run.
 *
 * `pg_column_size` measures the encoded, possibly TOAST-compressed datum.  A
 * pure precheck can measure the UTF-8 text and nothing more, and compression
 * can move the encoded size in either direction, so the size checks stay
 * REQUIRED gates rather than assumed passes.
 */
export type RequiredSqlGate = Readonly<{
  relation: string;
  column: string;
  check: string;
  reason: string;
  /** Largest UTF-8 byte length observed for this column in this batch. */
  max_source_utf8_bytes: number;
}>;

/* -------------------------------------------------------------------------
 * Source row
 * ---------------------------------------------------------------------- */

/** Every `catalog_games` column, in source ordinal order. */
export type CatalogGamesSourceRow = Readonly<{
  steam_appid: CatalogueCell;
  name: CatalogueCell;
  normalized_name: CatalogueCell;
  steam_type: CatalogueCell;
  developer: CatalogueCell;
  publisher: CatalogueCell;
  genres: CatalogueCell;
  categories: CatalogueCell;
  tags: CatalogueCell;
  short_description: CatalogueCell;
  release_date: CatalogueCell;
  is_free: CatalogueCell;
  capsule_url: CatalogueCell;
  header_url: CatalogueCell;
  review_positive: CatalogueCell;
  review_negative: CatalogueCell;
  review_total: CatalogueCell;
  price_currency: CatalogueCell;
  price_initial: CatalogueCell;
  price_final: CatalogueCell;
  discount_percent: CatalogueCell;
  popularity_rank: CatalogueCell;
  popularity_source: CatalogueCell;
  popularity_metric: CatalogueCell;
  popularity_low: CatalogueCell;
  popularity_high: CatalogueCell;
  popularity_ccu: CatalogueCell;
  source_captured_at: CatalogueCell;
  first_seen_reason: CatalogueCell;
  import_sighting_count: CatalogueCell;
  first_seen_at: CatalogueCell;
  last_seen_at: CatalogueCell;
  metadata_fetched_at: CatalogueCell;
  created_at: CatalogueCell;
  updated_at: CatalogueCell;
  users_that_imported: CatalogueCell;
  main_story_minutes: CatalogueCell;
  main_extras_minutes: CatalogueCell;
  completionist_minutes: CatalogueCell;
  duration_source: CatalogueCell;
  duration_source_game_id: CatalogueCell;
  duration_source_updated_at: CatalogueCell;
  duration_confidence: CatalogueCell;
  duration_status: CatalogueCell;
  duration_kind: CatalogueCell;
  tags_source: CatalogueCell;
  tags_status: CatalogueCell;
  tags_fetched_at: CatalogueCell;
  tags_processing_started_at: CatalogueCell;
  tags_next_attempt_at: CatalogueCell;
  tags_failure_count: CatalogueCell;
  tags_last_error: CatalogueCell;
  platform_windows: CatalogueCell;
  platform_mac: CatalogueCell;
  platform_linux: CatalogueCell;
  deck_compatibility: CatalogueCell;
  deck_checked_at: CatalogueCell;
  duration_manual_override: CatalogueCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/** The complete `catalog_game_sightings` source row used by the durable
 * catalogue provenance destination.  It is optional at the transform boundary
 * because the `catalog_games` row carries a deliberately duplicated copy of
 * these three facts; when the relation is supplied, the copies are checked
 * against one another instead of choosing silently. */
export type CatalogGameSightingsSourceRow = Readonly<{
  steam_appid: CatalogueCell;
  import_count: CatalogueCell;
  first_seen_at: CatalogueCell;
  last_seen_at: CatalogueCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/** The 58 source columns, used to prove no column is silently absent. */
export const CATALOG_GAMES_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_appid", "name", "normalized_name", "steam_type", "developer", "publisher",
  "genres", "categories", "tags", "short_description", "release_date", "is_free",
  "capsule_url", "header_url", "review_positive", "review_negative", "review_total",
  "price_currency", "price_initial", "price_final", "discount_percent",
  "popularity_rank", "popularity_source", "popularity_metric", "popularity_low",
  "popularity_high", "popularity_ccu", "source_captured_at", "first_seen_reason",
  "import_sighting_count", "first_seen_at", "last_seen_at", "metadata_fetched_at",
  "created_at", "updated_at", "users_that_imported", "main_story_minutes",
  "main_extras_minutes", "completionist_minutes", "duration_source",
  "duration_source_game_id", "duration_source_updated_at", "duration_confidence",
  "duration_status", "duration_kind", "tags_source", "tags_status", "tags_fetched_at",
  "tags_processing_started_at", "tags_next_attempt_at", "tags_failure_count",
  "tags_last_error", "platform_windows", "platform_mac", "platform_linux",
  "deck_compatibility", "deck_checked_at", "duration_manual_override",
]);

/** The source columns for the dedicated catalogue sighting relation. */
export const CATALOG_GAME_SIGHTINGS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_appid",
  "import_count",
  "first_seen_at",
  "last_seen_at",
]);

/* -------------------------------------------------------------------------
 * Target records
 * ---------------------------------------------------------------------- */

export type TriState = "unknown" | "supported" | "unsupported";

export type CatalogueGameTargetRecord = Readonly<{
  id: number;
  /** Exact source AppID text; the loader casts it to the bounded bigint. */
  steam_app_id: string;
  title: string;
  normalized_sort_title: string;
  /** M2 protection marker. 'existing' is the M2 default for a real row. */
  title_source: "existing" | "catalog_stub";
  first_seen_at: PgTimestamp | null;
  first_seen_reason: "seed" | "user_import" | "manual" | "unknown";
  last_seen_at: PgTimestamp | null;
  /** Absent for a stub: the source has no update instant for a row it never held. */
  updated_at: PgTimestamp | null;
  source_kind: "catalog_games" | "stub";
}>;

export type CatalogueGameMetadataTargetRecord = Readonly<{
  game_id: number;
  developer: string | null;
  publisher: string | null;
  short_description: string | null;
  header_image_url: string | null;
  capsule_image_url: string | null;
  /** JSON array text re-encoded from the source `text[]`, order preserved. */
  genres: string;
  categories: string;
  /** The source JSONB text, verbatim. Never reserialised. */
  weighted_tags: string;
  /**
   * The source civil date, on its only destination.
   *
   * `catalog.game_metadata.release_date` is the single target column for this
   * fact (`catalog.game_features` has none), so it belongs on this record.  It
   * stays a civil date and is never widened into an instant.
   */
  release_date: CivilDate | null;
  fetched_at: PgTimestamp | null;
  updated_at: PgTimestamp;
  /** The source array elements, so the encoding stays checkable. */
  genres_elements: readonly (string | null)[];
  categories_elements: readonly (string | null)[];
}>;

export type CatalogueGameFeaturesTargetRecord = Readonly<{
  game_id: number;
  deck_compatibility: TriState;
  linux_compatibility: TriState;
  windows_compatibility: TriState;
  mac_compatibility: TriState;
  /** The four-way Steam category, preserved so Playable stays distinct from Verified. */
  deck_compatibility_detail: number | null;
  deck_checked_at: PgTimestamp | null;
  main_duration_minutes: number | null;
  extras_duration_minutes: number | null;
  completion_duration_minutes: number | null;
  duration_source: string | null;
  /** Exact decimal text for the target bigint; never a JavaScript number. */
  duration_source_game_id: string | null;
  duration_source_updated_at: PgTimestamp | null;
  duration_confidence_label: "none" | "low" | "medium" | "high" | null;
  duration_status: "pending" | "processing" | "ready" | "failed" | "no_match" | "review_required";
  duration_kind: "finite" | "endless" | "not-applicable" | "unknown";
  duration_manual_override: boolean;
  review_positive: string | null;
  review_negative: string | null;
  review_total: string | null;
  popularity_rank: string | null;
  popularity_source: string | null;
  popularity_metric: string | null;
  popularity_low: string | null;
  popularity_high: string | null;
  popularity_ccu: string | null;
  source_captured_on: CivilDate | null;
  tags_source: string | null;
  tags_status: "pending" | "processing" | "ready" | "failed";
  tags_fetched_at: PgTimestamp | null;
  tags_failure_count: number;
  tags_last_error: string | null;
  updated_at: PgTimestamp;
}>;

export type CatalogueOfferTargetRecord = Readonly<{
  /** Transform-local join key. Not a target column; catalog.offers.id is an identity. */
  offer_ref: number;
  game_id: number;
  provider: string;
  region_code: "US";
  is_free: boolean;
  first_observed_at: PgTimestamp;
  last_observed_at: PgTimestamp;
  source_snapshot_hash: string;
  /** Which source column dated this observation. */
  observed_at_source: "catalog_games.metadata_fetched_at";
}>;

export type CatalogueOfferPriceTargetRecord = Readonly<{
  offer_ref: number;
  game_id: number;
  provider: string;
  region_code: "US";
  observed_at: PgTimestamp;
  currency: "USD";
  price_initial_cents: number | null;
  price_final_cents: number | null;
  discount_percent: number;
  is_free: boolean;
  is_current: true;
  retention_until: PgTimestamp;
  source_snapshot_hash: string;
  observed_at_source: "catalog_games.metadata_fetched_at";
}>;

export type CatalogueReviewDecisionTargetRecord = Readonly<{
  game_id: number;
  steam_app_id: string;
  decision_kind: "catalogue_type";
  source_relation: "catalog_games";
  source_record_key: string;
  source: string;
  precedence_rank: number;
  decision_status: "retained";
  steam_type: string;
  reason: string;
  duration_manual_override: false;
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
  source_snapshot_hash: string;
  /** Which source column supplied each instant, so neither is mistaken for a review time. */
  created_at_source: "catalog_games.first_seen_at";
  updated_at_source: "catalog_games.updated_at";
}>;

/** Counters that are retired here and must be reconciled after the load. */
export type CatalogueReconciliationRecord = Readonly<{
  game_id: number;
  steam_app_id: string;
  import_sighting_count: string;
  users_that_imported: string;
}>;

export type CatalogueGameSightingsTargetRecord = Readonly<{
  /** Exact source AppID text; the loader casts it to the target bigint. */
  steam_app_id: string;
  /** NULL is retained when the source sighting has no catalogue identity. */
  game_id: number | null;
  import_count: string;
  first_seen_at: PgTimestamp;
  last_seen_at: PgTimestamp;
  source_snapshot_hash: string;
  /** Whether the row came from the dedicated source relation or its duplicate
   * `catalog_games` fields.  This is transform provenance, not a target
   * column, and lets the loader/report explain which source was present. */
  source_relation: "catalog_game_sightings" | "catalog_games";
}>;

export type CatalogueOfferPolicy = Readonly<{
  /**
   * Attribution for the legacy price observation.
   *
   * The source records no provider for a price, so this is supplied by the
   * manifest rather than guessed.  It becomes part of the
   * `(game_id, provider, region_code)` offer key, so a later real provider
   * offer stays a separate row.
   */
  provider: string;
  /**
   * The reviewed expiry for every migrated price observation, as PostgreSQL
   * timestamptz text.  `catalog.offer_prices.retention_until` is NOT NULL and
   * there is no source fact behind it, so it is an explicit policy input; a
   * per-row window would need date arithmetic this module refuses to invent.
   */
  retentionUntil: string;
}>;

export type CatalogueTransformInput = Readonly<{
  runIdentity: GameMapRunIdentity;
  /** The same-run map produced by `buildGameMap`. */
  gameMap: GameMap;
  rows: readonly CatalogGamesSourceRow[];
  /** Optional dedicated sighting relation.  Overlapping rows are reconciled
   * with `catalog_games.import_sighting_count` and its seen instants. */
  sightings?: readonly CatalogGameSightingsSourceRow[];
  /** Stub records from the same build, loaded as labelled catalogue rows. */
  stubs?: readonly GameStubTargetRecord[];
  offerPolicy?: CatalogueOfferPolicy;
}>;

export type CatalogueTransformOptions = Readonly<{
  maxRows?: number;
}>;

export type CatalogueTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  games: readonly CatalogueGameTargetRecord[];
  game_metadata: readonly CatalogueGameMetadataTargetRecord[];
  game_features: readonly CatalogueGameFeaturesTargetRecord[];
  game_sightings: readonly CatalogueGameSightingsTargetRecord[];
  offers: readonly CatalogueOfferTargetRecord[];
  offer_prices: readonly CatalogueOfferPriceTargetRecord[];
  review_decisions: readonly CatalogueReviewDecisionTargetRecord[];
  /**
   * `catalog.provider_state` rows for tag evidence.
   *
   * `catalog.games` carries the descriptive half of the tags lifecycle
   * (source, status, fetched_at, failure_count, last_error); the scheduling
   * half (`tags_next_attempt_at`, `tags_processing_started_at`) has no column
   * there and lives here. The frozen source CHECK gives every catalogue row a
   * pending/processing/ready/failed lifecycle value, so every source row emits
   * exactly one tags provider-state row.
   */
  provider_state: readonly CatalogueTagsProviderStateRecord[];
  reconciliation: readonly CatalogueReconciliationRecord[];
  required_sql_gates: readonly RequiredSqlGate[];
  counts: Readonly<{
    source_rows: number;
    stub_rows: number;
    offers: number;
    offer_prices: number;
    review_decisions: number;
    game_sightings: number;
    provider_state: number;
  }>;
}>;

/**
 * One `catalog.provider_state` row, for `evidence_kind = 'tags'`.
 *
 * Declared here rather than imported from `provider-shared.ts` so this module
 * keeps its own dependency direction (the provider modules depend on this one,
 * not the reverse). The shape is identical to
 * `ProviderStateTargetRecord`.
 */
export type CatalogueTagsProviderStateRecord = Readonly<{
  game_id: number;
  provider: string;
  evidence_kind: "tags";
  status: "pending" | "processing" | "ready" | "failed" | "no_match" | "review_required" | "unknown";
  failure_count: number;
  next_attempt_at: PgTimestamp | null;
  processing_started_at: PgTimestamp | null;
  fetched_at: PgTimestamp | null;
  last_error_code: null;
  last_error: string | null;
  source_snapshot_hash: string;
  updated_at: PgTimestamp;
}>;

/* -------------------------------------------------------------------------
 * Cell readers
 * ---------------------------------------------------------------------- */

function asObject(value: unknown, relation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    catalogueFailure("catalogue_input_invalid", relation);
  }
  return value as Record<string, unknown>;
}

function ensureArray(value: unknown, relation: string): readonly object[] {
  if (!Array.isArray(value)) catalogueFailure("catalogue_input_invalid", relation);
  return value as readonly object[];
}

function optionalAlias(row: object, first: string, second: string): unknown {
  const record = row as Record<string, unknown>;
  const left = record[first];
  const right = record[second];
  if (left !== undefined && right !== undefined && left !== right) return { mismatch: true };
  // `null` is an explicitly supplied malformed identity, not the same thing
  // as an omitted alias.  Preserve it so the runtime type check rejects it.
  return left !== undefined ? left : right;
}

function checkRowRunIdentity(row: object, run: GameMapRunIdentity, relation = SOURCE_RELATION): void {
  const rowRunId = optionalAlias(row, "runId", "run_id");
  const rowSnapshotHash = optionalAlias(row, "snapshotHash", "snapshot_hash");
  if (
    typeof rowRunId === "object" ||
    typeof rowSnapshotHash === "object" ||
    (rowRunId !== undefined && typeof rowRunId !== "string") ||
    (rowSnapshotHash !== undefined && typeof rowSnapshotHash !== "string")
  ) {
    catalogueFailure("catalogue_mixed_run_identity", relation);
  }
  if (
    (rowRunId !== undefined && rowRunId !== run.runId) ||
    (rowSnapshotHash !== undefined && rowSnapshotHash !== run.snapshotHash)
  ) {
    catalogueFailure("catalogue_mixed_run_identity", relation);
  }
}

/**
 * Read one source cell.
 *
 * A missing column or a non-string value is a broken export shape.  A source
 * NULL is a *value*, even in a column the source declares NOT NULL, and it is
 * passed on so the column's own reader reports it with its own code: a null
 * `tags` is a JSON shape conflict, a null `last_seen_at` is an invalid
 * timestamp, and neither is the same finding as a truncated row.
 */
function relationCell(row: Record<string, unknown>, key: string, relation: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") catalogueFailure("catalogue_input_invalid", relation, key);
  return value;
}

function cell(row: Record<string, unknown>, key: string): string | null {
  return relationCell(row, key, SOURCE_RELATION);
}

const nullableCell = cell;

function timestamp(value: string | null, field: string, required: boolean, relation = SOURCE_RELATION): PgTimestamp | null {
  if (value === null) {
    if (required) catalogueFailure("catalogue_invalid_timestamp", relation, field);
    return null;
  }
  try {
    return parsePgTimestamptz(value, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof ScalarError) catalogueFailure("catalogue_invalid_timestamp", relation, field);
    throw error;
  }
}

function civilDate(value: string | null, field: string): CivilDate | null {
  try {
    return parseCivilDate(value, `${SOURCE_RELATION}.${field}`);
  } catch (error) {
    if (error instanceof ScalarError) catalogueFailure("catalogue_invalid_date", SOURCE_RELATION, field);
    throw error;
  }
}

function integerText(
  value: string | null,
  field: string,
  bounds: { min: bigint; max: bigint },
  relation = SOURCE_RELATION,
): bigint | null {
  try {
    return parsePgInteger(value, {
      minInclusive: bounds.min,
      maxInclusive: bounds.max,
      field: `${relation}.${field}`,
    });
  } catch (error) {
    if (error instanceof ScalarError) catalogueFailure("catalogue_invalid_integer", relation, field);
    throw error;
  }
}

function nonNegativeBigintText(
  value: string | null,
  field: string,
  relation = SOURCE_RELATION,
  required = false,
): string | null {
  const parsed = integerText(value, field, { min: ZERO, max: PG_BIGINT_MAX }, relation);
  if (parsed === null && required) catalogueFailure("catalogue_invalid_integer", relation, field);
  return parsed === null ? null : parsed.toString(10);
}

function nonNegativeIntegerNumber(value: string | null, field: string, required = false): number | null {
  const parsed = integerText(value, field, { min: ZERO, max: TARGET_INTEGER_MAX });
  if (parsed === null && required) catalogueFailure("catalogue_invalid_integer", SOURCE_RELATION, field);
  return parsed === null ? null : Number(parsed);
}

/** PostgreSQL COPY text renders boolean as exactly `t` or `f`. */
function booleanCell(value: string | null, field: string, required: boolean): boolean | null {
  if (value === null) {
    if (required) catalogueFailure("catalogue_invalid_boolean", SOURCE_RELATION, field);
    return null;
  }
  if (value === "t") return true;
  if (value === "f") return false;
  catalogueFailure("catalogue_invalid_boolean", SOURCE_RELATION, field);
}

/**
 * A boolean platform flag becomes a tri-state.
 *
 * NULL is `unknown` and never `unsupported`: an absent observation must
 * under-claim rather than assert that a platform is not supported.
 */
function triStateFromBoolean(value: boolean | null): TriState {
  if (value === null) return "unknown";
  return value ? "supported" : "unsupported";
}

type TextBounds = { nullable: boolean; maxLength: number; requireTrimmedContent: boolean };

function boundedText(value: string | null, field: string, bounds: TextBounds): string | null {
  if (value === null) {
    if (bounds.nullable) return null;
    catalogueFailure("catalogue_text_bounds", SOURCE_RELATION, field);
  }
  if (bounds.requireTrimmedContent) {
    // The target bounds the trimmed length; the untrimmed text is what is
    // stored, so the check mirrors the target exactly.
    const trimmed = pgLength(pgBtrim(value));
    if (trimmed < 1 || trimmed > bounds.maxLength) catalogueFailure("catalogue_text_bounds", SOURCE_RELATION, field);
    return value;
  }
  if (pgLength(value) > bounds.maxLength) catalogueFailure("catalogue_text_bounds", SOURCE_RELATION, field);
  return value;
}

function enumCell<T extends string>(
  value: string | null,
  field: string,
  allowed: readonly T[],
  required: boolean,
): T | null {
  if (value === null) {
    if (required) catalogueFailure("catalogue_invalid_enum", SOURCE_RELATION, field);
    return null;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    catalogueFailure("catalogue_invalid_enum", SOURCE_RELATION, field);
  }
  return value as T;
}

function jsonArrayFromPgArray(
  value: string | null,
  field: string,
): { text: string; elements: readonly (string | null)[] } {
  if (value === null) {
    // The source declares genres/categories NOT NULL; a null is a broken row,
    // not an empty array.  Substituting `[]` would invent an observation.
    catalogueFailure("catalogue_array_conflict", SOURCE_RELATION, field);
  }
  let parsed;
  try {
    parsed = parsePgTextArray(value, { field: `${SOURCE_RELATION}.${field}` });
  } catch (error) {
    if (error instanceof CatalogueValueError) catalogueFailure("catalogue_array_conflict", SOURCE_RELATION, field);
    throw error;
  }
  if (!parsed) catalogueFailure("catalogue_array_conflict", SOURCE_RELATION, field);
  return { text: encodeJsonStringArray(parsed.elements), elements: parsed.elements };
}

function jsonArrayDocument(value: string | null, field: string): { text: string; utf8Bytes: number } {
  if (value === null) {
    catalogueFailure("catalogue_json_shape_conflict", SOURCE_RELATION, field);
  }
  let document;
  try {
    document = inspectJsonDocument(value, { field: `${SOURCE_RELATION}.${field}` });
  } catch (error) {
    if (error instanceof CatalogueValueError) catalogueFailure("catalogue_json_shape_conflict", SOURCE_RELATION, field);
    throw error;
  }
  if (!document) catalogueFailure("catalogue_json_shape_conflict", SOURCE_RELATION, field);
  if (document.topLevelType !== "array") {
    // M1 requires jsonb_typeof(weighted_tags) = 'array'.  A legacy object is
    // a reported conflict, never wrapped in a one-element array: wrapping
    // would change what the document means.
    catalogueFailure("catalogue_json_shape_conflict", SOURCE_RELATION, field);
  }
  return { text: document.sourceText, utf8Bytes: document.utf8Bytes };
}

/** Convert the shared map parser's identity failures into this transform's
 * stable public error class.  A malformed source AppID is a catalogue input
 * problem; a valid AppID absent from the same-run map is handled separately by
 * the lookup below as `catalogue_game_unmapped`. */
function parseCatalogueAppId(
  value: string | null | undefined,
  relation: string,
  field: string,
): { text: string; value: bigint } {
  try {
    return parseSteamAppIdText(value, relation, field);
  } catch (error) {
    if (error instanceof GameMapError) {
      catalogueFailure(
        error.gameMapCode === "game_map_app_id_out_of_range" ? "catalogue_invalid_integer" : "catalogue_input_invalid",
        relation,
        field,
      );
    }
    throw error;
  }
}

function validateRunIdentity(value: unknown): GameMapRunIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    catalogueFailure("catalogue_run_invalid", "run_identity");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.runId !== "string" || typeof candidate.snapshotHash !== "string") {
    catalogueFailure("catalogue_run_invalid", "run_identity");
  }
  if (!RUN_ID_TEXT.test(candidate.runId) || !SHA256_TEXT.test(candidate.snapshotHash)) {
    catalogueFailure("catalogue_run_invalid", "run_identity");
  }
  return Object.freeze({ runId: candidate.runId, snapshotHash: candidate.snapshotHash });
}

function validateOfferPolicy(value: unknown): { provider: string; retentionUntil: PgTimestamp } {
  const policy = asObject(value, "offer_policy");
  const provider = policy.provider;
  if (typeof provider !== "string") catalogueFailure("catalogue_offer_policy_invalid", "offer_policy", "provider");
  const providerLength = pgLength(pgBtrim(provider));
  if (providerLength < 1 || providerLength > 120) {
    catalogueFailure("catalogue_offer_policy_invalid", "offer_policy", "provider");
  }
  const retentionText = policy.retentionUntil;
  if (typeof retentionText !== "string") {
    catalogueFailure("catalogue_offer_policy_invalid", "offer_policy", "retentionUntil");
  }
  let retentionUntil: PgTimestamp | null;
  try {
    retentionUntil = parsePgTimestamptz(retentionText, { field: "offer_policy.retentionUntil" });
  } catch (error) {
    if (error instanceof ScalarError) catalogueFailure("catalogue_offer_policy_invalid", "offer_policy", "retentionUntil");
    throw error;
  }
  if (!retentionUntil) catalogueFailure("catalogue_offer_policy_invalid", "offer_policy", "retentionUntil");
  return { provider, retentionUntil };
}

/* -------------------------------------------------------------------------
 * The transform
 * ---------------------------------------------------------------------- */

type GateAccumulator = Map<string, number>;

function noteGate(gates: GateAccumulator, key: string, bytes: number): void {
  const current = gates.get(key) ?? 0;
  if (bytes > current) gates.set(key, bytes);
}

const DECK_TRI_STATE: Readonly<Record<number, TriState>> = Object.freeze({
  // Valve's four-way category, confirmed against the live filter
  // `(deckCompatibility ?? 0) >= 2` in lib/global-filters.ts.
  0: "unknown",
  1: "unsupported",
  2: "supported",
  3: "supported",
});

/**
 * Convert the complete `catalog_games` union into deterministic target rows.
 *
 * The caller supplies the same-run map from `buildGameMap`, which is what
 * makes the catalogue identities and the library identities joinable.  The map
 * proves a catalogue row exists; it never confers ownership or access.
 */
export function transformCatalogue(
  input: CatalogueTransformInput,
  options: CatalogueTransformOptions = {},
): CatalogueTransformResult {
  const root = asObject(input, "catalogue_input");
  const run = validateRunIdentity(root.runIdentity);
  const maxRows = options.maxRows ?? 1_000_000;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > Number(TARGET_INTEGER_MAX)) {
    catalogueFailure("catalogue_count_limit", "catalogue_input", "maxRows");
  }

  const map = root.gameMap as GameMap;
  try {
    assertGameMapRunIdentity(map, run);
  } catch (error) {
    if (error instanceof GameMapError) {
      catalogueFailure(
        error.gameMapCode === "game_map_mixed_run_identity" ? "catalogue_mixed_run_identity" : "catalogue_input_invalid",
        "game_map",
      );
    }
    throw error;
  }

  const rows = ensureArray(root.rows, SOURCE_RELATION) as readonly CatalogGamesSourceRow[];
  const sightings =
    root.sightings === undefined
      ? []
      : (ensureArray(root.sightings, SIGHTING_SOURCE_RELATION) as readonly CatalogGameSightingsSourceRow[]);
  const stubs = root.stubs === undefined ? [] : (ensureArray(root.stubs, "catalogue_stubs") as readonly GameStubTargetRecord[]);
  if (rows.length > maxRows || rows.length + stubs.length + sightings.length > maxRows) {
    catalogueFailure("catalogue_count_limit", "catalogue_input", "maxRows");
  }

  const offerPolicy = root.offerPolicy === undefined ? null : validateOfferPolicy(root.offerPolicy);

  const games: CatalogueGameTargetRecord[] = [];
  const metadata: CatalogueGameMetadataTargetRecord[] = [];
  const features: CatalogueGameFeaturesTargetRecord[] = [];
  const offers: CatalogueOfferTargetRecord[] = [];
  const offerPrices: CatalogueOfferPriceTargetRecord[] = [];
  const reviewDecisions: CatalogueReviewDecisionTargetRecord[] = [];
  const providerState: CatalogueTagsProviderStateRecord[] = [];
  const reconciliation: CatalogueReconciliationRecord[] = [];
  const gameSightingsByAppId = new Map<string, CatalogueGameSightingsTargetRecord>();
  const seenDedicatedSightings = new Set<string>();
  const gates: GateAccumulator = new Map();
  const seenAppIds = new Set<string>();
  const mappedFromSource = new Set<number>();

  for (const raw of rows) {
    const row = asObject(raw, SOURCE_RELATION);
    checkRowRunIdentity(row, run);

    // Every source column must be present.  A missing column is a broken
    // export shape, not an absent value, and reading `undefined` as NULL would
    // turn a truncated row into a plausible one.
    for (const column of CATALOG_GAMES_SOURCE_COLUMNS) {
      if (!(column in row)) catalogueFailure("catalogue_input_invalid", SOURCE_RELATION, column);
    }

    const appId = parseCatalogueAppId(cell(row, "steam_appid"), SOURCE_RELATION, "steam_appid");
    if (seenAppIds.has(appId.text)) catalogueFailure("catalogue_duplicate_row", SOURCE_RELATION, "steam_appid");
    seenAppIds.add(appId.text);

    let gameId: number;
    try {
      gameId = lookupGameId(map, appId.text);
    } catch (error) {
      if (error instanceof GameMapError) catalogueFailure("catalogue_game_unmapped", SOURCE_RELATION, "steam_appid");
      throw error;
    }
    // The map is the one place that decided provenance; a real catalogue row
    // must agree that the map also resolved this AppID as `catalog_games`,
    // never as a stub the map only accepted because nothing else supplied it.
    if (gameMapEntryKind(map, appId.text) !== "catalog_games") {
      catalogueFailure("catalogue_source_kind_mismatch", SOURCE_RELATION, "steam_appid");
    }
    mappedFromSource.add(gameId);

    /* ---- catalog.games ---- */
    const title = boundedText(cell(row, "name"), "name", {
      nullable: false,
      maxLength: 500,
      requireTrimmedContent: true,
    }) as string;
    const normalizedSortTitle = boundedText(cell(row, "normalized_name"), "normalized_name", {
      nullable: false,
      maxLength: 500,
      requireTrimmedContent: false,
    }) as string;
    if (pgLength(normalizedSortTitle) < 1) catalogueFailure("catalogue_text_bounds", SOURCE_RELATION, "normalized_name");

    const firstSeenAt = timestamp(cell(row, "first_seen_at"), "first_seen_at", true) as PgTimestamp;
    const lastSeenAt = timestamp(cell(row, "last_seen_at"), "last_seen_at", true) as PgTimestamp;
    if (lastSeenAt.epochMicros < firstSeenAt.epochMicros) {
      // M3 games_seen_order_chk. The source has no such check, so this is a
      // real conflict; clamping either instant would rewrite a source fact.
      catalogueFailure("catalogue_seen_order_conflict", SOURCE_RELATION, "last_seen_at");
    }
    const updatedAt = timestamp(cell(row, "updated_at"), "updated_at", true) as PgTimestamp;
    // These columns are retired from the compact catalogue destinations, but
    // they still belong to the accepted 58-column source shape.  Validate
    // their COPY representation before retirement so a malformed source row
    // cannot be called complete merely because its retry/creation facts are
    // later rebuilt or de-duplicated.
    timestamp(cell(row, "created_at"), "created_at", true);
    const tagsProcessingStartedAt = timestamp(
      nullableCell(row, "tags_processing_started_at"),
      "tags_processing_started_at",
      false,
    );
    const tagsNextAttemptAt = timestamp(nullableCell(row, "tags_next_attempt_at"), "tags_next_attempt_at", false);
    const firstSeenReason = enumCell(cell(row, "first_seen_reason"), "first_seen_reason", [
      "seed",
      "user_import",
      "manual",
      "unknown",
    ] as const, true) as "seed" | "user_import" | "manual" | "unknown";

    games.push(
      Object.freeze({
        id: gameId,
        steam_app_id: appId.text,
        title,
        normalized_sort_title: normalizedSortTitle,
        title_source: "existing" as const,
        first_seen_at: firstSeenAt,
        first_seen_reason: firstSeenReason,
        last_seen_at: lastSeenAt,
        updated_at: updatedAt,
        source_kind: "catalog_games" as const,
      }),
    );

    /* ---- catalog.game_metadata ---- */
    const genres = jsonArrayFromPgArray(cell(row, "genres"), "genres");
    const categories = jsonArrayFromPgArray(cell(row, "categories"), "categories");
    const weightedTags = jsonArrayDocument(cell(row, "tags"), "tags");
    noteGate(gates, "catalog.game_metadata.genres", Buffer.byteLength(genres.text, "utf8"));
    noteGate(gates, "catalog.game_metadata.categories", Buffer.byteLength(categories.text, "utf8"));
    noteGate(gates, "catalog.game_metadata.weighted_tags", weightedTags.utf8Bytes);
    const metadataFetchedAt = timestamp(cell(row, "metadata_fetched_at"), "metadata_fetched_at", true) as PgTimestamp;
    const releaseDate = civilDate(nullableCell(row, "release_date"), "release_date");

    metadata.push(
      Object.freeze({
        game_id: gameId,
        developer: boundedText(nullableCell(row, "developer"), "developer", {
          nullable: true,
          maxLength: 1000,
          requireTrimmedContent: false,
        }),
        publisher: boundedText(nullableCell(row, "publisher"), "publisher", {
          nullable: true,
          maxLength: 1000,
          requireTrimmedContent: false,
        }),
        short_description: boundedText(nullableCell(row, "short_description"), "short_description", {
          nullable: true,
          maxLength: 10_000,
          requireTrimmedContent: false,
        }),
        header_image_url: boundedText(nullableCell(row, "header_url"), "header_url", {
          nullable: true,
          maxLength: 2048,
          requireTrimmedContent: false,
        }),
        capsule_image_url: boundedText(nullableCell(row, "capsule_url"), "capsule_url", {
          nullable: true,
          maxLength: 2048,
          requireTrimmedContent: false,
        }),
        genres: genres.text,
        categories: categories.text,
        weighted_tags: weightedTags.text,
        release_date: releaseDate,
        fetched_at: metadataFetchedAt,
        updated_at: updatedAt,
        genres_elements: genres.elements,
        categories_elements: categories.elements,
      }),
    );

    /* ---- catalog.game_features ---- */
    const deckDetailParsed = integerText(nullableCell(row, "deck_compatibility"), "deck_compatibility", {
      min: BigInt(-32768),
      max: TARGET_SMALLINT_MAX,
    });
    let deckDetail: number | null = null;
    if (deckDetailParsed !== null) {
      const detail = Number(deckDetailParsed);
      if (detail < 0 || detail > 3) catalogueFailure("catalogue_deck_detail_invalid", SOURCE_RELATION, "deck_compatibility");
      deckDetail = detail;
    }
    const deckTriState: TriState = deckDetail === null ? "unknown" : DECK_TRI_STATE[deckDetail];

    const durationSourceGameIdText = nullableCell(row, "duration_source_game_id");
    let durationSourceGameId: string | null = null;
    if (durationSourceGameIdText !== null) {
      let parsed: bigint | null = null;
      try {
        parsed = parsePgInteger(durationSourceGameIdText, {
          minInclusive: BigInt(1),
          maxInclusive: PG_BIGINT_MAX,
          field: `${SOURCE_RELATION}.duration_source_game_id`,
        });
      } catch (error) {
        if (!(error instanceof ScalarError)) throw error;
        parsed = null;
      }
      if (parsed === null || parsed.toString(10) !== durationSourceGameIdText) {
        // The source column is text and the destination is bigint.  A provider
        // identifier that is not exact positive decimal text has no lossless
        // destination; it is a reported physical gap, never a coerced number.
        catalogueFailure(
          "catalogue_duration_source_game_id_unrepresentable",
          SOURCE_RELATION,
          "duration_source_game_id",
        );
      }
      durationSourceGameId = parsed.toString(10);
    }

    const tagsLastError = boundedText(nullableCell(row, "tags_last_error"), "tags_last_error", {
      nullable: true,
      maxLength: 2000,
      requireTrimmedContent: false,
    });

    features.push(
      Object.freeze({
        game_id: gameId,
        deck_compatibility: deckTriState,
        linux_compatibility: triStateFromBoolean(booleanCell(nullableCell(row, "platform_linux"), "platform_linux", false)),
        windows_compatibility: triStateFromBoolean(
          booleanCell(nullableCell(row, "platform_windows"), "platform_windows", false),
        ),
        mac_compatibility: triStateFromBoolean(booleanCell(nullableCell(row, "platform_mac"), "platform_mac", false)),
        deck_compatibility_detail: deckDetail,
        deck_checked_at: timestamp(nullableCell(row, "deck_checked_at"), "deck_checked_at", false),
        main_duration_minutes: nonNegativeIntegerNumber(nullableCell(row, "main_story_minutes"), "main_story_minutes"),
        extras_duration_minutes: nonNegativeIntegerNumber(nullableCell(row, "main_extras_minutes"), "main_extras_minutes"),
        completion_duration_minutes: nonNegativeIntegerNumber(
          nullableCell(row, "completionist_minutes"),
          "completionist_minutes",
        ),
        duration_source: boundedText(nullableCell(row, "duration_source"), "duration_source", {
          nullable: true,
          maxLength: 120,
          requireTrimmedContent: true,
        }),
        duration_source_game_id: durationSourceGameId,
        duration_source_updated_at: timestamp(
          nullableCell(row, "duration_source_updated_at"),
          "duration_source_updated_at",
          false,
        ),
        // D-CAT-3: the ordinal label is preserved and NULL stays NULL.  NULL
        // is not 'none': 'none' is a stated absence of confidence and NULL is
        // an unrecorded one.
        duration_confidence_label: enumCell(nullableCell(row, "duration_confidence"), "duration_confidence", [
          "none",
          "low",
          "medium",
          "high",
        ] as const, false),
        duration_status: enumCell(cell(row, "duration_status"), "duration_status", [
          "pending",
          "processing",
          "ready",
          "failed",
          "no_match",
          "review_required",
        ] as const, true) as CatalogueGameFeaturesTargetRecord["duration_status"],
        duration_kind: enumCell(cell(row, "duration_kind"), "duration_kind", [
          "finite",
          "endless",
          "not-applicable",
          "unknown",
        ] as const, true) as CatalogueGameFeaturesTargetRecord["duration_kind"],
        duration_manual_override: booleanCell(
          cell(row, "duration_manual_override"),
          "duration_manual_override",
          true,
        ) as boolean,
        review_positive: nonNegativeBigintText(cell(row, "review_positive"), "review_positive", SOURCE_RELATION, true),
        review_negative: nonNegativeBigintText(cell(row, "review_negative"), "review_negative", SOURCE_RELATION, true),
        review_total: nonNegativeBigintText(nullableCell(row, "review_total"), "review_total"),
        popularity_rank: nonNegativeBigintText(nullableCell(row, "popularity_rank"), "popularity_rank"),
        popularity_source: boundedText(nullableCell(row, "popularity_source"), "popularity_source", {
          nullable: true,
          maxLength: 120,
          requireTrimmedContent: true,
        }),
        popularity_metric: boundedText(nullableCell(row, "popularity_metric"), "popularity_metric", {
          nullable: true,
          maxLength: 120,
          requireTrimmedContent: true,
        }),
        popularity_low: nonNegativeBigintText(nullableCell(row, "popularity_low"), "popularity_low"),
        popularity_high: nonNegativeBigintText(nullableCell(row, "popularity_high"), "popularity_high"),
        popularity_ccu: nonNegativeBigintText(nullableCell(row, "popularity_ccu"), "popularity_ccu"),
        source_captured_on: civilDate(nullableCell(row, "source_captured_at"), "source_captured_at"),
        tags_source: boundedText(nullableCell(row, "tags_source"), "tags_source", {
          nullable: true,
          maxLength: 120,
          requireTrimmedContent: true,
        }),
        tags_status: enumCell(cell(row, "tags_status"), "tags_status", [
          "pending",
          "processing",
          "ready",
          "failed",
        ] as const, true) as CatalogueGameFeaturesTargetRecord["tags_status"],
        tags_fetched_at: timestamp(nullableCell(row, "tags_fetched_at"), "tags_fetched_at", false),
        tags_failure_count: nonNegativeIntegerNumber(cell(row, "tags_failure_count"), "tags_failure_count", true) as number,
        tags_last_error: tagsLastError,
        updated_at: updatedAt,
      }),
    );

    /* ---- catalog.provider_state (tags scheduling) ---- */
    const tagsStatus = features[features.length - 1].tags_status;
    const tagsFailureCount = features[features.length - 1].tags_failure_count;
    // The frozen source CHECK permits only pending/processing/ready/failed,
    // so every source row carries real tag lifecycle state. The provider that
    // owns a pending/failed attempt is not necessarily `tags_source`: the
    // current worker leaves the previous successful source untouched while a
    // refresh is queued or fails. Attribute only a ready result; keep active
    // scheduling/failure state honestly unattributed.
    providerState.push(
      Object.freeze({
          game_id: gameId,
          provider:
            tagsStatus === "ready"
              ? features[features.length - 1].tags_source ?? TAGS_UNATTRIBUTED_PROVIDER
              : TAGS_UNATTRIBUTED_PROVIDER,
          evidence_kind: "tags" as const,
          status: tagsStatus,
          failure_count: tagsFailureCount,
          // The target permits a fence only for pending/failed/review_required
          // and a lease only while processing/failed.
          next_attempt_at: tagsStatus === "pending" || tagsStatus === "failed" ? tagsNextAttemptAt : null,
          processing_started_at:
            tagsStatus === "processing" || tagsStatus === "failed" ? tagsProcessingStartedAt : null,
          fetched_at: features[features.length - 1].tags_fetched_at,
          last_error_code: null,
          last_error: tagsLastError,
          source_snapshot_hash: run.snapshotHash,
          updated_at: updatedAt,
        }),
    );

    /* ---- catalog.offers and catalog.offer_prices ---- */
    const priceCurrency = nullableCell(row, "price_currency");
    const priceInitial = nonNegativeIntegerNumber(nullableCell(row, "price_initial"), "price_initial");
    const priceFinal = nonNegativeIntegerNumber(nullableCell(row, "price_final"), "price_final");
    const parsedDiscountPercent = integerText(cell(row, "discount_percent"), "discount_percent", {
      min: ZERO,
      max: BigInt(100),
    });
    if (parsedDiscountPercent === null) catalogueFailure("catalogue_invalid_integer", SOURCE_RELATION, "discount_percent");
    const discountPercent = parsedDiscountPercent;
    const isFree = booleanCell(cell(row, "is_free"), "is_free", true) as boolean;

    const hasAmount = priceInitial !== null || priceFinal !== null;
    if (priceCurrency !== null && priceCurrency !== "USD") {
      // The source CHECK guarantees NULL or USD, which is what makes these
      // real US observations rather than converted ones.  Anything else has
      // no destination: catalog.offer_prices.currency is CHECK (= 'USD').
      catalogueFailure("catalogue_physical_gap", SOURCE_RELATION, "price_currency");
    }
    if (priceCurrency === null && hasAmount) {
      // Cents with no stated currency. Asserting USD would fabricate a
      // currency; dropping the amount would lose a source observation.
      catalogueFailure("catalogue_price_currency_unstated", SOURCE_RELATION, "price_currency");
    }
    if (priceCurrency === null && discountPercent !== ZERO) {
      catalogueFailure("catalogue_price_discount_without_currency", SOURCE_RELATION, "discount_percent");
    }
    if (priceInitial !== null && priceFinal !== null && priceFinal > priceInitial) {
      catalogueFailure("catalogue_price_conflict", SOURCE_RELATION, "price_final");
    }

    const hasOffer = priceCurrency !== null || hasAmount || isFree;
    if (hasOffer) {
      if (!offerPolicy) catalogueFailure("catalogue_offer_policy_missing", "offer_policy", "provider");
      if (offerPolicy.retentionUntil.epochMicros < metadataFetchedAt.epochMicros) {
        // catalog.offer_prices CHECK (retention_until >= observed_at).
        catalogueFailure("catalogue_offer_policy_invalid", "offer_policy", "retentionUntil");
      }
      const offerRef = offers.length + 1;
      offers.push(
        Object.freeze({
          offer_ref: offerRef,
          game_id: gameId,
          provider: offerPolicy.provider,
          region_code: "US" as const,
          is_free: isFree,
          first_observed_at: metadataFetchedAt,
          last_observed_at: metadataFetchedAt,
          source_snapshot_hash: run.snapshotHash,
          observed_at_source: "catalog_games.metadata_fetched_at" as const,
        }),
      );
      if (priceCurrency === "USD") {
        offerPrices.push(
          Object.freeze({
            offer_ref: offerRef,
            game_id: gameId,
            provider: offerPolicy.provider,
            region_code: "US" as const,
            observed_at: metadataFetchedAt,
            currency: "USD" as const,
            price_initial_cents: priceInitial,
            price_final_cents: priceFinal,
            discount_percent: Number(discountPercent),
            is_free: isFree,
            is_current: true as const,
            retention_until: offerPolicy.retentionUntil,
            source_snapshot_hash: run.snapshotHash,
            observed_at_source: "catalog_games.metadata_fetched_at" as const,
          }),
        );
      }
    }

    /* ---- catalog.review_decisions: legacy classification evidence ---- */
    const steamType = boundedText(cell(row, "steam_type"), "steam_type", {
      nullable: false,
      maxLength: 120,
      requireTrimmedContent: true,
    }) as string;
    if (steamType !== "game") {
      // D-CAT-1 settles the destination for a value the source CHECK forced to
      // 'game'.  A different value is a real provider classification the
      // settled rule does not cover, so it is returned as a concrete
      // unresolved case rather than recorded under the same evidence label.
      catalogueFailure("catalogue_classification_unresolved", SOURCE_RELATION, "steam_type");
    }
    reviewDecisions.push(
      Object.freeze({
        game_id: gameId,
        steam_app_id: appId.text,
        decision_kind: "catalogue_type" as const,
        source_relation: "catalog_games" as const,
        source_record_key: appId.text,
        source: LEGACY_CLASSIFICATION_SOURCE,
        precedence_rank: CATALOGUE_DECISION_PRECEDENCE.legacy_catalog_games,
        decision_status: "retained" as const,
        steam_type: steamType,
        reason: LEGACY_CLASSIFICATION_REASON,
        duration_manual_override: false as const,
        created_at: firstSeenAt,
        updated_at: updatedAt,
        source_snapshot_hash: run.snapshotHash,
        created_at_source: "catalog_games.first_seen_at" as const,
        updated_at_source: "catalog_games.updated_at" as const,
      }),
    );

    /* ---- retired counters that still need reconciling ---- */
    reconciliation.push(
      Object.freeze({
        game_id: gameId,
        steam_app_id: appId.text,
        import_sighting_count: nonNegativeBigintText(
          cell(row, "import_sighting_count"),
          "import_sighting_count",
          SOURCE_RELATION,
          true,
        ) as string,
        users_that_imported: nonNegativeBigintText(
          cell(row, "users_that_imported"),
          "users_that_imported",
          SOURCE_RELATION,
          true,
        ) as string,
      }),
    );

    // `catalog_games` duplicates the durable sighting relation's aggregate
    // facts.  Keep that copy available even when the dedicated source relation
    // is not part of this bounded transform call; if it is supplied below, the
    // two copies are compared exactly before one target row is emitted.
    gameSightingsByAppId.set(
      appId.text,
      Object.freeze({
        steam_app_id: appId.text,
        game_id: gameId,
        import_count: reconciliation[reconciliation.length - 1].import_sighting_count,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        source_snapshot_hash: run.snapshotHash,
        source_relation: SOURCE_RELATION,
      }),
    );
  }

  /* ---- stub catalogue rows ---- */
  for (const raw of stubs) {
    // `stubs` crosses a module boundary: the caller may hand in any object
    // shaped like a `GameStubTargetRecord`, not only one this module's own
    // builder produced.  Re-validate it against the documented stub rule
    // rather than trusting the shape — a copied record with, say, a null or
    // truncated title must be refused here, not accepted as a valid game.
    let stub: GameStubTargetRecord;
    try {
      stub = validateGameStubTargetRecord(raw, "catalogue_stubs");
    } catch (error) {
      if (error instanceof GameMapError) {
        catalogueFailure("catalogue_stub_invalid", "catalogue_stubs", error.diagnostics[0]?.field ?? null);
      }
      throw error;
    }
    if (stub.source_snapshot_hash !== run.snapshotHash) {
      catalogueFailure("catalogue_mixed_run_identity", "catalogue_stubs");
    }
    const appId = parseCatalogueAppId(stub.legacy_app_id, "catalogue_stubs", "steam_appid");
    if (seenAppIds.has(appId.text)) catalogueFailure("catalogue_duplicate_row", "catalogue_stubs", "steam_appid");
    seenAppIds.add(appId.text);
    let gameId: number;
    try {
      gameId = lookupGameId(map, appId.text);
    } catch (error) {
      if (error instanceof GameMapError) catalogueFailure("catalogue_game_unmapped", "catalogue_stubs", "steam_appid");
      throw error;
    }
    if (gameId !== stub.game_id) catalogueFailure("catalogue_game_unmapped", "catalogue_stubs", "game_id");
    // The inverse of the catalogue-row check: a stub row must agree that the
    // map actually resolved this AppID as a stub, never as a real catalogued
    // identity the caller is trying to re-supply through the stub channel.
    if (gameMapEntryKind(map, appId.text) !== "stub") {
      catalogueFailure("catalogue_source_kind_mismatch", "catalogue_stubs", "steam_appid");
    }
    mappedFromSource.add(gameId);
    games.push(
      Object.freeze({
        id: gameId,
        steam_app_id: appId.text,
        title: stub.title,
        normalized_sort_title: stub.normalized_sort_title,
        title_source: "catalog_stub" as const,
        // A stub has no source instant of any kind.  These stay NULL rather
        // than borrowing the referencing row's clock.
        first_seen_at: null,
        first_seen_reason: "unknown" as const,
        last_seen_at: null,
        updated_at: null,
        source_kind: "stub" as const,
      }),
    );
  }

  /* ---- dedicated catalog.game_sightings source rows ---- */
  for (const raw of sightings) {
    const row = asObject(raw, SIGHTING_SOURCE_RELATION);
    checkRowRunIdentity(row, run, SIGHTING_SOURCE_RELATION);
    for (const column of CATALOG_GAME_SIGHTINGS_SOURCE_COLUMNS) {
      if (!(column in row)) catalogueFailure("catalogue_input_invalid", SIGHTING_SOURCE_RELATION, column);
    }

    const appId = parseCatalogueAppId(
      relationCell(row, "steam_appid", SIGHTING_SOURCE_RELATION),
      SIGHTING_SOURCE_RELATION,
      "steam_appid",
    );
    if (seenDedicatedSightings.has(appId.text)) {
      catalogueFailure("catalogue_duplicate_row", SIGHTING_SOURCE_RELATION, "steam_appid");
    }
    seenDedicatedSightings.add(appId.text);

    const importCount = nonNegativeBigintText(
      relationCell(row, "import_count", SIGHTING_SOURCE_RELATION),
      "import_count",
      SIGHTING_SOURCE_RELATION,
    );
    const firstSeenAt = timestamp(
      relationCell(row, "first_seen_at", SIGHTING_SOURCE_RELATION),
      "first_seen_at",
      true,
      SIGHTING_SOURCE_RELATION,
    ) as PgTimestamp;
    const lastSeenAt = timestamp(
      relationCell(row, "last_seen_at", SIGHTING_SOURCE_RELATION),
      "last_seen_at",
      true,
      SIGHTING_SOURCE_RELATION,
    ) as PgTimestamp;
    if (lastSeenAt.epochMicros < firstSeenAt.epochMicros) {
      catalogueFailure("catalogue_seen_order_conflict", SIGHTING_SOURCE_RELATION, "last_seen_at");
    }
    if (importCount === null) {
      // `catalog_game_sightings.import_count` is NOT NULL in the source and
      // target.  Keep the null diagnosis distinct from a malformed integer.
      catalogueFailure("catalogue_invalid_integer", SIGHTING_SOURCE_RELATION, "import_count");
    }

    let gameId: number | null = null;
    try {
      gameId = hasGameId(map, appId.text) ? lookupGameId(map, appId.text) : null;
    } catch (error) {
      if (error instanceof GameMapError) catalogueFailure("catalogue_input_invalid", "game_map");
      throw error;
    }

    const existing = gameSightingsByAppId.get(appId.text);
    if (existing !== undefined) {
      if (
        existing.import_count !== importCount ||
        existing.first_seen_at.epochMicros !== firstSeenAt.epochMicros ||
        existing.last_seen_at.epochMicros !== lastSeenAt.epochMicros
      ) {
        // The duplicate counter is a source fact, not a preference.  A
        // disagreement is retained as a stable conflict so neither relation
        // is silently discarded.
        catalogueFailure("catalogue_sighting_conflict", SIGHTING_SOURCE_RELATION, "steam_appid");
      }
    }

    gameSightingsByAppId.set(
      appId.text,
      Object.freeze({
        steam_app_id: appId.text,
        game_id: existing?.game_id ?? gameId,
        import_count: importCount,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        source_snapshot_hash: run.snapshotHash,
        source_relation: SIGHTING_SOURCE_RELATION,
      }),
    );
  }

  // Every map entry must be accounted for.  A map that claims an identity the
  // catalogue rows do not contain would leave a `catalog.games` row missing
  // and a foreign key unsatisfiable at load time.
  for (const entry of map.entries) {
    if (!mappedFromSource.has(entry.game_id)) {
      catalogueFailure("catalogue_map_unmatched", "game_map", "game_id");
    }
  }

  const byId = (left: { game_id?: number; id?: number }, right: { game_id?: number; id?: number }): number =>
    (left.game_id ?? left.id ?? 0) - (right.game_id ?? right.id ?? 0);
  games.sort(byId);
  metadata.sort(byId);
  features.sort(byId);
  reviewDecisions.sort(byId);
  reconciliation.sort(byId);
  const gameSightings = [...gameSightingsByAppId.values()];
  gameSightings.sort((left, right) => {
    if (left.game_id !== null && right.game_id !== null && left.game_id !== right.game_id) {
      return left.game_id - right.game_id;
    }
    if (left.game_id === null && right.game_id !== null) return 1;
    if (left.game_id !== null && right.game_id === null) return -1;
    const leftValue = BigInt(left.steam_app_id);
    const rightValue = BigInt(right.steam_app_id);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });

  // `catalog.offers.id` is generated by the target, so `offer_ref` is only a
  // transform-local join key.  Assign it after sorting by the deterministic
  // game identity; assigning it while reading rows would make the price join
  // depend on COPY order and would change on a retry with the same snapshot.
  offers.sort(byId);
  const offerRefByGameId = new Map<number, number>();
  for (let index = 0; index < offers.length; index += 1) {
    const offer = offers[index];
    const offerRef = index + 1;
    offerRefByGameId.set(offer.game_id, offerRef);
    offers[index] = Object.freeze({ ...offer, offer_ref: offerRef });
  }
  for (let index = 0; index < offerPrices.length; index += 1) {
    const price = offerPrices[index];
    const offerRef = offerRefByGameId.get(price.game_id);
    if (offerRef === undefined) catalogueFailure("catalogue_input_invalid", "offer_prices", "game_id");
    offerPrices[index] = Object.freeze({ ...price, offer_ref: offerRef });
  }
  offerPrices.sort((left, right) => left.offer_ref - right.offer_ref);

  const requiredGates: RequiredSqlGate[] = [
    {
      relation: "catalog.game_metadata",
      column: "genres",
      check: "jsonb_typeof(genres) = 'array' and pg_column_size(genres) <= 32768",
      reason: "pg_column_size measures the encoded, possibly compressed datum; a pure precheck can only measure UTF-8 text.",
      max_source_utf8_bytes: gates.get("catalog.game_metadata.genres") ?? 0,
    },
    {
      relation: "catalog.game_metadata",
      column: "categories",
      check: "jsonb_typeof(categories) = 'array' and pg_column_size(categories) <= 32768",
      reason: "pg_column_size measures the encoded, possibly compressed datum; a pure precheck can only measure UTF-8 text.",
      max_source_utf8_bytes: gates.get("catalog.game_metadata.categories") ?? 0,
    },
    {
      relation: "catalog.game_metadata",
      column: "weighted_tags",
      check: "jsonb_typeof(weighted_tags) = 'array' and pg_column_size(weighted_tags) <= 65536",
      reason: "The array shape is proven here; the encoded size is not provable without the server.",
      max_source_utf8_bytes: gates.get("catalog.game_metadata.weighted_tags") ?? 0,
    },
  ];

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    games: Object.freeze(games),
    game_metadata: Object.freeze(metadata),
    game_features: Object.freeze(features),
    offers: Object.freeze(offers),
    offer_prices: Object.freeze(offerPrices),
    review_decisions: Object.freeze(reviewDecisions),
    provider_state: Object.freeze(providerState),
    game_sightings: Object.freeze(gameSightings),
    reconciliation: Object.freeze(reconciliation),
    required_sql_gates: Object.freeze(requiredGates.map((gate) => Object.freeze(gate))),
    counts: Object.freeze({
      source_rows: rows.length,
      stub_rows: stubs.length,
      offers: offers.length,
      offer_prices: offerPrices.length,
      review_decisions: reviewDecisions.length,
      game_sightings: gameSightings.length,
      provider_state: providerState.length,
    }),
  });
}

/** Make comparisons in tests and reports independent of insertion order. */
export function canonicalCatalogueResult(result: CatalogueTransformResult): string {
  return JSON.stringify({
    run_identity: result.run_identity,
    games: result.games,
    game_metadata: result.game_metadata,
    game_features: result.game_features,
    offers: result.offers,
    offer_prices: result.offer_prices,
    review_decisions: result.review_decisions,
    game_sightings: result.game_sightings,
    reconciliation: result.reconciliation,
  });
}
