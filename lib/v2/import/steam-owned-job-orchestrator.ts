import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_GAMES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_FUTURE_SKEW_SECONDS,
  MAX_GAME_NAME_LENGTH,
  MAX_PLAYTIME_MINUTES,
  MAX_TIMESTAMPTZ_EPOCH_SECONDS,
  STEAM_APP_ID_MAX,
  type SteamOwnedSnapshotInvalid
} from "./steam-owned-snapshot.ts";
import {
  MAX_STEAM_RETRY_AFTER_SECONDS,
  STEAM_COMPLETE_OWNED_SCOPE,
  STEAM_ID_SQL_BIGINT_MAX,
  type SteamOwnedFetchInvalid,
  type SteamOwnedFetchResult,
  type SteamOwnedFetchUnavailable,
  type SteamOwnedFetchProvenance
} from "./steam-owned-fetch.ts";

/** Provider controls are database-owned; the worker cannot override them. */
export type SteamProviderMode = "disabled" | "fixture" | "live";

/** PostgreSQL bigint values cross this boundary as decimal text. */
export type SteamOwnedJobClaim = {
  /** This runner accepts only the successful row from ops.claim_job. */
  claimed: true;
  jobId: string;
  messageId: string | null;
  jobKind: "owned_snapshot";
  accountId: number;
  gameId: null;
  provider: "steam";
  /** Mapped from the frozen claim row's DB-derived provider_subject. */
  steamId: string;
  providerMode: SteamProviderMode;
  generation: string;
  catalogRevision: null;
  leaseToken: string;
  attempt: number;
  attemptId: string;
  attemptToken: string;
  chargedAt: string;
  fetchStartedAt: string;
  leaseExpiresAt: string;
};

/** Allow small worker/DB clock skew while refusing implausibly future claims. */
export const MAX_CLAIM_FUTURE_SKEW_SECONDS = 5 * 60;

export type SteamOwnedSnapshotPublishPayload =
  | {
      status: "complete";
      provider: "steam";
      protocolVersion: 1;
      gameCount: number;
      scope: "complete_owned";
      includeAppInfo: true;
      includePlayedFreeGames: true;
      skipUnvettedApps: false;
      httpStatus: 200;
      bodyBytes: number;
    }
  | {
      status: "unavailable";
      provider: "steam";
      reason: "private" | "provider_error";
    }
  | {
      status: "invalid";
      provider: "steam";
      reason: SteamOwnedSnapshotInvalid["reason"];
    };

/** Exact parameter mapping for ops.publish_owned_snapshot. */
export type SteamOwnedSnapshotPublishCall = {
  jobId: string;
  leaseToken: string;
  result: SteamOwnedSnapshotPublishPayload;
  canonicalJson: string | null;
  contentHash: Uint8Array | null;
  bodyObservedAt: string | null;
  messageId: string | null;
};

/** Exact parameter mapping for ops.retry_job. */
export type SteamOwnedSnapshotRetryCall = {
  jobId: string;
  leaseToken: string;
  errorCode: string;
  errorDetail: string;
  providerRetryAt: string | null;
  retryPolicy: "retryable" | "deferred" | "non_retryable";
  /** Only terminal/deferred transitions may atomically acknowledge this ID. */
  messageId: string | null;
};

export type SteamOwnedSnapshotPublishResult = {
  result: "applied" | "already_applied" | "stale";
  acknowledged: boolean;
};

export type SteamOwnedSnapshotRetryResult = {
  status: "retryable" | "deferred" | "non_retryable" | "stale" | "failed" | "cancelled" | "already_applied";
  retryAt: string | null;
  attempt: number;
  acknowledged: boolean;
};

/** DB adapters bind these calls to the frozen definer-function signatures. */
export type SteamOwnedJobDatabase = {
  publishOwnedSnapshot: (
    call: SteamOwnedSnapshotPublishCall
  ) => Promise<SteamOwnedSnapshotPublishResult>;
  retryJob: (
    call: SteamOwnedSnapshotRetryCall
  ) => Promise<SteamOwnedSnapshotRetryResult>;
};

