import { createHash } from "node:crypto";

/**
 * Steam's AppID is an unsigned provider identifier. Keep it as a decimal
 * string so a later SQL adapter cannot accidentally narrow it to int32.
 */
export const STEAM_APP_ID_MAX = 4_294_967_295;

/** `app.library_games.playtime_minutes` is a PostgreSQL integer. */
export const MAX_PLAYTIME_MINUTES = 2_147_483_647;

/** A full owned-games response is intentionally bounded before publication. */
export const DEFAULT_MAX_GAMES = 10_000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * PostgreSQL timestamptz stores microseconds in a signed 64-bit integer. This
 * is a conservative whole-second upper bound for values that can be written to
 * the activity timestamp column. A fetch boundary must still pass an explicit
 * observation time so realistic future values are rejected too.
 */
export const MAX_TIMESTAMPTZ_EPOCH_SECONDS = 9_223_372_036_854;

/** Steam data can arrive a few minutes after it was observed. */
export const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
export const MAX_FUTURE_SKEW_SECONDS = 31 * 24 * 60 * 60;

/** Keep a provider title inside the catalogue title bound. */
export const MAX_GAME_NAME_LENGTH = 500;

/** Bound the compatibility walk before any provider body can consume the stack. */
export const MAX_JSON_DEPTH = 256;
export const MAX_JSON_NODES = 250_000;

export type SteamOwnedGame = {
  appId: string;
  playtimeMinutes: number | null;
  name: string;
  nameSource: "steam.name" | "catalog_stub";
  lastPlayedAtEpochSeconds: number | null;
  lastPlayedSource: "steam.rtime_last_played" | "steam.rtime_last_played_unknown" | "not_provided";
};

export type SteamOwnedSnapshot = {
  status: "complete";
  provider: "steam";
  protocolVersion: 1;
  gameCount: number;
  games: SteamOwnedGame[];
  /** Canonical JSON of provider-independent rows, for the SQL publish step. */
  canonicalJson: string;
  /** SHA-256 of canonicalJson; stable when provider order changes. */
  contentHash: string;
};

export type SteamOwnedSnapshotUnavailable = {
  status: "unavailable";
  provider: "steam";
  reason: "private" | "provider_error";
};

export type SteamOwnedSnapshotInvalid = {
  status: "invalid";
  provider: "steam";
  reason:
    | "invalid_json"
    | "malformed_response"
    | "invalid_game_count"
    | "count_mismatch"
    | "duplicate_app_id"
    | "invalid_app_id"
    | "invalid_playtime_minutes"
    | "invalid_last_played"
    | "invalid_name"
    | "too_many_games"
    | "payload_too_large";
  /** A bounded diagnostic safe to retain in a job record. */
  detail: string;
};

export type SteamOwnedSnapshotResult =
  | SteamOwnedSnapshot
  | SteamOwnedSnapshotUnavailable
  | SteamOwnedSnapshotInvalid;

export type NormalizeSteamOwnedSnapshotOptions = {
  maxGames?: number;
  maxPayloadBytes?: number;
  /**
   * Unix seconds at which the complete provider body was observed. Positive
   * rtime_last_played values require this explicit anchor; no wall clock is
   * read by the normalizer.
   */
  observationTimeEpochSeconds?: number;
  /** Allowed provider clock/transport skew for rtime_last_played. */
  maxFutureSkewSeconds?: number;
};

/**
 * Normalize one complete Steam GetOwnedGames response without network or
 * database access. A complete result is the only result that may authorize an
 * ownership sweep. Every malformed record rejects the entire response.
 *
 * The HTTP/fetch boundary must separately establish that this body came from a
 * successful request for the complete owned scope. This function intentionally
 * cannot infer HTTP status, request filters, authentication state, or body
 * completeness from JSON alone.
 */
