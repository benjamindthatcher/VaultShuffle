import { CATALOGUE_DECISION_PRECEDENCE } from "./catalogue.ts";
import { GameMapError, hasGameId, lookupGameId, type GameMap } from "./games.ts";
import { indexAccountMap, type AccountMapIndex } from "./library-shared.ts";
import {
  ProviderTransformError,
  STEAM_APP_ID_MAX,
  TARGET_INTEGER_MAX,
  ZERO,
  asObject,
  boundedText,
  canonicalUuidText,
  cell,
  checkRowLimit,
  checkRowRunIdentity,
  EMPTY_JSON_OBJECT,
  ensureArray,
  enumCell,
  integerText,
  providerFailure,
  requiredIntegerNumber,
  requiredJsonDocument,
  steamAppId,
  timestamp,
  validateProviderRunIdentity,
  type ProviderRunIdentity,
  type ReviewDecisionTargetRecord,
} from "./provider-shared.ts";
import type { PgTimestamp } from "./scalars.ts";
import { isRetiredIgdbSource } from "./hltb-only.ts";

/** HLTB evidence, useful provider-neutral authored aliases/reviews and import
 * provenance. IGDB rows are explicitly discarded. The unattributed legacy
 * duration queue is rebuild-only in the assembler and has no transform/archive.
 */

function gameMapLookupOptional(map: GameMap, appIdText: string, relation: string, field: string): number | null {
  try {
    if (!hasGameId(map, appIdText)) return null;
    return lookupGameId(map, appIdText);
  } catch (error) {
    if (error instanceof GameMapError) providerFailure("provider_input_invalid", relation, field);
    throw error;
  }
}

function gameMapLookupRequired(map: GameMap, appIdText: string, relation: string, field: string): number {
  try {
    return lookupGameId(map, appIdText);
  } catch (error) {
    if (error instanceof GameMapError) providerFailure("provider_game_unmapped", relation, field);
    throw error;
  }
}

/* -------------------------------------------------------------------------
 * game_duration_estimates -> catalog.duration_estimates
 * ---------------------------------------------------------------------- */

const ESTIMATES_RELATION = "game_duration_estimates";

export type DurationEstimateSourceRow = Readonly<{
  steam_app_id: string;
  provider: string;
  provider_game_id: string | null;
  main_story_minutes: string | null;
  main_extra_minutes: string | null;
  completionist_minutes: string | null;
  submission_count: string | null;
  match_status: "matched" | "no_duration" | "not_found" | "ambiguous" | "needs_review";
  match_confidence: "none" | "low" | "medium" | "high" | null;
  provider_updated_at: string | null;
  checked_at: string;
  next_refresh_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  evidence: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const DURATION_ESTIMATES_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_app_id",
  "provider",
  "provider_game_id",
  "main_story_minutes",
  "main_extra_minutes",
  "completionist_minutes",
  "submission_count",
  "match_status",
  "match_confidence",
  "provider_updated_at",
  "checked_at",
  "next_refresh_at",
  "last_error_code",
  "created_at",
  "updated_at",
  "evidence",
]);

export type DurationEstimateTargetRecord = Readonly<{
  game_id: number | null;
  steam_app_id: string;
  provider: string;
  provider_game_id: string | null;
  main_story_minutes: number | null;
  main_extra_minutes: number | null;
  completionist_minutes: number | null;
  submission_count: number | null;
  match_status: string;
  match_confidence: string | null;
  provider_updated_at: PgTimestamp | null;
  checked_at: PgTimestamp;
  next_refresh_at: PgTimestamp | null;
  last_error_code: string | null;
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
  evidence: Readonly<{ text: string; utf8Bytes: number }>;
  source_snapshot_hash: string;
}>;

export type DurationEstimatesTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  gameMap: GameMap;
  rows: readonly DurationEstimateSourceRow[];
}>;

export type DurationEstimatesTransformResult = Readonly<{
  duration_estimates: readonly DurationEstimateTargetRecord[];
  counts: Readonly<{ rows: number; retained: number; retired: number; mapped: number; unmapped: number }>;
}>;

