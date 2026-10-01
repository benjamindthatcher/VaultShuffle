import { CATALOGUE_DECISION_PRECEDENCE } from "./catalogue.ts";
import { GameMapError, hasGameId, lookupGameId, type GameMap } from "./games.ts";
import {
  ProviderTransformError,
  TARGET_INTEGER_MAX,
  ZERO,
  asObject,
  boundedText,
  canonicalUuidText,
  cell,
  checkRowLimit,
  checkRowRunIdentity,
  civilDate,
  ensureArray,
  enumCell,
  integerText,
  jsonObjectDocument,
  pgTextArrayAsJson,
  providerFailure,
  requiredIntegerNumber,
  steamAppId,
  terminalReason,
  timestamp,
  validateProviderRunIdentity,
  PROVIDER_STATE_ERROR_MAX,
  UNATTRIBUTED_PROVIDER,
  type AppIdTerminalRejectionTargetRecord,
  type ProviderRunIdentity,
  type ProviderStateTargetRecord,
  type ReviewDecisionTargetRecord,
} from "./provider-shared.ts";
import type { CivilDate, PgTimestamp } from "./scalars.ts";

/**
 * The bounded correction/rebuild half of the M3-H batch: quarantine evidence,
 * two archive-only work queues (ingest queue, seed-run provenance stays
 * durable while the queue itself is rebuilt), and the guest catalogue pool's
 * coverage accounting.
 *
 * Every relation here is either shared catalogue evidence with no account
 * key, or explicitly NOT a migration destination (a rebuilt queue/cache).
 * This module never resumes in-flight work and never retains a whole-library
 * array where only a coverage count was asked for.
 */

/* -------------------------------------------------------------------------
 * catalog_game_quarantine -> catalog.review_decisions (decision_kind='quarantine')
 * ---------------------------------------------------------------------- */

const QUARANTINE_RELATION = "catalog_game_quarantine";

export type QuarantineSourceRow = Readonly<{
  steam_appid: string;
  name: string | null;
  steam_type: string | null;
  matched_rule: string | null;
  reason: string;
  /** PostgreSQL `text[]` COPY output, NOT NULL in the source. */
  genres: string;
  categories: string;
  review_status: "pending" | "excluded" | "allowed";
  source: "automatic" | "manual";
  first_detected_at: string;
  last_detected_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  updated_at: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const QUARANTINE_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_appid",
  "name",
  "steam_type",
  "matched_rule",
  "reason",
  "genres",
  "categories",
  "review_status",
  "source",
  "first_detected_at",
  "last_detected_at",
  "reviewed_at",
  "review_notes",
  "updated_at",
]);

export type QuarantineTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  gameMap: GameMap;
  rows: readonly QuarantineSourceRow[];
}>;

export type QuarantineTransformResult = Readonly<{
  review_decisions: readonly ReviewDecisionTargetRecord[];
  counts: Readonly<{ rows: number; mapped: number; unmapped: number }>;
}>;

function gameMapLookup(map: GameMap, appIdText: string, relation: string, field: string): number | null {
  try {
    if (!hasGameId(map, appIdText)) return null;
    return lookupGameId(map, appIdText);
  } catch (error) {
    if (error instanceof GameMapError) providerFailure("provider_input_invalid", relation, field);
    throw error;
  }
}