/**
 * In-memory retry material for a publish whose response was lost. Keep this
 * inside the worker boundary; never log it or expose it in a user DTO because
 * canonicalJson contains the bounded owned-game set.
 */
export type SteamOwnedPreparedPublish = {
  call: SteamOwnedSnapshotPublishCall;
};

/** No default transport is supplied; live network access must be explicit. */
export type SteamOwnedSnapshotTransport = (
  claim: SteamOwnedJobClaim,
  signal: AbortSignal
) => Promise<SteamOwnedFetchResult>;

export type SteamOwnedJobOrchestratorOptions = {
  db: SteamOwnedJobDatabase;
  transports?: {
    fixture?: SteamOwnedSnapshotTransport;
    live?: SteamOwnedSnapshotTransport;
  };
  /** Injected clock used only to convert a provider delay to timestamptz. */
  nowEpochSeconds: () => number;
  signal?: AbortSignal;
};

export type SteamOwnedJobRunResult =
  | {
      status: "published";
      result: "applied" | "already_applied";
      acknowledged: boolean;
    }
  | {
      status: "retry_scheduled";
      retryPolicy: "retryable" | "deferred" | "non_retryable";
      result: SteamOwnedSnapshotRetryResult;
    }
  | {
      status: "stale";
      phase: "publish" | "retry";
    }
  | {
      status: "refused";
      reason:
        | "invalid_claim"
        | "provider_disabled"
        | "fixture_transport_required"
        | "live_transport_required"
        | "cancelled_before_fetch"
        | "invalid_dependencies"
        | "invalid_fetch_result"
        | "invalid_claim_time"
        | "claim_expired";
    }
  | {
      status: "db_error";
      phase: "publish" | "retry";
      code: "publish_failed" | "publish_not_acknowledged" | "retry_failed" | "retry_not_acknowledged";
      /** Present only for a publish failure and usable by the explicit resume path. */
      preparedPublish?: SteamOwnedPreparedPublish;
    };

/**
 * Execute exactly one already-claimed owned_snapshot attempt.
 *
 * The database claim/reservation transaction has already completed before this
 * function is called. The fetch runs without a database transaction; only a
 * validated terminal result or safe retry transition is sent back through the
 * injected DB boundary. This function deliberately does not poll a queue or
 * claim another job, because a lane may also contain catalogue work.
 */
export async function runSteamOwnedSnapshotJob(
  claim: SteamOwnedJobClaim,
  options: SteamOwnedJobOrchestratorOptions
): Promise<SteamOwnedJobRunResult> {
  if (!isValidOptions(options)) return { status: "refused", reason: "invalid_dependencies" };
  if (!isValidClaim(claim)) return { status: "refused", reason: "invalid_claim" };
  const claimTime = validateClaimTimeWindow(claim, options.nowEpochSeconds);
  if (claimTime === "invalid_clock") return { status: "refused", reason: "invalid_dependencies" };
  if (claimTime === "invalid_time") return { status: "refused", reason: "invalid_claim_time" };
  if (claimTime === "expired") return { status: "refused", reason: "claim_expired" };
  if (options.signal?.aborted) return { status: "refused", reason: "cancelled_before_fetch" };

  if (claim.providerMode === "disabled") {
    return { status: "refused", reason: "provider_disabled" };
  }
  const transport = claim.providerMode === "fixture"
    ? options.transports?.fixture
    : options.transports?.live;
  if (!transport) {
    return {
      status: "refused",
      reason: claim.providerMode === "fixture" ? "fixture_transport_required" : "live_transport_required"
    };
  }

  let fetched: SteamOwnedFetchResult;
  try {
    // This await is intentionally outside every DB call/transaction. The
    // transport receives only DB-derived identity and mode from the claim.
    fetched = await transport(claim, options.signal ?? new AbortController().signal);
  } catch {
    fetched = {
      status: "unavailable",
      provider: "steam",
      reason: "transport_error",
      detail: "Steam owned-games request failed"
    };
  }

  const safeResult = sanitizeFetchResult(fetched);
  if (safeResult.status === "complete") {
    const completeCall = buildCompletePublishCall(claim, safeResult);
    if (!completeCall) return { status: "refused", reason: "invalid_fetch_result" };
    return publishTerminal(options.db, completeCall);
  }

  if (safeResult.status === "unavailable"
    && (safeResult.reason === "private" || safeResult.reason === "provider_error")) {
    return publishTerminal(options.db, {
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      result: {
        status: "unavailable",
        provider: "steam",
        reason: safeResult.reason
      },
      canonicalJson: null,
      contentHash: null,
      bodyObservedAt: null,
      messageId: claim.messageId
    });
  }

  if (safeResult.status === "invalid") {
    return publishTerminal(options.db, {
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      result: {
        status: "invalid",
        provider: "steam",
        reason: toPublishInvalidReason(safeResult.reason)
      },
      canonicalJson: null,
      contentHash: null,
      bodyObservedAt: null,
      messageId: claim.messageId
    });
  }

  const retryCall = buildRetryCall(claim, safeResult, options.nowEpochSeconds);
  return retryTerminal(options.db, retryCall);
}