export function transformDurationEstimates(input: DurationEstimatesTransformInput): DurationEstimatesTransformResult {
  const root = asObject(input, "duration_estimates_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const map = root.gameMap as GameMap;
  const rows = ensureArray(root.rows, ESTIMATES_RELATION) as readonly DurationEstimateSourceRow[];
  checkRowLimit(rows, ESTIMATES_RELATION, 5_000_000);

  const estimates: DurationEstimateTargetRecord[] = [];
  const seenKeys = new Set<string>();
  let mapped = 0;
  let retired = 0;

  for (const raw of rows) {
    const row = asObject(raw, ESTIMATES_RELATION);
    checkRowRunIdentity(row, run, ESTIMATES_RELATION);
    for (const column of DURATION_ESTIMATES_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", ESTIMATES_RELATION, column);
    }

    const appId = steamAppId(cell(row, "steam_app_id", ESTIMATES_RELATION), "steam_app_id", ESTIMATES_RELATION);
    const provider = boundedText(cell(row, "provider", ESTIMATES_RELATION), "provider", ESTIMATES_RELATION, {
      nullable: false,
      maxLength: 120,
      requireTrimmedContent: true,
    }) as string;
    const key = `${appId}${provider}`;
    if (seenKeys.has(key)) providerFailure("provider_duplicate_row", ESTIMATES_RELATION, "provider");
    seenKeys.add(key);
    if (isRetiredIgdbSource(provider)) { retired += 1; continue; }
    if (provider !== "hltb") providerFailure("provider_invalid_enum", ESTIMATES_RELATION, "provider");

    // An estimate for an app the catalogue does not (yet) hold still loads,
    // keyed on the raw AppID: a miss is a real, valid case here.
    const gameId = gameMapLookupOptional(map, appId, ESTIMATES_RELATION, "steam_app_id");
    if (gameId !== null) mapped += 1;

    const providerGameId = integerText(
      cell(row, "provider_game_id", ESTIMATES_RELATION),
      "provider_game_id",
      ESTIMATES_RELATION,
      { min: BigInt(1), max: STEAM_APP_ID_MAX },
    );
    const mainStoryMinutes = integerText(
      cell(row, "main_story_minutes", ESTIMATES_RELATION),
      "main_story_minutes",
      ESTIMATES_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const mainExtraMinutes = integerText(
      cell(row, "main_extra_minutes", ESTIMATES_RELATION),
      "main_extra_minutes",
      ESTIMATES_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const completionistMinutes = integerText(
      cell(row, "completionist_minutes", ESTIMATES_RELATION),
      "completionist_minutes",
      ESTIMATES_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const submissionCount = integerText(
      cell(row, "submission_count", ESTIMATES_RELATION),
      "submission_count",
      ESTIMATES_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const matchStatus = enumCell(
      cell(row, "match_status", ESTIMATES_RELATION),
      "match_status",
      ESTIMATES_RELATION,
      ["matched", "no_duration", "not_found", "ambiguous", "needs_review"] as const,
      true,
    ) as string;
    const matchConfidence = enumCell(
      cell(row, "match_confidence", ESTIMATES_RELATION),
      "match_confidence",
      ESTIMATES_RELATION,
      ["none", "low", "medium", "high"] as const,
      false,
    );
    const providerUpdatedAt = timestamp(
      cell(row, "provider_updated_at", ESTIMATES_RELATION),
      "provider_updated_at",
      ESTIMATES_RELATION,
      false,
    );
    const checkedAt = timestamp(cell(row, "checked_at", ESTIMATES_RELATION), "checked_at", ESTIMATES_RELATION, true) as PgTimestamp;
    const nextRefreshAt = timestamp(
      cell(row, "next_refresh_at", ESTIMATES_RELATION),
      "next_refresh_at",
      ESTIMATES_RELATION,
      false,
    );
    const lastErrorCode = boundedText(
      cell(row, "last_error_code", ESTIMATES_RELATION),
      "last_error_code",
      ESTIMATES_RELATION,
      { nullable: true, maxLength: 120, requireTrimmedContent: true },
    );
    const createdAt = timestamp(cell(row, "created_at", ESTIMATES_RELATION), "created_at", ESTIMATES_RELATION, true) as PgTimestamp;
    const updatedAt = timestamp(cell(row, "updated_at", ESTIMATES_RELATION), "updated_at", ESTIMATES_RELATION, true) as PgTimestamp;
    const evidence = requiredJsonDocument(cell(row, "evidence", ESTIMATES_RELATION), "evidence", ESTIMATES_RELATION, "object");

    estimates.push(
      Object.freeze({
        game_id: gameId,
        steam_app_id: appId,
        provider,
        provider_game_id: providerGameId === null ? null : providerGameId.toString(10),
        main_story_minutes: mainStoryMinutes === null ? null : Number(mainStoryMinutes),
        main_extra_minutes: mainExtraMinutes === null ? null : Number(mainExtraMinutes),
        completionist_minutes: completionistMinutes === null ? null : Number(completionistMinutes),
        submission_count: submissionCount === null ? null : Number(submissionCount),
        match_status: matchStatus,
        match_confidence: matchConfidence,
        provider_updated_at: providerUpdatedAt,
        checked_at: checkedAt,
        next_refresh_at: nextRefreshAt,
        last_error_code: lastErrorCode,
        created_at: createdAt,
        updated_at: updatedAt,
        evidence,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({
    duration_estimates: Object.freeze(estimates),
    counts: Object.freeze({ rows: rows.length, retained: estimates.length, retired, mapped, unmapped: estimates.length - mapped }),
  });
}

/* -------------------------------------------------------------------------
 * game_duration_aliases -> catalog.duration_aliases
 * ---------------------------------------------------------------------- */

const ALIASES_RELATION = "game_duration_aliases";
const ONE_BIGINT = BigInt(1);
const NINE_THOUSAND_NINE_HUNDRED_NINETY_NINE = BigInt(9999);

export type DurationAliasSourceRow = Readonly<{
  steam_app_id: string;
  search_title: string;
  release_year: string | null;
  review_status: "approved" | "needs_review" | "rejected";
  notes: string | null;
  created_at: string;
  updated_at: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const DURATION_ALIASES_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_app_id",
  "search_title",
  "release_year",
  "review_status",
  "notes",
  "created_at",
  "updated_at",
]);

export type DurationAliasTargetRecord = Readonly<{
  game_id: number | null;
  steam_app_id: string;
  search_title: string;
  release_year: number | null;
  review_status: string;
  notes: string | null;
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type DurationAliasesTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  gameMap: GameMap;
  rows: readonly DurationAliasSourceRow[];
}>;

export type DurationAliasesTransformResult = Readonly<{
  duration_aliases: readonly DurationAliasTargetRecord[];
  counts: Readonly<{ rows: number; mapped: number; unmapped: number }>;
}>;

export function transformDurationAliases(input: DurationAliasesTransformInput): DurationAliasesTransformResult {
  const root = asObject(input, "duration_aliases_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const map = root.gameMap as GameMap;
  const rows = ensureArray(root.rows, ALIASES_RELATION) as readonly DurationAliasSourceRow[];
  checkRowLimit(rows, ALIASES_RELATION, 1_000_000);

  const aliases: DurationAliasTargetRecord[] = [];
  const seenAppIds = new Set<string>();
  let mapped = 0;

  for (const raw of rows) {
    const row = asObject(raw, ALIASES_RELATION);
    checkRowRunIdentity(row, run, ALIASES_RELATION);
    for (const column of DURATION_ALIASES_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", ALIASES_RELATION, column);
    }

    const appId = steamAppId(cell(row, "steam_app_id", ALIASES_RELATION), "steam_app_id", ALIASES_RELATION);
    if (seenAppIds.has(appId)) providerFailure("provider_duplicate_row", ALIASES_RELATION, "steam_app_id");
    seenAppIds.add(appId);

    // The alias exists precisely to rescue an app whose identity did not
    // match a provider; a miss against the catalogue map is expected.
    const gameId = gameMapLookupOptional(map, appId, ALIASES_RELATION, "steam_app_id");
    if (gameId !== null) mapped += 1;

    const searchTitle = boundedText(
      cell(row, "search_title", ALIASES_RELATION),
      "search_title",
      ALIASES_RELATION,
      { nullable: false, maxLength: 1000, requireTrimmedContent: true },
    ) as string;
    const releaseYear = integerText(cell(row, "release_year", ALIASES_RELATION), "release_year", ALIASES_RELATION, {
      min: ONE_BIGINT,
      max: NINE_THOUSAND_NINE_HUNDRED_NINETY_NINE,
    });
    const reviewStatus = enumCell(
      cell(row, "review_status", ALIASES_RELATION),
      "review_status",
      ALIASES_RELATION,
      ["approved", "needs_review", "rejected"] as const,
      true,
    ) as string;
    const notes = boundedText(cell(row, "notes", ALIASES_RELATION), "notes", ALIASES_RELATION, {
      nullable: true,
      maxLength: 10000,
      requireTrimmedContent: false,
    });
    const createdAt = timestamp(cell(row, "created_at", ALIASES_RELATION), "created_at", ALIASES_RELATION, true) as PgTimestamp;
    const updatedAt = timestamp(cell(row, "updated_at", ALIASES_RELATION), "updated_at", ALIASES_RELATION, true) as PgTimestamp;

    aliases.push(
      Object.freeze({
        game_id: gameId,
        steam_app_id: appId,
        search_title: searchTitle,
        release_year: releaseYear === null ? null : Number(releaseYear),
        review_status: reviewStatus,
        notes,
        created_at: createdAt,
        updated_at: updatedAt,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({
    duration_aliases: Object.freeze(aliases),
    counts: Object.freeze({ rows: rows.length, mapped, unmapped: rows.length - mapped }),
  });
}

/* -------------------------------------------------------------------------
 * catalog_duration_reviews -> catalog.review_decisions (decision_kind='duration')
 * ---------------------------------------------------------------------- */

const DURATION_REVIEWS_RELATION = "catalog_duration_reviews";
/** The fixed provenance text on every migrated duration-review evidence row. */
export const DURATION_REVIEW_SOURCE = "legacy_catalog_duration_reviews";

export type DurationReviewSourceRow = Readonly<{
  steam_appid: string;
  response_text: string;
  response_kind: "hltb_url" | "note";
  source_url: string | null;
  reviewer_user_id: string | null;
  reviewed_at: string;
  updated_at: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const DURATION_REVIEWS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_appid",
  "response_text",
  "response_kind",
  "source_url",
  "reviewer_user_id",
  "reviewed_at",
  "updated_at",
]);

export type DurationReviewsTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  gameMap: GameMap;
  /** The same-run account map produced by the identity transform, or `undefined` if no review names a reviewer. */
  accountMap?: unknown;
  rows: readonly DurationReviewSourceRow[];
}>;

export type DurationReviewsTransformResult = Readonly<{
  review_decisions: readonly ReviewDecisionTargetRecord[];
  counts: Readonly<{ rows: number; reviewer_mapped: number; reviewer_deleted: number }>;
}>;

export function transformDurationReviews(input: DurationReviewsTransformInput): DurationReviewsTransformResult {
  const root = asObject(input, "duration_reviews_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const map = root.gameMap as GameMap;
  const rows = ensureArray(root.rows, DURATION_REVIEWS_RELATION) as readonly DurationReviewSourceRow[];
  checkRowLimit(rows, DURATION_REVIEWS_RELATION, 1_000_000);

  let accountMap: AccountMapIndex | null = null;
  const needsAccountMap = rows.some((raw) => {
    const row = raw as Record<string, unknown>;
    return typeof row.reviewer_user_id === "string";
  });
  if (needsAccountMap) {
    if (root.accountMap === undefined) providerFailure("provider_account_map_invalid", DURATION_REVIEWS_RELATION);
    accountMap = indexAccountMap(root.accountMap, run);
  }

  const decisions: ReviewDecisionTargetRecord[] = [];
  const seenAppIds = new Set<string>();
  let reviewerMapped = 0;
  let reviewerDeleted = 0;

  for (const raw of rows) {
    const row = asObject(raw, DURATION_REVIEWS_RELATION);
    checkRowRunIdentity(row, run, DURATION_REVIEWS_RELATION);
    for (const column of DURATION_REVIEWS_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", DURATION_REVIEWS_RELATION, column);
    }

    const appId = steamAppId(cell(row, "steam_appid", DURATION_REVIEWS_RELATION), "steam_appid", DURATION_REVIEWS_RELATION);
    if (seenAppIds.has(appId)) providerFailure("provider_duplicate_row", DURATION_REVIEWS_RELATION, "steam_appid");
    seenAppIds.add(appId);

    // The source enforces `steam_appid references catalog_games`, so an
    // unmapped identity here is a genuine transform-boundary failure, unlike
    // quarantine or aliases where an unmapped app is expected.
    const gameId = gameMapLookupRequired(map, appId, DURATION_REVIEWS_RELATION, "steam_appid");

    const responseText = boundedText(
      cell(row, "response_text", DURATION_REVIEWS_RELATION),
      "response_text",
      DURATION_REVIEWS_RELATION,
      { nullable: false, maxLength: 2000, requireTrimmedContent: true },
    ) as string;
    const responseKind = enumCell(
      cell(row, "response_kind", DURATION_REVIEWS_RELATION),
      "response_kind",
      DURATION_REVIEWS_RELATION,
      ["hltb_url", "note"] as const,
      true,
    ) as "hltb_url" | "note";
    const sourceUrl = boundedText(
      cell(row, "source_url", DURATION_REVIEWS_RELATION),
      "source_url",
      DURATION_REVIEWS_RELATION,
      { nullable: true, maxLength: 2048, requireTrimmedContent: false },
    );
    // Mirrors the target CHECK exactly: an 'hltb_url' response always names
    // its source, a 'note' never does. The source enforces the identical
    // check, so a mismatch here is defensive, not an expected finding.
    if (responseKind === "hltb_url" && sourceUrl === null) {
      providerFailure("provider_json_shape_conflict", DURATION_REVIEWS_RELATION, "source_url");
    }
    if (responseKind === "note" && sourceUrl !== null) {
      providerFailure("provider_json_shape_conflict", DURATION_REVIEWS_RELATION, "source_url");
    }

    const reviewerUserId = canonicalUuidText(
      cell(row, "reviewer_user_id", DURATION_REVIEWS_RELATION),
      "reviewer_user_id",
      DURATION_REVIEWS_RELATION,
      false,
    );
    let reviewerAccountId: number | null = null;
    if (reviewerUserId !== null) {
      if (accountMap && accountMap.has(reviewerUserId)) {
        reviewerAccountId = accountMap.lookup(reviewerUserId);
        reviewerMapped += 1;
      } else {
        // A review by a since-deleted account keeps a NULL reviewer rather
        // than being dropped: the shared decision outlives the account.
        reviewerDeleted += 1;
      }
    }

    const reviewedAt = timestamp(
      cell(row, "reviewed_at", DURATION_REVIEWS_RELATION),
      "reviewed_at",
      DURATION_REVIEWS_RELATION,
      true,
    ) as PgTimestamp;
    const updatedAt = timestamp(
      cell(row, "updated_at", DURATION_REVIEWS_RELATION),
      "updated_at",
      DURATION_REVIEWS_RELATION,
      true,
    ) as PgTimestamp;

    decisions.push(
      Object.freeze({
        game_id: gameId,
        steam_app_id: appId,
        decision_kind: "duration" as const,
        source_relation: DURATION_REVIEWS_RELATION,
        source_record_key: appId,
        source: DURATION_REVIEW_SOURCE,
        precedence_rank: CATALOGUE_DECISION_PRECEDENCE.manual_duration_review,
        // A hand-authored review is a settled, retained human decision; the
        // source carries no separate pending/approved workflow state.
        decision_status: "retained" as const,
        name: null,
        steam_type: null,
        matched_rule: null,
        reason: null,
        genres: null,
        categories: null,
        genres_elements: null,
        categories_elements: null,
        response_text: responseText,
        response_kind: responseKind,
        source_url: sourceUrl,
        reviewer_account_id: reviewerAccountId,
        reviewed_at: reviewedAt,
        review_notes: null,
        duration_manual_override: false as const,
        source_payload: EMPTY_JSON_OBJECT,
        // `catalog.review_decisions` has one `created_at`; the source has no
        // separate creation instant for a review, so the review's own
        // `reviewed_at` — a real, already-validated source value — is reused
        // rather than a wall-clock instant being invented.
        created_at: reviewedAt,
        updated_at: updatedAt,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({
    review_decisions: Object.freeze(decisions),
    counts: Object.freeze({ rows: rows.length, reviewer_mapped: reviewerMapped, reviewer_deleted: reviewerDeleted }),
  });
}

/* -------------------------------------------------------------------------
 * catalog_duration_import_runs -> catalog.duration_imports
 * ---------------------------------------------------------------------- */

const IMPORT_RUNS_RELATION = "catalog_duration_import_runs";
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type DurationImportRunSourceRow = Readonly<{
  id: string;
  source: string;
  imported_count: string;
  skipped_count: string;
  source_updated_at: string | null;
  created_at: string;
  source_sha256: string | null;
  expected_app_count: string | null;
  staged_row_count: string | null;
  status: "planned" | "running" | "succeeded" | "completed" | "partial" | "failed" | "abandoned";
  completed_at: string | null;
  manifest: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const DURATION_IMPORT_RUNS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "source",
  "imported_count",
  "skipped_count",
  "source_updated_at",
  "created_at",
  "source_sha256",
  "expected_app_count",
  "staged_row_count",
  "status",
  "completed_at",
  "manifest",
]);

export type DurationImportRunTargetRecord = Readonly<{
  legacy_id: string;
  source: string;
  imported_count: number;
  skipped_count: number;
  expected_app_count: number | null;
  staged_row_count: number | null;
  status: string;
  source_sha256: string | null;
  source_updated_at: PgTimestamp | null;
  created_at: PgTimestamp;
  completed_at: PgTimestamp | null;
  manifest: Readonly<{ text: string; utf8Bytes: number }>;
  source_snapshot_hash: string;
}>;

export type DurationImportRunsTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  rows: readonly DurationImportRunSourceRow[];
}>;

export type DurationImportRunsTransformResult = Readonly<{
  duration_imports: readonly DurationImportRunTargetRecord[];
  counts: Readonly<{ rows: number; retained: number; retired: number }>;
}>;

export function transformDurationImportRuns(input: DurationImportRunsTransformInput): DurationImportRunsTransformResult {
  const root = asObject(input, "duration_import_runs_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const rows = ensureArray(root.rows, IMPORT_RUNS_RELATION) as readonly DurationImportRunSourceRow[];
  checkRowLimit(rows, IMPORT_RUNS_RELATION, 1_000_000);

  const imports: DurationImportRunTargetRecord[] = [];
  const seenIds = new Set<string>();

  for (const raw of rows) {
    const row = asObject(raw, IMPORT_RUNS_RELATION);
    checkRowRunIdentity(row, run, IMPORT_RUNS_RELATION);
    for (const column of DURATION_IMPORT_RUNS_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", IMPORT_RUNS_RELATION, column);
    }

    const legacyId = canonicalUuidText(cell(row, "id", IMPORT_RUNS_RELATION), "id", IMPORT_RUNS_RELATION, true) as string;
    if (seenIds.has(legacyId)) providerFailure("provider_duplicate_row", IMPORT_RUNS_RELATION, "id");
    seenIds.add(legacyId);

    const source = boundedText(cell(row, "source", IMPORT_RUNS_RELATION), "source", IMPORT_RUNS_RELATION, {
      nullable: false,
      maxLength: 200,
      requireTrimmedContent: true,
    }) as string;
    if (isRetiredIgdbSource(source)) continue;
    const importedCount = requiredIntegerNumber(
      cell(row, "imported_count", IMPORT_RUNS_RELATION),
      "imported_count",
      IMPORT_RUNS_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const skippedCount = requiredIntegerNumber(
      cell(row, "skipped_count", IMPORT_RUNS_RELATION),
      "skipped_count",
      IMPORT_RUNS_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const sourceUpdatedAt = timestamp(
      cell(row, "source_updated_at", IMPORT_RUNS_RELATION),
      "source_updated_at",
      IMPORT_RUNS_RELATION,
      false,
    );
    const createdAt = timestamp(cell(row, "created_at", IMPORT_RUNS_RELATION), "created_at", IMPORT_RUNS_RELATION, true) as PgTimestamp;
    const rawSha = cell(row, "source_sha256", IMPORT_RUNS_RELATION);
    if (rawSha !== null && !SHA256_HEX.test(rawSha)) {
      providerFailure("provider_text_bounds", IMPORT_RUNS_RELATION, "source_sha256");
    }
    const expectedAppCount = integerText(
      cell(row, "expected_app_count", IMPORT_RUNS_RELATION),
      "expected_app_count",
      IMPORT_RUNS_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const stagedRowCount = integerText(
      cell(row, "staged_row_count", IMPORT_RUNS_RELATION),
      "staged_row_count",
      IMPORT_RUNS_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    // UNVALIDATED in the source; the target's six-value vocabulary is
    // asserted here rather than assumed, matching the same value-domain
    // discipline `catalogue.ts` applies to `catalog_games.first_seen_reason`.
    const sourceStatus = enumCell(
      cell(row, "status", IMPORT_RUNS_RELATION),
      "status",
      IMPORT_RUNS_RELATION,
      ["planned", "running", "succeeded", "completed", "partial", "failed", "abandoned"] as const,
      true,
    ) as string;
    // The only source-specific spelling is the terminal value written by
    // 20260825153000_record_hltb_validation_run.sql. The destination calls
    // that same successful terminal state `succeeded`.
    const status = sourceStatus === "completed" ? "succeeded" : sourceStatus;
    const completedAt = timestamp(cell(row, "completed_at", IMPORT_RUNS_RELATION), "completed_at", IMPORT_RUNS_RELATION, false);
    if (completedAt !== null && completedAt.epochMicros < createdAt.epochMicros) {
      // M3 catalog.duration_imports check (completed_at >= created_at).
      providerFailure("provider_order_conflict", IMPORT_RUNS_RELATION, "completed_at");
    }
    const manifest = requiredJsonDocument(cell(row, "manifest", IMPORT_RUNS_RELATION), "manifest", IMPORT_RUNS_RELATION, "object");

    imports.push(
      Object.freeze({
        legacy_id: legacyId,
        source,
        imported_count: importedCount,
        skipped_count: skippedCount,
        expected_app_count: expectedAppCount === null ? null : Number(expectedAppCount),
        staged_row_count: stagedRowCount === null ? null : Number(stagedRowCount),
        status,
        source_sha256: rawSha,
        source_updated_at: sourceUpdatedAt,
        created_at: createdAt,
        completed_at: completedAt,
        manifest,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({ duration_imports: Object.freeze(imports), counts: Object.freeze({ rows: rows.length, retained: imports.length, retired: rows.length - imports.length }) });
}

export { ProviderTransformError };