export function transformGameQuarantine(input: QuarantineTransformInput): QuarantineTransformResult {
  const root = asObject(input, "quarantine_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const map = root.gameMap as GameMap;
  const rows = ensureArray(root.rows, QUARANTINE_RELATION) as readonly QuarantineSourceRow[];
  checkRowLimit(rows, QUARANTINE_RELATION, 2_000_000);

  const decisions: ReviewDecisionTargetRecord[] = [];
  const seenAppIds = new Set<string>();
  let mapped = 0;

  for (const raw of rows) {
    const row = asObject(raw, QUARANTINE_RELATION);
    checkRowRunIdentity(row, run, QUARANTINE_RELATION);
    for (const column of QUARANTINE_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", QUARANTINE_RELATION, column);
    }

    const appId = steamAppId(cell(row, "steam_appid", QUARANTINE_RELATION), "steam_appid", QUARANTINE_RELATION);
    if (seenAppIds.has(appId)) providerFailure("provider_duplicate_row", QUARANTINE_RELATION, "steam_appid");
    seenAppIds.add(appId);

    // A quarantined app is frequently absent from `catalog_games` entirely —
    // that is the whole point of quarantine. A miss here is a real, valid
    // case, never a reported failure the way an unmapped catalogue row is.
    const gameId = gameMapLookup(map, appId, QUARANTINE_RELATION, "steam_appid");
    if (gameId !== null) mapped += 1;

    const name = boundedText(cell(row, "name", QUARANTINE_RELATION), "name", QUARANTINE_RELATION, {
      nullable: true,
      maxLength: 1000,
      requireTrimmedContent: false,
    });
    const steamType = boundedText(cell(row, "steam_type", QUARANTINE_RELATION), "steam_type", QUARANTINE_RELATION, {
      nullable: true,
      maxLength: 120,
      requireTrimmedContent: false,
    });
    const matchedRule = boundedText(cell(row, "matched_rule", QUARANTINE_RELATION), "matched_rule", QUARANTINE_RELATION, {
      nullable: true,
      maxLength: 500,
      requireTrimmedContent: false,
    });
    const reason = boundedText(cell(row, "reason", QUARANTINE_RELATION), "reason", QUARANTINE_RELATION, {
      nullable: false,
      maxLength: 5000,
      requireTrimmedContent: false,
    });
    const genres = pgTextArrayAsJson(cell(row, "genres", QUARANTINE_RELATION), "genres", QUARANTINE_RELATION);
    const categories = pgTextArrayAsJson(cell(row, "categories", QUARANTINE_RELATION), "categories", QUARANTINE_RELATION);
    // The source's own declared domain is the only one asserted here: the
    // wider `decision_status` vocabulary is a target superset, not a mapping
    // table, so an unmapped value fails rather than being silently coerced.
    const reviewStatus = enumCell(
      cell(row, "review_status", QUARANTINE_RELATION),
      "review_status",
      QUARANTINE_RELATION,
      ["pending", "excluded", "allowed"] as const,
      true,
    );
    const source = enumCell(
      cell(row, "source", QUARANTINE_RELATION),
      "source",
      QUARANTINE_RELATION,
      ["automatic", "manual"] as const,
      true,
    ) as "automatic" | "manual";
    const firstDetectedAt = timestamp(
      cell(row, "first_detected_at", QUARANTINE_RELATION),
      "first_detected_at",
      QUARANTINE_RELATION,
      true,
    ) as PgTimestamp;
    const lastDetectedAt = timestamp(
      cell(row, "last_detected_at", QUARANTINE_RELATION),
      "last_detected_at",
      QUARANTINE_RELATION,
      true,
    ) as PgTimestamp;
    const reviewedAt = timestamp(cell(row, "reviewed_at", QUARANTINE_RELATION), "reviewed_at", QUARANTINE_RELATION, false);
    const reviewNotes = boundedText(
      cell(row, "review_notes", QUARANTINE_RELATION),
      "review_notes",
      QUARANTINE_RELATION,
      { nullable: true, maxLength: 10000, requireTrimmedContent: false },
    );
    const updatedAt = timestamp(cell(row, "updated_at", QUARANTINE_RELATION), "updated_at", QUARANTINE_RELATION, true) as PgTimestamp;

    decisions.push(
      Object.freeze({
        game_id: gameId,
        steam_app_id: appId,
        decision_kind: "quarantine" as const,
        source_relation: QUARANTINE_RELATION,
        source_record_key: appId,
        source,
        precedence_rank:
          source === "manual"
            ? CATALOGUE_DECISION_PRECEDENCE.manual_quarantine
            : CATALOGUE_DECISION_PRECEDENCE.automatic_quarantine,
        decision_status: reviewStatus as ReviewDecisionTargetRecord["decision_status"],
        name,
        steam_type: steamType,
        matched_rule: matchedRule,
        reason,
        genres: genres.text,
        categories: categories.text,
        genres_elements: genres.elements,
        categories_elements: categories.elements,
        response_text: null,
        response_kind: null,
        source_url: null,
        reviewer_account_id: null,
        reviewed_at: reviewedAt,
        review_notes: reviewNotes,
        duration_manual_override: false as const,
        // `catalog.review_decisions` has one `created_at`/`updated_at`, but
        // the source carries THREE distinct instants. `last_detected_at`
        // would otherwise have nowhere to go, so it is named explicitly
        // inside `source_payload` rather than silently dropped.
        source_payload: jsonObjectDocument({ last_detected_at: lastDetectedAt.canonicalUtc }),
        created_at: firstDetectedAt,
        updated_at: updatedAt,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({
    review_decisions: Object.freeze(decisions),
    counts: Object.freeze({ rows: rows.length, mapped, unmapped: rows.length - mapped }),
  });
}

/* -------------------------------------------------------------------------
 * catalog_ingest_queue -> migration.legacy_ingest_queue_archive (archive-only)
 * ---------------------------------------------------------------------- */

const INGEST_QUEUE_RELATION = "catalog_ingest_queue";

export type IngestQueueSourceRow = Readonly<{
  steam_appid: string;
  status: "pending" | "processing" | "ready" | "rejected" | "failed";
  reason: "seed" | "user_import" | "manual" | "refresh";
  /** Retired: scheduling input for a queue that is rebuilt, not archived. */
  priority: string;
  requested_count: string;
  source_rank: string | null;
  /** Retired: the largest column here, recoverable by re-fetching the app. */
  source_payload: string;
  attempts: string;
  /** Retired: an in-flight worker lease with no meaning after the freeze. */
  next_attempt_at: string | null;
  /** Retired: same reason as `next_attempt_at`. */
  processing_started_at: string | null;
  last_error: string | null;
  rejection_reason: string | null;
  first_requested_at: string;
  last_requested_at: string;
  processed_at: string | null;
  /** Retired: superseded by the archived `processed_at`/`last_requested_at`. */
  updated_at: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const INGEST_QUEUE_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_appid",
  "status",
  "reason",
  "priority",
  "requested_count",
  "source_rank",
  "source_payload",
  "attempts",
  "next_attempt_at",
  "processing_started_at",
  "last_error",
  "rejection_reason",
  "first_requested_at",
  "last_requested_at",
  "processed_at",
  "updated_at",
]);

/** The three source columns with no destination beyond the archive, and why. */
export const INGEST_QUEUE_RETIRED_SOURCE_COLUMNS = Object.freeze({
  priority: "Scheduling input for a queue the v2 pipeline rebuilds from current demand after cutover.",
  source_payload:
    "The provider payload that justified queueing. Plan 14.2 does not migrate payloads; the app can be re-fetched from the provider.",
  processing_started_at: "An in-flight worker lease with no meaning after the freeze; in-flight work is not resumed.",
} as const);

/**
 * `next_attempt_at` and `updated_at` are NOT retired.
 *
 * Root's 11 September durability review: the previous revision retired both
 * with the claim that retry scheduling is "rebuilt from the archived
 * attempts/last_error after cutover". `migration.legacy_ingest_queue_archive`
 * is registered `staging-30d-post-cutover`, so that claim depends on a copy
 * that expires, and nothing rebuilds from it.
 *
 * What actually happens when the row is gone is readable in the source
 * writers. `ensure_catalogue_entries`
 * (`supabase/migrations/20260829224231_reparent_product_data_to_app_accounts
 * .sql:157-172`) queues any requested AppID with no `catalog_games` row, and a
 * rejected AppID is exactly one with no `catalog_games` row -- the classifier
 * refused to store it (`lib/catalogue.ts:206-238`). With the queue row present,
 * `on conflict` keeps `status = 'rejected'` forever and the app is never
 * re-fetched. With it deleted, the next import inserts a fresh `pending` row at
 * `attempts = 0` and the whole fetch/classify/quarantine/reject cycle repeats,
 * permanently, for every already-decided non-game. `lib/catalogue.ts:167-177`
 * records that this exact churn (~80 retries per entry) already happened once.
 *
 * So both instants now reach durable evidence: `next_attempt_at` becomes
 * `catalog.appid_terminal_rejections.retry_allowed_after` (or
 * `catalog.provider_state.next_attempt_at` for an AppID that does have a
 * catalogue row), and `updated_at` supplies the terminal verdict's
 * `last_attempt_at`.
 */
export const INGEST_QUEUE_DURABLE_RETRY_COLUMNS = Object.freeze({
  next_attempt_at:
    "catalog.appid_terminal_rejections.retry_allowed_after for a terminal unmapped AppID; catalog.provider_state.next_attempt_at when the AppID has a catalogue row.",
  updated_at:
    "catalog.appid_terminal_rejections.last_attempt_at / catalog.provider_state.updated_at: the instant the terminal verdict or current state was last written.",
} as const);

/**
 * The two terminal `catalog_ingest_queue` statuses, and what each one means in
 * the writer that produces it.
 *
 * * `rejected` — `lib/catalogue.ts:233` writes it with `rejection_reason` when
 *   the classifier excludes the AppID (a demo, DLC, soundtrack or other
 *   non-game). `ensure_catalogue_entries` never resets it, so it is the
 *   permanent verdict for that identity.
 * * `failed` — `lib/catalogue.ts:262` writes it once attempts reach 3
 *   (provider says unavailable) or 5 (anything else), with `next_attempt_at`
 *   NULL. `ensure_catalogue_entries` DOES rescue this one on the next request,
 *   so it is durable evidence of exhausted attempts rather than a permanent
 *   refusal; the attempt count is the part that must not reset to zero.
 */
const INGEST_TERMINAL_STATUS = Object.freeze({
  rejected: "rejected",
  failed: "permanently_failed",
} as const);

export type IngestQueueArchiveTargetRecord = Readonly<{
  steam_appid: string;
  status: string;
  reason: string;
  requested_count: number;
  source_rank: number | null;
  attempts: number;
  last_error: string | null;
  rejection_reason: string | null;
  first_requested_at: PgTimestamp;
  last_requested_at: PgTimestamp;
  processed_at: PgTimestamp | null;
  source_snapshot_hash: string;
}>;

export type IngestQueueTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  /** Required: durable state is keyed differently for a mapped AppID. */
  gameMap: GameMap;
  rows: readonly IngestQueueSourceRow[];
}>;

export type IngestQueueTransformResult = Readonly<{
  archive: readonly IngestQueueArchiveTargetRecord[];
  /**
   * `catalog.provider_state` for an AppID that has a catalogue row. A queue
   * row exists for one of these only through a `refresh`/`seed` request, since
   * the user-import path queues only AppIDs missing from `catalog_games`.
   */
  provider_state: readonly ProviderStateTargetRecord[];
  /**
   * `catalog.appid_terminal_rejections` for a terminal verdict on an AppID
   * with no catalogue row -- the case `catalog.provider_state` physically
   * cannot hold, and the one that causes repeated rediscovery when the queue
   * row expires.
   */
  terminal_rejections: readonly AppIdTerminalRejectionTargetRecord[];
  counts: Readonly<{
    rows: number;
    mapped: number;
    unmapped: number;
    terminal: number;
    /** Terminal rows already covered by `provider_state` (mapped AppIDs). */
    terminal_mapped: number;
  }>;
}>;

/** `catalog_ingest_queue.status` -> `catalog.provider_state.status`. */
function ingestProviderStatus(status: string): ProviderStateTargetRecord["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "processing":
      return "processing";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "rejected":
      // The classifier refused to store the app. `no_match` is the target's
      // own literal for "this identity will not produce a catalogue row",
      // which is exactly the verdict; there is no 'rejected' literal here.
      return "no_match";
    default:
      return "unknown";
  }
}

export function transformIngestQueueArchive(input: IngestQueueTransformInput): IngestQueueTransformResult {
  const root = asObject(input, "ingest_queue_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const map = root.gameMap as GameMap;
  const rows = ensureArray(root.rows, INGEST_QUEUE_RELATION) as readonly IngestQueueSourceRow[];
  checkRowLimit(rows, INGEST_QUEUE_RELATION, 5_000_000);

  const archive: IngestQueueArchiveTargetRecord[] = [];
  const providerState: ProviderStateTargetRecord[] = [];
  const terminalRejections: AppIdTerminalRejectionTargetRecord[] = [];
  let mapped = 0;
  let terminalCount = 0;
  let terminalMapped = 0;
  const seenAppIds = new Set<string>();

  for (const raw of rows) {
    const row = asObject(raw, INGEST_QUEUE_RELATION);
    checkRowRunIdentity(row, run, INGEST_QUEUE_RELATION);
    for (const column of INGEST_QUEUE_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", INGEST_QUEUE_RELATION, column);
    }

    const appId = steamAppId(cell(row, "steam_appid", INGEST_QUEUE_RELATION), "steam_appid", INGEST_QUEUE_RELATION);
    if (seenAppIds.has(appId)) providerFailure("provider_duplicate_row", INGEST_QUEUE_RELATION, "steam_appid");
    seenAppIds.add(appId);

    const status = enumCell(
      cell(row, "status", INGEST_QUEUE_RELATION),
      "status",
      INGEST_QUEUE_RELATION,
      ["pending", "processing", "ready", "rejected", "failed"] as const,
      true,
    ) as string;
    const reason = enumCell(
      cell(row, "reason", INGEST_QUEUE_RELATION),
      "reason",
      INGEST_QUEUE_RELATION,
      ["seed", "user_import", "manual", "refresh"] as const,
      true,
    ) as string;
    const requestedCount = requiredIntegerNumber(
      cell(row, "requested_count", INGEST_QUEUE_RELATION),
      "requested_count",
      INGEST_QUEUE_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const sourceRank = integerText(
      cell(row, "source_rank", INGEST_QUEUE_RELATION),
      "source_rank",
      INGEST_QUEUE_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const attempts = requiredIntegerNumber(
      cell(row, "attempts", INGEST_QUEUE_RELATION),
      "attempts",
      INGEST_QUEUE_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const lastError = boundedText(
      cell(row, "last_error", INGEST_QUEUE_RELATION),
      "last_error",
      INGEST_QUEUE_RELATION,
      { nullable: true, maxLength: 20000, requireTrimmedContent: false },
    );
    const rejectionReason = boundedText(
      cell(row, "rejection_reason", INGEST_QUEUE_RELATION),
      "rejection_reason",
      INGEST_QUEUE_RELATION,
      { nullable: true, maxLength: 5000, requireTrimmedContent: false },
    );
    const firstRequestedAt = timestamp(
      cell(row, "first_requested_at", INGEST_QUEUE_RELATION),
      "first_requested_at",
      INGEST_QUEUE_RELATION,
      true,
    ) as PgTimestamp;
    const lastRequestedAt = timestamp(
      cell(row, "last_requested_at", INGEST_QUEUE_RELATION),
      "last_requested_at",
      INGEST_QUEUE_RELATION,
      true,
    ) as PgTimestamp;
    if (lastRequestedAt.epochMicros < firstRequestedAt.epochMicros) {
      providerFailure("provider_order_conflict", INGEST_QUEUE_RELATION, "last_requested_at");
    }
    const processedAt = timestamp(
      cell(row, "processed_at", INGEST_QUEUE_RELATION),
      "processed_at",
      INGEST_QUEUE_RELATION,
      false,
    );
    if (processedAt !== null && processedAt.epochMicros < firstRequestedAt.epochMicros) {
      providerFailure("provider_order_conflict", INGEST_QUEUE_RELATION, "processed_at");
    }
    const nextAttemptAt = timestamp(
      cell(row, "next_attempt_at", INGEST_QUEUE_RELATION),
      "next_attempt_at",
      INGEST_QUEUE_RELATION,
      false,
    );
    const processingStartedAt = timestamp(
      cell(row, "processing_started_at", INGEST_QUEUE_RELATION),
      "processing_started_at",
      INGEST_QUEUE_RELATION,
      false,
    );
    const updatedAt = timestamp(
      cell(row, "updated_at", INGEST_QUEUE_RELATION),
      "updated_at",
      INGEST_QUEUE_RELATION,
      true,
    ) as PgTimestamp;
    // The three retired columns are still read from the row shape above (via
    // the complete-column-presence check) but intentionally not archived.
    cell(row, "priority", INGEST_QUEUE_RELATION);
    cell(row, "source_payload", INGEST_QUEUE_RELATION);

    const gameId = gameMapLookup(map, appId, INGEST_QUEUE_RELATION, "steam_appid");
    const terminalStatus =
      status === "rejected" || status === "failed" ? INGEST_TERMINAL_STATUS[status] : null;
    if (gameId !== null) mapped += 1;
    if (terminalStatus !== null) terminalCount += 1;

    // An uncatalogued pending row can be rebuilt as due work, but an exact
    // retry fence has no durable target: provider_state requires a game and
    // appid_terminal_rejections accepts terminal verdicts only. Silently
    // expiring that fence with staging would make the app immediately due.
    if (gameId === null && terminalStatus === null && status === "pending" && nextAttemptAt !== null) {
      providerFailure("provider_physical_gap", INGEST_QUEUE_RELATION, "next_attempt_at");
    }
    // `ready` is produced only after the writer has stored the catalogue row.
    // A missing same-run game-map entry is therefore an unresolved snapshot
    // inconsistency, not disposable queue state.
    if (gameId === null && status === "ready") {
      providerFailure("provider_physical_gap", INGEST_QUEUE_RELATION, "steam_appid");
    }

    if (gameId !== null) {
      const providerStatus = ingestProviderStatus(status);
      providerState.push(
        Object.freeze({
          game_id: gameId,
          provider: UNATTRIBUTED_PROVIDER,
          evidence_kind: "metadata" as const,
          status: providerStatus,
          failure_count: attempts,
          // The target permits a retry fence only for these three statuses.
          // A fence outside them is a source shape no reviewed writer
          // produces; it is kept in the archive rather than forced into a
          // column whose CHECK would reject it.
          next_attempt_at:
            providerStatus === "pending" || providerStatus === "failed" || providerStatus === "review_required"
              ? nextAttemptAt
              : null,
          // Likewise: the target permits a lease instant only while
          // processing or failed.
          processing_started_at:
            providerStatus === "processing" || providerStatus === "failed" ? processingStartedAt : null,
          // A real source instant, not a mutation clock: processed_at is set
          // exactly when the fetch result was recorded.
          fetched_at: status === "ready" ? processedAt : null,
          last_error_code: null,
          last_error: boundedText(lastError, "last_error", INGEST_QUEUE_RELATION, {
            nullable: true,
            maxLength: PROVIDER_STATE_ERROR_MAX,
            requireTrimmedContent: false,
          }),
          source_snapshot_hash: run.snapshotHash,
          updated_at: updatedAt,
        }),
      );
      if (terminalStatus !== null) terminalMapped += 1;
    } else if (terminalStatus !== null) {
      if (updatedAt.epochMicros < firstRequestedAt.epochMicros) {
        providerFailure("provider_order_conflict", INGEST_QUEUE_RELATION, "updated_at");
      }
      terminalRejections.push(
        Object.freeze({
          steam_app_id: appId,
          evidence_kind: "ingest" as const,
          provider: UNATTRIBUTED_PROVIDER,
          terminal_status: terminalStatus,
          reason: terminalReason(
            rejectionReason ?? lastError,
            `catalog_ingest_queue.status='${status}' after ${attempts} attempts; the source recorded no reason text.`,
            INGEST_QUEUE_RELATION,
            status === "rejected" ? "rejection_reason" : "last_error",
          ),
          attempts,
          last_error_code: null,
          first_requested_at: firstRequestedAt,
          // processed_at is the rejection instant; a failed row has none, and
          // updated_at is then the instant the last attempt was recorded.
          last_attempt_at: processedAt ?? updatedAt,
          source_relation: "catalog_ingest_queue" as const,
          retry_allowed_after: nextAttemptAt,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
    }

    archive.push(
      Object.freeze({
        steam_appid: appId,
        status,
        reason,
        requested_count: requestedCount,
        source_rank: sourceRank === null ? null : Number(sourceRank),
        attempts,
        last_error: lastError,
        rejection_reason: rejectionReason,
        first_requested_at: firstRequestedAt,
        last_requested_at: lastRequestedAt,
        processed_at: processedAt,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({
    archive: Object.freeze(archive),
    provider_state: Object.freeze(providerState),
    terminal_rejections: Object.freeze(terminalRejections),
    counts: Object.freeze({
      rows: rows.length,
      mapped,
      unmapped: rows.length - mapped,
      terminal: terminalCount,
      terminal_mapped: terminalMapped,
    }),
  });
}

/* -------------------------------------------------------------------------
 * catalog_seed_runs -> catalog.seed_runs (durable shared provenance)
 * ---------------------------------------------------------------------- */

const SEED_RUNS_RELATION = "catalog_seed_runs";
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type SeedRunSourceRow = Readonly<{
  id: string;
  source: string;
  metric: string;
  /** A CIVIL DATE. Never routed through a timestamp conversion. */
  captured_at: string;
  requested_count: string;
  accepted_count: string;
  source_url: string | null;
  source_sha256: string | null;
  created_at: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const SEED_RUNS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "source",
  "metric",
  "captured_at",
  "requested_count",
  "accepted_count",
  "source_url",
  "source_sha256",
  "created_at",
]);

export type SeedRunTargetRecord = Readonly<{
  legacy_id: string;
  source: string;
  metric: string;
  captured_on: CivilDate;
  requested_count: number;
  accepted_count: number;
  source_url: string | null;
  source_sha256: string | null;
  created_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type SeedRunsTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  rows: readonly SeedRunSourceRow[];
}>;

export type SeedRunsTransformResult = Readonly<{
  seed_runs: readonly SeedRunTargetRecord[];
  counts: Readonly<{ rows: number }>;
}>;

export function transformSeedRuns(input: SeedRunsTransformInput): SeedRunsTransformResult {
  const root = asObject(input, "seed_runs_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const rows = ensureArray(root.rows, SEED_RUNS_RELATION) as readonly SeedRunSourceRow[];
  checkRowLimit(rows, SEED_RUNS_RELATION, 1_000_000);

  const seedRuns: SeedRunTargetRecord[] = [];
  const seenIds = new Set<string>();

  for (const raw of rows) {
    const row = asObject(raw, SEED_RUNS_RELATION);
    checkRowRunIdentity(row, run, SEED_RUNS_RELATION);
    for (const column of SEED_RUNS_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", SEED_RUNS_RELATION, column);
    }

    const legacyId = canonicalUuidText(cell(row, "id", SEED_RUNS_RELATION), "id", SEED_RUNS_RELATION, true) as string;
    if (seenIds.has(legacyId)) providerFailure("provider_duplicate_row", SEED_RUNS_RELATION, "id");
    seenIds.add(legacyId);

    const source = boundedText(cell(row, "source", SEED_RUNS_RELATION), "source", SEED_RUNS_RELATION, {
      nullable: false,
      maxLength: 200,
      requireTrimmedContent: true,
    }) as string;
    const metric = boundedText(cell(row, "metric", SEED_RUNS_RELATION), "metric", SEED_RUNS_RELATION, {
      nullable: false,
      maxLength: 200,
      requireTrimmedContent: true,
    }) as string;
    const capturedOn = civilDate(cell(row, "captured_at", SEED_RUNS_RELATION), "captured_at", SEED_RUNS_RELATION) as CivilDate;
    const requestedCount = requiredIntegerNumber(
      cell(row, "requested_count", SEED_RUNS_RELATION),
      "requested_count",
      SEED_RUNS_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const acceptedCount = requiredIntegerNumber(
      cell(row, "accepted_count", SEED_RUNS_RELATION),
      "accepted_count",
      SEED_RUNS_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    if (acceptedCount > requestedCount) {
      // M3 catalog.seed_runs check (accepted_count between 0 and requested_count).
      providerFailure("provider_order_conflict", SEED_RUNS_RELATION, "accepted_count");
    }
    const sourceUrl = boundedText(cell(row, "source_url", SEED_RUNS_RELATION), "source_url", SEED_RUNS_RELATION, {
      nullable: true,
      maxLength: 2048,
      requireTrimmedContent: false,
    });
    const rawSha = cell(row, "source_sha256", SEED_RUNS_RELATION);
    if (rawSha !== null && !SHA256_HEX.test(rawSha)) {
      providerFailure("provider_text_bounds", SEED_RUNS_RELATION, "source_sha256");
    }
    const createdAt = timestamp(cell(row, "created_at", SEED_RUNS_RELATION), "created_at", SEED_RUNS_RELATION, true) as PgTimestamp;

    seedRuns.push(
      Object.freeze({
        legacy_id: legacyId,
        source,
        metric,
        captured_on: capturedOn,
        requested_count: requestedCount,
        accepted_count: acceptedCount,
        source_url: sourceUrl,
        source_sha256: rawSha,
        created_at: createdAt,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({ seed_runs: Object.freeze(seedRuns), counts: Object.freeze({ rows: rows.length }) });
}

/* -------------------------------------------------------------------------
 * guest_catalogue_pool: coverage accounting only, no destination row
 * ---------------------------------------------------------------------- */

const GUEST_POOL_RELATION = "guest_catalogue_pool";

export type GuestCataloguePoolSourceRow = Readonly<{
  steam_appid: string;
  position: string;
  refreshed_at: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export const GUEST_CATALOGUE_POOL_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_appid",
  "position",
  "refreshed_at",
]);

/**
 * A deterministic count-only report, never a retained per-row array.
 *
 * `guest_catalogue_pool` is a fully derived presentation cache: the v2 guest
 * surface rebuilds it from `catalog.games` after cutover, so there is no
 * migration destination for any individual row. What IS worth proving before
 * cutover is that the rebuild will cover roughly the same ground the legacy
 * pool did — hence counts, not identities.
 */
export type GuestCataloguePoolCoverage = Readonly<{
  row_count: number;
  distinct_app_ids: number;
  duplicate_app_id_rows: number;
  distinct_positions: number;
  duplicate_position_rows: number;
  mapped_app_ids: number;
  unmapped_app_ids: number;
  min_position: number | null;
  max_position: number | null;
  earliest_refreshed_at: PgTimestamp | null;
  latest_refreshed_at: PgTimestamp | null;
}>;

export type GuestCataloguePoolTransformInput = Readonly<{
  runIdentity: ProviderRunIdentity;
  gameMap: GameMap;
  rows: readonly GuestCataloguePoolSourceRow[];
}>;

export type GuestCataloguePoolTransformResult = Readonly<{
  coverage: GuestCataloguePoolCoverage;
}>;

export function transformGuestCataloguePool(
  input: GuestCataloguePoolTransformInput,
): GuestCataloguePoolTransformResult {
  const root = asObject(input, "guest_pool_input");
  const run = validateProviderRunIdentity(root.runIdentity);
  const map = root.gameMap as GameMap;
  const rows = ensureArray(root.rows, GUEST_POOL_RELATION) as readonly GuestCataloguePoolSourceRow[];
  checkRowLimit(rows, GUEST_POOL_RELATION, 1_000_000);

  const seenAppIds = new Set<string>();
  const seenPositions = new Set<number>();
  let duplicateAppIdRows = 0;
  let duplicatePositionRows = 0;
  let mapped = 0;
  let minPosition: number | null = null;
  let maxPosition: number | null = null;
  let earliest: PgTimestamp | null = null;
  let latest: PgTimestamp | null = null;

  for (const raw of rows) {
    const row = asObject(raw, GUEST_POOL_RELATION);
    checkRowRunIdentity(row, run, GUEST_POOL_RELATION);
    for (const column of GUEST_CATALOGUE_POOL_SOURCE_COLUMNS) {
      if (!(column in row)) providerFailure("provider_input_invalid", GUEST_POOL_RELATION, column);
    }

    const appId = steamAppId(cell(row, "steam_appid", GUEST_POOL_RELATION), "steam_appid", GUEST_POOL_RELATION);
    if (seenAppIds.has(appId)) duplicateAppIdRows += 1;
    seenAppIds.add(appId);

    const position = requiredIntegerNumber(
      cell(row, "position", GUEST_POOL_RELATION),
      "position",
      GUEST_POOL_RELATION,
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    if (seenPositions.has(position)) duplicatePositionRows += 1;
    seenPositions.add(position);
    minPosition = minPosition === null ? position : Math.min(minPosition, position);
    maxPosition = maxPosition === null ? position : Math.max(maxPosition, position);

    const refreshedAt = timestamp(
      cell(row, "refreshed_at", GUEST_POOL_RELATION),
      "refreshed_at",
      GUEST_POOL_RELATION,
      true,
    ) as PgTimestamp;
    if (earliest === null || refreshedAt.epochMicros < earliest.epochMicros) earliest = refreshedAt;
    if (latest === null || refreshedAt.epochMicros > latest.epochMicros) latest = refreshedAt;

    if (hasGameId(map, appId)) mapped += 1;
  }

  const coverage: GuestCataloguePoolCoverage = Object.freeze({
    row_count: rows.length,
    distinct_app_ids: seenAppIds.size,
    duplicate_app_id_rows: duplicateAppIdRows,
    distinct_positions: seenPositions.size,
    duplicate_position_rows: duplicatePositionRows,
    mapped_app_ids: mapped,
    unmapped_app_ids: rows.length - mapped,
    min_position: minPosition,
    max_position: maxPosition,
    earliest_refreshed_at: earliest,
    latest_refreshed_at: latest,
  });

  return Object.freeze({ coverage });
}

export { ProviderTransformError };