export function normalizeSteamOwnedSnapshot(
  input: unknown,
  options: NormalizeSteamOwnedSnapshotOptions = {}
): SteamOwnedSnapshotResult {
  const maxGames = options.maxGames ?? DEFAULT_MAX_GAMES;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const observationTimeEpochSeconds = options.observationTimeEpochSeconds;
  const maxFutureSkewSeconds = options.maxFutureSkewSeconds ?? DEFAULT_MAX_FUTURE_SKEW_SECONDS;

  if (!Number.isSafeInteger(maxGames) || maxGames < 0 || maxGames > DEFAULT_MAX_GAMES) {
    return invalid("malformed_response", "normalizer limits are invalid");
  }
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > DEFAULT_MAX_PAYLOAD_BYTES) {
    return invalid("malformed_response", "normalizer byte limit is invalid");
  }
  if (observationTimeEpochSeconds !== undefined && !isEpochSeconds(observationTimeEpochSeconds)) {
    return invalid("malformed_response", "observation time must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(maxFutureSkewSeconds) || maxFutureSkewSeconds < 0 || maxFutureSkewSeconds > MAX_FUTURE_SKEW_SECONDS) {
    return invalid("malformed_response", "future skew limit is invalid");
  }

  const parsed = parseInput(input, maxPayloadBytes);
  if (!parsed.ok) return parsed.result;
  try {
    const inspection = inspectJsonCompatibility(parsed.value);
    if (inspection === "invalid") {
      return invalid("malformed_response", "input contains an invalid key or string");
    }
    if (inspection === "too_deep") {
      return invalid("malformed_response", `input exceeds JSON depth limit ${MAX_JSON_DEPTH}`);
    }
    if (inspection === "too_many_nodes") {
      return invalid("malformed_response", `input exceeds JSON node limit ${MAX_JSON_NODES}`);
    }
  } catch {
    return invalid("malformed_response", "input cannot be inspected");
  }
  if (!isRecord(parsed.value) || !Object.prototype.hasOwnProperty.call(parsed.value, "response")) {
    return invalid("malformed_response", "response field is missing");
  }
  const topLevel = parsed.value;
  const response = topLevel.response;
  if (!isRecord(response)) {
    return invalid("malformed_response", "response must be an object");
  }

  const hasTopLevelSuccess = Object.prototype.hasOwnProperty.call(topLevel, "success");
  if (hasTopLevelSuccess && typeof topLevel.success !== "boolean") {
    return invalid("malformed_response", "success must be a boolean");
  }
  const hasTopLevelErrorProperty = Object.prototype.hasOwnProperty.call(topLevel, "error");
  const topLevelErrorValue = topLevel.error;
  const hasTopLevelErrorMarker = hasTopLevelErrorProperty
    && topLevelErrorValue !== null
    && topLevelErrorValue !== undefined;
  if (hasTopLevelErrorMarker && !isProviderErrorMarker(topLevelErrorValue)) {
    return invalid("malformed_response", "error must be a nonempty string or object");
  }

  const hasResponseSuccess = Object.prototype.hasOwnProperty.call(response, "success");
  if (hasResponseSuccess && typeof response.success !== "boolean") {
    return invalid("malformed_response", "response.success must be a boolean");
  }

  const responseIsEmpty = Object.keys(response).length === 0;
  const hasGameCount = Object.prototype.hasOwnProperty.call(response, "game_count");
  const hasGames = Object.prototype.hasOwnProperty.call(response, "games");
  const hasPayloadFields = hasGameCount || hasGames;
  const hasErrorProperty = Object.prototype.hasOwnProperty.call(response, "error");
  const errorValue = response.error;
  // `error: null` is a harmless explicit absence used by some wrappers. Any
  // other present value is a marker and must not coexist with owned rows.
  const hasErrorMarker = hasErrorProperty && errorValue !== null && errorValue !== undefined;
  if (hasErrorMarker && !isProviderErrorMarker(errorValue)) {
    return invalid("malformed_response", "response.error must be a nonempty string or object");
  }

  // A provider failure is unavailable only when it carries no game payload.
  // `success:false`/`error:{...}` plus game_count 0 or games [] is a
  // contradictory payload and is invalid, so it cannot authorize a sweep.
  // Check the top-level markers as well: wrappers sometimes put them beside
  // `response`, and they must have the same no-sweep semantics.
  const hasFailureMarker = topLevel.success === false
    || hasTopLevelErrorMarker
    || response.success === false
    || hasErrorMarker;
  const hasSuccessMarker = topLevel.success === true || response.success === true;
  if (hasFailureMarker) {
    if (hasPayloadFields || hasSuccessMarker) {
      return invalid("malformed_response", "provider error markers contradict an owned-games payload");
    }
    return unavailable("provider_error");
  }

  // Steam uses an empty response for private/restricted game details. It must
  // never be treated as an empty library and must not delete ownership. An
  // explicit success marker without a count is contradictory instead.
  if (responseIsEmpty) {
    return hasSuccessMarker
      ? invalid("malformed_response", "success marker contradicts an empty response")
      : unavailable("private");
  }

  const gameCount = parseGameCount(response.game_count);
  if (gameCount === null) return invalid("invalid_game_count", "game_count must be a nonnegative safe integer");
  if (gameCount > maxGames) return invalid("too_many_games", `game_count exceeds ${maxGames}`);

  const rawGames = response.games;
  if (rawGames === undefined) {
    // A zero count is an explicit empty confirmation. A positive count without
    // records is contradictory and therefore invalid.
    if (gameCount !== 0) return invalid("count_mismatch", "games is missing for a nonzero game_count");
    const empty = completeSnapshot(0, []);
    return byteLength(empty.canonicalJson) > maxPayloadBytes
      ? invalid("payload_too_large", `canonical snapshot exceeds ${maxPayloadBytes} bytes`)
      : empty;
  }
  if (!Array.isArray(rawGames)) return invalid("malformed_response", "games must be an array");
  if (rawGames.length !== gameCount) return invalid("count_mismatch", "game_count does not match games length");
  if (rawGames.length > maxGames) return invalid("too_many_games", `games exceeds ${maxGames}`);

  const seen = new Set<string>();
  const games: SteamOwnedGame[] = [];
  for (let index = 0; index < rawGames.length; index += 1) {
    const rawGame = rawGames[index];
    if (!isRecord(rawGame)) return invalid("malformed_response", `games[${index}] must be an object`);

    const appId = normalizeAppId(rawGame.appid);
    if (appId === null) return invalid("invalid_app_id", `games[${index}].appid is invalid`);
    if (seen.has(appId)) return invalid("duplicate_app_id", `duplicate appid ${appId}`);
    seen.add(appId);

    const playtimeMinutes = normalizeMinutes(rawGame.playtime_forever);
    if (playtimeMinutes === INVALID) {
      return invalid("invalid_playtime_minutes", `games[${index}].playtime_forever is invalid`);
    }

    const timestamp = normalizeLastPlayed(rawGame.rtime_last_played, observationTimeEpochSeconds, maxFutureSkewSeconds);
    if (timestamp === INVALID) {
      return invalid("invalid_last_played", `games[${index}].rtime_last_played is invalid or outside the observation bound`);
    }

    const name = normalizeName(rawGame.name, appId);
    if (name === INVALID) return invalid("invalid_name", `games[${index}].name is invalid`);

    games.push({
      appId,
      playtimeMinutes,
      name: name.value,
      nameSource: name.source,
      lastPlayedAtEpochSeconds: timestamp.value,
      lastPlayedSource: timestamp.source
    });
  }

  // The provider does not promise record order. Sorting makes the publish
  // payload, retry comparison and content hash independent of that order.
  games.sort((left, right) => Number(left.appId) - Number(right.appId));
  const result = completeSnapshot(gameCount, games);
  if (byteLength(result.canonicalJson) > maxPayloadBytes) {
    return invalid("payload_too_large", `canonical snapshot exceeds ${maxPayloadBytes} bytes`);
  }
  return result;
}