/**
 * Resume one prepared publish after a response-loss/DB transport failure. This
 * path deliberately does not select a transport, consume quota, or fetch
 * again. The frozen publish function's applied marker makes the call
 * idempotent and returns `already_applied` after a commit was observed late.
 */
export async function resumeSteamOwnedSnapshotPublish(
  prepared: SteamOwnedPreparedPublish,
  options: Pick<SteamOwnedJobOrchestratorOptions, "db">
): Promise<SteamOwnedJobRunResult> {
  if (!isPreparedPublish(prepared)
    || !isRecord(options)
    || !isRecord(options.db)
    || typeof options.db.publishOwnedSnapshot !== "function") {
    return { status: "refused", reason: "invalid_fetch_result" };
  }
  return publishTerminal(options.db, prepared.call);
}

function isValidOptions(options: SteamOwnedJobOrchestratorOptions): boolean {
  return isRecord(options)
    && isRecord(options.db)
    && typeof options.db.publishOwnedSnapshot === "function"
    && typeof options.db.retryJob === "function"
    && typeof options.nowEpochSeconds === "function"
    && (options.transports === undefined || isRecord(options.transports));
}

function isPreparedPublish(value: unknown): value is SteamOwnedPreparedPublish {
  if (!isRecord(value) || !isRecord(value.call)) return false;
  const call = value.call;
  return isBoundedIdentifier(call.jobId)
    && isBoundedIdentifier(call.leaseToken)
    && (call.canonicalJson === null
      || typeof call.canonicalJson === "string" && byteLength(call.canonicalJson) <= DEFAULT_MAX_PAYLOAD_BYTES)
    && (call.contentHash === null
      || call.contentHash instanceof Uint8Array && call.contentHash.byteLength === 32)
    && (call.bodyObservedAt === null || typeof call.bodyObservedAt === "string")
    && (call.messageId === null || isPositiveBigint(call.messageId))
    && isRecord(call.result)
    && (call.result.status === "complete"
      || call.result.status === "unavailable"
      || call.result.status === "invalid");
}

function isValidClaim(value: unknown): value is SteamOwnedJobClaim {
  if (!isRecord(value)
    || value.claimed !== true
    || value.jobKind !== "owned_snapshot"
    || value.provider !== "steam"
    || value.gameId !== null
    || value.catalogRevision !== null
    || !isMode(value.providerMode)
    || !isBoundedIdentifier(value.jobId)
    || !isBoundedIdentifier(value.leaseToken)
    || !isBoundedIdentifier(value.attemptId)
    || !isBoundedIdentifier(value.attemptToken)
    || !isBoundedIdentifier(value.chargedAt)
    || !isBoundedIdentifier(value.fetchStartedAt)
    || !isBoundedIdentifier(value.leaseExpiresAt)
    || !isSqlSteamId(value.steamId)
    || !isNonnegativeBigint(value.generation)
    || !isIntegerInRange(value.accountId, 1, 2_147_483_647)
    || !isIntegerInRange(value.attempt, 1, 10)) {
    return false;
  }
  return value.messageId === null || isPositiveBigint(value.messageId);
}