const INVALID = Symbol("invalid");
type InvalidValue = typeof INVALID;

function completeSnapshot(gameCount: number, games: SteamOwnedGame[]): SteamOwnedSnapshot {
  const canonical = {
    provider: "steam" as const,
    protocolVersion: 1 as const,
    gameCount,
    games
  };
  const canonicalJson = JSON.stringify(canonical);
  const contentHash = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return { status: "complete", ...canonical, canonicalJson, contentHash };
}

function parseInput(input: unknown, maxPayloadBytes: number):
  | { ok: true; value: unknown }
  | { ok: false; result: SteamOwnedSnapshotInvalid } {
  if (typeof input === "string") {
    if (byteLength(input) > maxPayloadBytes) return { ok: false, result: invalid("payload_too_large", "input exceeds byte limit") };
    try {
      return { ok: true, value: JSON.parse(input) };
    } catch {
      return { ok: false, result: invalid("invalid_json", "input is not valid JSON") };
    }
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > maxPayloadBytes) return { ok: false, result: invalid("payload_too_large", "input exceeds byte limit") };
    try {
      // Fatal decoding prevents malformed UTF-8 from being replaced with U+FFFD
      // and accidentally producing a publishable, different document.
      return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) };
    } catch {
      return { ok: false, result: invalid("invalid_json", "input is not valid UTF-8 JSON") };
    }
  }
  try {
    // BigInt and cyclic objects fail here. The public transport is JSON, so a
    // direct bigint AppID is intentionally rejected before AppID normalization.
    const serialized = JSON.stringify(input);
    if (typeof serialized !== "string") {
      return { ok: false, result: invalid("malformed_response", "input cannot be serialized") };
    }
    if (byteLength(serialized) > maxPayloadBytes) {
      return { ok: false, result: invalid("payload_too_large", "input exceeds byte limit") };
    }
  } catch {
    return { ok: false, result: invalid("malformed_response", "input cannot be serialized") };
  }
  return { ok: true, value: input };
}

function parseGameCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeAppId(value: unknown): string | null {
  let appId: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1 || value > STEAM_APP_ID_MAX) return null;
    appId = String(value);
  } else if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    appId = value;
  } else {
    return null;
  }
  try {
    const parsed = BigInt(appId);
    return parsed <= BigInt(STEAM_APP_ID_MAX) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizeMinutes(value: unknown): number | null | InvalidValue {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PLAYTIME_MINUTES
    ? value
    : INVALID;
}

function normalizeLastPlayed(
  value: unknown,
  observationTimeEpochSeconds: number | undefined,
  maxFutureSkewSeconds: number
):
  | { value: number | null; source: SteamOwnedGame["lastPlayedSource"] }
  | InvalidValue {
  if (value === undefined) return { value: null, source: "not_provided" };
  if (value === null || value === 0) return { value: null, source: "steam.rtime_last_played_unknown" };
  if (typeof value !== "number" || !isEpochSeconds(value)) return INVALID;
  // A positive provider timestamp is useful only when its observation anchor
  // is explicit. This avoids consulting Date.now() and keeps hashes stable.
  if (observationTimeEpochSeconds === undefined) return INVALID;
  if (value > observationTimeEpochSeconds + maxFutureSkewSeconds) return INVALID;
  return { value, source: "steam.rtime_last_played" };
}

function normalizeName(value: unknown, appId: string):
  | { value: string; source: SteamOwnedGame["nameSource"] }
  | InvalidValue {
  if (value === undefined || value === null) return { value: `Steam App ${appId}`, source: "catalog_stub" };
  if (typeof value !== "string") return INVALID;
  const name = value.trim();
  if (!name) return { value: `Steam App ${appId}`, source: "catalog_stub" };
  if (Array.from(name).length > MAX_GAME_NAME_LENGTH || hasDisallowedControl(name) || !isWellFormedUnicode(name)) return INVALID;
  return { value: name, source: "steam.name" };
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_TIMESTAMPTZ_EPOCH_SECONDS;
}

function isProviderErrorMarker(value: unknown): boolean {
  return (typeof value === "string" && value.trim().length > 0) || isRecord(value);
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

type JsonInspection = "ok" | "invalid" | "too_deep" | "too_many_nodes";

/**
 * Inspect untrusted parsed JSON without recursion. Keys are checked as well as
 * values because PostgreSQL JSONB rejects NUL and malformed Unicode in either
 * position. A depth/node bound makes deeply nested or broad input a typed
 * normalizer result rather than a stack/resource failure.
 */
function inspectJsonCompatibility(root: unknown): JsonInspection {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let nodeCount = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > MAX_JSON_NODES) return "too_many_nodes";

    if (typeof current.value === "string") {
      if (!isWellFormedUnicode(current.value) || hasDisallowedControl(current.value)) return "invalid";
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    const objectValue = current.value as Record<string, unknown>;
    const keys = Object.keys(objectValue);
    if (current.depth >= MAX_JSON_DEPTH && keys.length > 0) return "too_deep";
    for (const key of keys) {
      if (!isWellFormedUnicode(key) || hasDisallowedControl(key)) return "invalid";
      stack.push({ value: objectValue[key], depth: current.depth + 1 });
    }
  }
  return "ok";
}

function hasDisallowedControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function invalid(reason: SteamOwnedSnapshotInvalid["reason"], detail: string): SteamOwnedSnapshotInvalid {
  return { status: "invalid", provider: "steam", reason, detail: detail.slice(0, 240) };
}

function unavailable(reason: SteamOwnedSnapshotUnavailable["reason"]): SteamOwnedSnapshotUnavailable {
  return { status: "unavailable", provider: "steam", reason };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