type ClaimTimeWindow = "ok" | "invalid_clock" | "invalid_time" | "expired";

function validateClaimTimeWindow(
  claim: SteamOwnedJobClaim,
  nowEpochSeconds: () => number
): ClaimTimeWindow {
  let now: number;
  try {
    now = nowEpochSeconds();
  } catch {
    return "invalid_clock";
  }
  if (!isEpochSeconds(now)) return "invalid_clock";

  const chargedAt = parseClaimTimestamp(claim.chargedAt);
  const fetchStartedAt = parseClaimTimestamp(claim.fetchStartedAt);
  const leaseExpiresAt = parseClaimTimestamp(claim.leaseExpiresAt);
  if (chargedAt === null || fetchStartedAt === null || leaseExpiresAt === null) return "invalid_time";
  if (chargedAt > fetchStartedAt || fetchStartedAt > leaseExpiresAt) return "invalid_time";
  if (chargedAt > now + MAX_CLAIM_FUTURE_SKEW_SECONDS
    || fetchStartedAt > now + MAX_CLAIM_FUTURE_SKEW_SECONDS) return "invalid_time";
  if (leaseExpiresAt <= now) return "expired";
  return "ok";
}

function parseClaimTimestamp(value: string): number | null {
  // The DB adapter supplies UTC ISO strings. Requiring the explicit `Z` keeps
  // an unqualified timestamp from being interpreted in a worker's local zone.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || "0");
  if (month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return null;
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || milliseconds < 0
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond) return null;
  const seconds = milliseconds / 1_000;
  return seconds <= MAX_TIMESTAMPTZ_EPOCH_SECONDS ? seconds : null;
}

function isMode(value: unknown): value is SteamProviderMode {
  return value === "disabled" || value === "fixture" || value === "live";
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isSqlSteamId(value: unknown): value is string {
  return typeof value === "string"
    && /^[1-9][0-9]{0,18}$/.test(value)
    && withinSignedBigint(value);
}

function isPositiveBigint(value: unknown): value is string {
  return typeof value === "string"
    && /^[1-9][0-9]*$/.test(value)
    && withinSignedBigint(value);
}

function isNonnegativeBigint(value: unknown): value is string {
  return value === "0" || isPositiveBigint(value);
}

function withinSignedBigint(value: string): boolean {
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(STEAM_ID_SQL_BIGINT_MAX);
  } catch {
    return false;
  }
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function sanitizeFetchResult(value: unknown): SteamOwnedFetchResult {
  if (!isRecord(value) || value.provider !== "steam") {
    return invalidFetchResult("malformed_response");
  }
  if (value.status === "complete" && isCompleteShape(value)) return value;
  if (value.status === "unavailable" && isUnavailableShape(value)) return value;
  if (value.status === "invalid" && isInvalidShape(value)) return value;
  return invalidFetchResult("malformed_response");
}

function isCompleteShape(
  value: Record<string, unknown>
): value is Extract<SteamOwnedFetchResult, { status: "complete" }> {
  if (value.status !== "complete"
    || value.protocolVersion !== 1
    || !isIntegerInRange(value.gameCount, 0, DEFAULT_MAX_GAMES)
    || !Array.isArray(value.games)
    || typeof value.canonicalJson !== "string"
    || typeof value.contentHash !== "string"
    || !isProvenance(value.provenance)) {
    return false;
  }
  const provenance = value.provenance;
  if (value.games.length !== value.gameCount
    || byteLength(value.canonicalJson) > DEFAULT_MAX_PAYLOAD_BYTES
    || !/^[0-9a-f]{64}$/.test(value.contentHash)
    || provenance.httpStatus !== 200) {
    return false;
  }
  if (!isCanonicalGames(value.games, value.gameCount, provenance.observationTimeEpochSeconds)) {
    return false;
  }
  let expectedCanonical: string;
  try {
    expectedCanonical = JSON.stringify({
      provider: "steam",
      protocolVersion: 1,
      gameCount: value.gameCount,
      games: value.games
    });
  } catch {
    return false;
  }
  if (expectedCanonical !== value.canonicalJson) return false;
  const actualHash = createHash("sha256").update(value.canonicalJson, "utf8").digest("hex");
  return actualHash === value.contentHash;
}

function isCanonicalGames(
  games: unknown[],
  gameCount: number,
  observationTimeEpochSeconds: number
): boolean {
  let priorAppId: bigint | null = null;
  for (const game of games) {
    if (!isRecord(game)) return false;
    const keys = Object.keys(game);
    if (keys.length !== 6
      || keys.some((key, index) => key !== [
        "appId",
        "playtimeMinutes",
        "name",
        "nameSource",
        "lastPlayedAtEpochSeconds",
        "lastPlayedSource"
      ][index])) return false;

    if (typeof game.appId !== "string" || !/^[1-9][0-9]*$/.test(game.appId)) return false;
    let appId: bigint;
    try {
      appId = BigInt(game.appId);
    } catch {
      return false;
    }
    if (appId > BigInt(STEAM_APP_ID_MAX) || (priorAppId !== null && appId <= priorAppId)) return false;
    priorAppId = appId;

    if (game.playtimeMinutes !== null
      && !isIntegerInRange(game.playtimeMinutes, 0, MAX_PLAYTIME_MINUTES)) return false;
    if (typeof game.name !== "string"
      || !game.name
      || game.name.trim() !== game.name
      || Array.from(game.name).length > MAX_GAME_NAME_LENGTH
      || !isWellFormedUnicode(game.name)
      || hasDisallowedControl(game.name)) return false;
    if (game.nameSource !== "steam.name" && game.nameSource !== "catalog_stub") return false;
    if (game.nameSource === "catalog_stub" && game.name !== `Steam App ${game.appId}`) return false;

    if (game.lastPlayedAtEpochSeconds === null) {
      if (game.lastPlayedSource !== "steam.rtime_last_played_unknown"
        && game.lastPlayedSource !== "not_provided") return false;
    } else {
      if (game.lastPlayedSource !== "steam.rtime_last_played"
        || !isEpochSeconds(game.lastPlayedAtEpochSeconds)
        || game.lastPlayedAtEpochSeconds > observationTimeEpochSeconds + DEFAULT_MAX_FUTURE_SKEW_SECONDS) return false;
    }
  }
  return games.length === gameCount;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasDisallowedControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function isProvenance(value: unknown): value is SteamOwnedFetchProvenance {
  if (!isRecord(value)) return false;
  return value.endpoint === STEAM_COMPLETE_OWNED_SCOPE.endpoint
    && value.scope === STEAM_COMPLETE_OWNED_SCOPE.scope
    && value.includeAppInfo === true
    && value.includePlayedFreeGames === true
    && value.skipUnvettedApps === false
    && isIntegerInRange(value.httpStatus, 100, 599)
    && isIntegerInRange(value.bodyBytes, 0, DEFAULT_MAX_PAYLOAD_BYTES)
    && isEpochSeconds(value.observationTimeEpochSeconds);
}

function isUnavailableShape(value: Record<string, unknown>): value is SteamOwnedFetchUnavailable {
  if (value.status !== "unavailable") return false;
  if (value.reason === "private" || value.reason === "provider_error") return true;
  if (value.reason !== "http_error"
    && value.reason !== "timeout"
    && value.reason !== "cancelled"
    && value.reason !== "transport_error") {
    return false;
  }
  if (value.httpStatus !== undefined && !isIntegerInRange(value.httpStatus, 100, 599)) return false;
  if (value.retryAfterSeconds !== undefined
    && !isIntegerInRange(value.retryAfterSeconds, 0, MAX_STEAM_RETRY_AFTER_SECONDS)) return false;
  return value.retryDisposition === undefined
    || value.retryDisposition === "retryable"
    || value.retryDisposition === "deferred";
}

function isInvalidShape(value: Record<string, unknown>): value is SteamOwnedFetchInvalid {
  return value.status === "invalid"
    && typeof value.reason === "string"
    && typeof value.detail === "string";
}

function invalidFetchResult(reason: SteamOwnedSnapshotInvalid["reason"]): SteamOwnedFetchInvalid {
  return {
    status: "invalid",
    provider: "steam",
    reason,
    detail: "Steam owned-games result is malformed"
  };
}

function buildCompletePublishCall(
  claim: SteamOwnedJobClaim,
  result: Extract<SteamOwnedFetchResult, { status: "complete" }>
): SteamOwnedSnapshotPublishCall | null {
  const bodyObservedAt = epochSecondsToIso(result.provenance.observationTimeEpochSeconds);
  if (!bodyObservedAt) return null;
  return {
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    result: {
      status: "complete",
      provider: "steam",
      protocolVersion: 1,
      gameCount: result.gameCount,
      scope: "complete_owned",
      includeAppInfo: true,
      includePlayedFreeGames: true,
      skipUnvettedApps: false,
      httpStatus: 200,
      bodyBytes: result.provenance.bodyBytes
    },
    canonicalJson: result.canonicalJson,
    contentHash: decodeHash(result.contentHash),
    bodyObservedAt,
    messageId: claim.messageId
  };
}

function decodeHash(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function buildRetryCall(
  claim: SteamOwnedJobClaim,
  result: SteamOwnedFetchUnavailable,
  nowEpochSeconds: () => number
): SteamOwnedSnapshotRetryCall {
  let retryPolicy: SteamOwnedSnapshotRetryCall["retryPolicy"] = result.reason === "cancelled"
    ? "non_retryable"
    : result.retryDisposition === "deferred"
      ? "deferred"
      : "retryable";
  const providerRetryAt = retryPolicy === "retryable"
    && result.retryAfterSeconds !== undefined
    ? delayToIso(result.retryAfterSeconds, nowEpochSeconds)
    : null;
  // A supplied provider minimum is safety-critical. If the injected clock or
  // conversion fails, defer rather than schedule an earlier retry.
  if (result.retryAfterSeconds !== undefined && providerRetryAt === null) {
    retryPolicy = "deferred";
  }
  return {
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    errorCode: retryErrorCode(result, retryPolicy),
    errorDetail: retryErrorDetail(result),
    providerRetryAt: retryPolicy === "retryable" ? providerRetryAt : null,
    retryPolicy,
    messageId: retryPolicy === "retryable" ? null : claim.messageId
  };
}

function retryErrorCode(
  result: SteamOwnedFetchUnavailable,
  retryPolicy: SteamOwnedSnapshotRetryCall["retryPolicy"]
): string {
  if (result.reason === "timeout") return "steam_timeout";
  if (result.reason === "cancelled") return "steam_cancelled";
  if (result.reason === "transport_error") return "steam_transport_error";
  if (retryPolicy === "deferred") return "steam_retry_deferred";
  return "steam_http_error";
}

function retryErrorDetail(result: SteamOwnedFetchUnavailable): string {
  if (result.reason === "timeout") return "Steam owned-games request timed out";
  if (result.reason === "cancelled") return "Steam owned-games request was cancelled";
  if (result.reason === "transport_error") return "Steam owned-games transport failed";
  if (result.httpStatus !== undefined) return `Steam owned-games HTTP status ${result.httpStatus}`;
  return "Steam owned-games provider request failed";
}

function delayToIso(delaySeconds: number, nowEpochSeconds: () => number): string | null {
  if (!isIntegerInRange(delaySeconds, 0, MAX_STEAM_RETRY_AFTER_SECONDS)) return null;
  let now: number;
  try {
    now = nowEpochSeconds();
  } catch {
    return null;
  }
  if (!isEpochSeconds(now)) return null;
  return epochSecondsToIso(now + delaySeconds);
}

async function publishTerminal(
  db: SteamOwnedJobDatabase,
  call: SteamOwnedSnapshotPublishCall
): Promise<SteamOwnedJobRunResult> {
  let result: SteamOwnedSnapshotPublishResult;
  try {
    result = await db.publishOwnedSnapshot(call);
  } catch {
    return publishDbError("publish_failed", call);
  }
  if (!isPublishResult(result)) {
    return publishDbError("publish_failed", call);
  }
  if (result.result === "stale") return { status: "stale", phase: "publish" };
  if (!result.acknowledged) {
    return publishDbError("publish_not_acknowledged", call);
  }
  return {
    status: "published",
    result: result.result,
    acknowledged: result.acknowledged
  };
}

function publishDbError(
  code: "publish_failed" | "publish_not_acknowledged",
  call: SteamOwnedSnapshotPublishCall
): SteamOwnedJobRunResult {
  const result: SteamOwnedJobRunResult = {
    status: "db_error",
    phase: "publish",
    code
  };
  // Keep the replay material available to the internal worker while excluding
  // the bounded game set from accidental JSON logs or user DTO serialization.
  Object.defineProperty(result, "preparedPublish", {
    value: { call: clonePublishCall(call) },
    enumerable: false,
    writable: false,
    configurable: false
  });
  return result;
}

function clonePublishCall(call: SteamOwnedSnapshotPublishCall): SteamOwnedSnapshotPublishCall {
  return {
    ...call,
    contentHash: call.contentHash === null ? null : new Uint8Array(call.contentHash)
  };
}

async function retryTerminal(
  db: SteamOwnedJobDatabase,
  call: SteamOwnedSnapshotRetryCall
): Promise<SteamOwnedJobRunResult> {
  let result: SteamOwnedSnapshotRetryResult;
  try {
    result = await db.retryJob(call);
  } catch {
    return { status: "db_error", phase: "retry", code: "retry_failed" };
  }
  if (!isRetryResult(result)) {
    return { status: "db_error", phase: "retry", code: "retry_failed" };
  }
  if (result.status === "stale") return { status: "stale", phase: "retry" };
  if (call.messageId !== null && !result.acknowledged) {
    return { status: "db_error", phase: "retry", code: "retry_not_acknowledged" };
  }
  return {
    status: "retry_scheduled",
    retryPolicy: call.retryPolicy,
    result
  };
}

function isPublishResult(value: unknown): value is SteamOwnedSnapshotPublishResult {
  return isRecord(value)
    && (value.result === "applied" || value.result === "already_applied" || value.result === "stale")
    && typeof value.acknowledged === "boolean";
}

function isRetryResult(value: unknown): value is SteamOwnedSnapshotRetryResult {
  return isRecord(value)
    && (value.status === "retryable"
      || value.status === "deferred"
      || value.status === "non_retryable"
      || value.status === "stale"
      || value.status === "failed"
      || value.status === "cancelled"
      || value.status === "already_applied")
    && (value.retryAt === null || typeof value.retryAt === "string")
    && isIntegerInRange(value.attempt, 0, 10)
    && typeof value.acknowledged === "boolean";
}

function toPublishInvalidReason(value: string): SteamOwnedSnapshotInvalid["reason"] {
  const allowed: ReadonlySet<string> = new Set([
    "invalid_json",
    "malformed_response",
    "invalid_game_count",
    "count_mismatch",
    "duplicate_app_id",
    "invalid_app_id",
    "invalid_playtime_minutes",
    "invalid_last_played",
    "invalid_name",
    "too_many_games",
    "payload_too_large"
  ]);
  return allowed.has(value) ? value as SteamOwnedSnapshotInvalid["reason"] : "malformed_response";
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_TIMESTAMPTZ_EPOCH_SECONDS;
}

function epochSecondsToIso(value: number): string | null {
  if (!isEpochSeconds(value)) return null;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
