import {
  DEFAULT_MAX_GAMES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  MAX_TIMESTAMPTZ_EPOCH_SECONDS,
  normalizeSteamOwnedSnapshot,
  type SteamOwnedSnapshot,
  type SteamOwnedSnapshotInvalid,
  type SteamOwnedSnapshotUnavailable
} from "./steam-owned-snapshot.ts";

/**
 * This is the endpoint already used by the legacy Steam adapter. Steam's
 * current Web API documentation presents the same method as `/v1/`; the
 * `v0001` spelling remains the compatible request path used by this app.
 */
export const STEAM_OWNED_GAMES_ENDPOINT =
  "https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/";
export const STEAM_OWNED_GAMES_OPERATION = "IPlayerService/GetOwnedGames/v0001" as const;

/** Keep the fetch boundary no slower than the existing Steam request policy. */
export const DEFAULT_STEAM_FETCH_TIMEOUT_MS = 12_000;
export const MAX_STEAM_FETCH_TIMEOUT_MS = 120_000;

/** Steam documents this argument as uint64; keep it as a decimal string. */
export const STEAM_ID64_MAX = "18446744073709551615";
const STEAM_ID64_MAX_VALUE = BigInt(STEAM_ID64_MAX);
/** M1 stores the Steam identity in PostgreSQL signed bigint. */
export const STEAM_ID_SQL_BIGINT_MAX = "9223372036854775807";
const STEAM_ID_SQL_BIGINT_MAX_VALUE = BigInt(STEAM_ID_SQL_BIGINT_MAX);

/** Retry metadata is bounded without shortening valid provider delays. */
export const MAX_STEAM_RETRY_AFTER_SECONDS = 30 * 24 * 60 * 60;

/**
 * The full scope is deliberately represented by constants rather than caller
 * options. A later SQL publish may trust this provenance only for a request
 * made with these exact semantics.
 */
export const STEAM_COMPLETE_OWNED_SCOPE = {
  endpoint: STEAM_OWNED_GAMES_OPERATION,
  scope: "complete_owned" as const,
  includeAppInfo: true as const,
  includePlayedFreeGames: true as const,
  skipUnvettedApps: false as const
};

export type SteamOwnedGamesFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type FetchSteamOwnedSnapshotOptions = {
  /** Injected in tests; the production boundary supplies the app fetch. */
  fetch: SteamOwnedGamesFetch;
  /** Unix seconds captured after the complete response body has been read. */
  nowEpochSeconds: () => number;
  /** An account cancellation signal; it is never replaced with a retry. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxGames?: number;
  maxPayloadBytes?: number;
};

export type SteamOwnedFetchProvenance = {
  endpoint: typeof STEAM_OWNED_GAMES_OPERATION;
  scope: typeof STEAM_COMPLETE_OWNED_SCOPE.scope;
  includeAppInfo: true;
  includePlayedFreeGames: true;
  skipUnvettedApps: false;
  httpStatus: number;
  bodyBytes: number;
  observationTimeEpochSeconds: number;
};

export type SteamOwnedFetchComplete = SteamOwnedSnapshot & {
  /** Only a complete body receives trusted provenance for SQL publication. */
  provenance: SteamOwnedFetchProvenance;
};

export type SteamOwnedFetchUnavailableReason =
  | SteamOwnedSnapshotUnavailable["reason"]
  | "http_error"
  | "timeout"
  | "cancelled"
  | "transport_error";

export type SteamRetryDisposition = "retryable" | "deferred";

export type SteamOwnedFetchUnavailable = {
  status: "unavailable";
  provider: "steam";
  reason: SteamOwnedFetchUnavailableReason;
  /** Safe, bounded detail; never contains the request URL, key, or body. */
  detail?: string;
  /** Safe transport metadata for M2 retry scheduling. */
  httpStatus?: number;
  retryAfterSeconds?: number;
  retryDisposition?: SteamRetryDisposition;
};

export type SteamOwnedFetchInvalidReason =
  | SteamOwnedSnapshotInvalid["reason"]
  | "invalid_steam_id"
  | "invalid_api_key"
  | "invalid_fetch_options"
  | "truncated_body";

export type SteamOwnedFetchInvalid = {
  status: "invalid";
  provider: "steam";
  reason: SteamOwnedFetchInvalidReason;
  /** Safe, bounded detail; never contains provider body text. */
  detail: string;
};

export type SteamOwnedFetchResult =
  | SteamOwnedFetchComplete
  | SteamOwnedFetchUnavailable
  | SteamOwnedFetchInvalid;

type BodyReadResult =
  | { kind: "complete"; bytes: Uint8Array }
  | { kind: "too_large" }
  | { kind: "aborted" }
  | { kind: "truncated" };

/**
 * Fetch and normalize one complete owned-games response. The function has no
 * retry path and accepts no filter/pinned subset argument: a `complete` result
 * can only come from the full owned scope requested here.
 *
 * Callers must reserve authorization, quota, and a generation/lease before
 * invoking this function. It performs the network operation outside the
 * future SQL publish transaction.
 */
export async function fetchSteamOwnedSnapshot(
  steamId: string,
  apiKey: string,
  options: FetchSteamOwnedSnapshotOptions
): Promise<SteamOwnedFetchResult> {
  const limits = validateOptions(options);
  if (limits) return limits;
  if (!isValidSteamId(steamId)) {
    return invalid("invalid_steam_id", "Steam account identifier is invalid");
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0 || apiKey.length > 512) {
    return invalid("invalid_api_key", "Steam request credentials are invalid");
  }
  if (options.signal?.aborted) {
    return unavailable("cancelled", "Steam owned-games request was cancelled");
  }

  const maxGames = options.maxGames ?? DEFAULT_MAX_GAMES;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STEAM_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => {
    cancelled = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      const request = options.fetch(buildSteamOwnedGamesUrl(steamId, apiKey), {
        headers: {
          Accept: "application/json",
          "User-Agent": "VaultShuffle/0.1"
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal
      });
      response = await waitForAbort(request, controller.signal);
    } catch {
      if (cancelled) return unavailable("cancelled", "Steam owned-games request was cancelled");
      if (timedOut) return unavailable("timeout", "Steam owned-games request timed out");
      return unavailable("transport_error", "Steam owned-games request failed");
    }

    if (!response || typeof response.status !== "number"
      || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      return invalid("truncated_body", "Steam owned-games response is malformed");
    }

    // A partial (206), queued (202), or bodyless (204) success is not a
    // complete point-in-time owned snapshot. Require the endpoint's ordinary
    // full response status exactly, rather than treating all 2xx as sweepable.
    if (response.status !== 200) {
      cancelBody(response);
      return unavailable("http_error", "Steam owned-games request returned an HTTP error", {
        httpStatus: response.status,
        ...retryMetadata(response, options.nowEpochSeconds)
      });
    }

    const declaredBytes = declaredBodyLength(response);
    if (declaredBytes !== undefined && declaredBytes > maxPayloadBytes) {
      cancelBody(response);
      return invalid("payload_too_large", `Steam owned-games body exceeds ${maxPayloadBytes} bytes`);
    }

    const body = await readBoundedBody(response.body, controller.signal, maxPayloadBytes);
    if (body.kind === "aborted") {
      if (cancelled) return unavailable("cancelled", "Steam owned-games request was cancelled");
      if (timedOut) return unavailable("timeout", "Steam owned-games request timed out");
      return unavailable("transport_error", "Steam owned-games request was aborted");
    }
    if (body.kind === "too_large") {
      return invalid("payload_too_large", `Steam owned-games body exceeds ${maxPayloadBytes} bytes`);
    }
    if (body.kind === "truncated") {
      return invalid("truncated_body", "Steam owned-games body was not read completely");
    }
    if (declaredBytes !== undefined && declaredBytes !== body.bytes.byteLength
      && !response.headers?.get("content-encoding")) {
      return invalid("truncated_body", "Steam owned-games body length is incomplete");
    }

    let observationTimeEpochSeconds: number;
    try {
      observationTimeEpochSeconds = options.nowEpochSeconds();
    } catch {
      return unavailable("transport_error", "Steam owned-games observation time was unavailable");
    }
    if (!isEpochSeconds(observationTimeEpochSeconds)) {
      return invalid("invalid_fetch_options", "Steam owned-games observation time is invalid");
    }

    const normalized = normalizeSteamOwnedSnapshot(body.bytes, {
      maxGames,
      maxPayloadBytes,
      observationTimeEpochSeconds
    });
    if (normalized.status === "complete") {
      return {
        ...normalized,
        provenance: {
          ...STEAM_COMPLETE_OWNED_SCOPE,
          httpStatus: response.status,
          bodyBytes: body.bytes.byteLength,
          observationTimeEpochSeconds
        }
      };
    }
    if (normalized.status === "unavailable") {
      return normalized;
    }
    return invalid(normalized.reason, safeNormalizerDetail(normalized.reason));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function validateOptions(options: FetchSteamOwnedSnapshotOptions): SteamOwnedFetchInvalid | null {
  if (!options || typeof options.fetch !== "function" || typeof options.nowEpochSeconds !== "function") {
    return invalid("invalid_fetch_options", "Steam fetch dependencies are invalid");
  }
  const maxGames = options.maxGames ?? DEFAULT_MAX_GAMES;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STEAM_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxGames) || maxGames < 0 || maxGames > DEFAULT_MAX_GAMES) {
    return invalid("invalid_fetch_options", "Steam fetch game limit is invalid");
  }
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > DEFAULT_MAX_PAYLOAD_BYTES) {
    return invalid("invalid_fetch_options", "Steam fetch byte limit is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STEAM_FETCH_TIMEOUT_MS) {
    return invalid("invalid_fetch_options", "Steam fetch timeout is invalid");
  }
  return null;
}

function buildSteamOwnedGamesUrl(steamId: string, apiKey: string): string {
  const params = new URLSearchParams({
    key: apiKey,
    steamid: steamId,
    include_appinfo: "1",
    include_played_free_games: "1",
    // Steam's current public reference does not list this newer scope flag,
    // but omitting it can leave unvetted/profile-limited apps out. Keep the
    // complete-library policy explicit and record it in trusted provenance.
    skip_unvetted_apps: "0",
    format: "json"
  });
  return `${STEAM_OWNED_GAMES_ENDPOINT}?${params.toString()}`;
}

function isValidSteamId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed <= STEAM_ID64_MAX_VALUE && parsed <= STEAM_ID_SQL_BIGINT_MAX_VALUE;
  } catch {
    return false;
  }
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_TIMESTAMPTZ_EPOCH_SECONDS;
}

function declaredBodyLength(response: Response): number | undefined {
  const contentLength = response.headers?.get("content-length")?.trim();
  if (!contentLength || !/^\d+$/.test(contentLength)) return undefined;
  try {
    const length = BigInt(contentLength);
    return length <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(length) : Number.MAX_SAFE_INTEGER;
  } catch {
    return undefined;
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  maxPayloadBytes: number
): Promise<BodyReadResult> {
  if (!body) return { kind: "truncated" };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    return { kind: "truncated" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await readChunkWithAbort(reader, signal);
      } catch {
        return signal.aborted ? { kind: "aborted" } : { kind: "truncated" };
      }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) return { kind: "truncated" };
      total += next.value.byteLength;
      if (total > maxPayloadBytes) {
        cancelReader(reader);
        return { kind: "too_large" };
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An abort may leave a custom reader's pending read in flight. The
      // abort race has already returned a typed result to the caller.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "complete", bytes };
}

function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finishResolve = (value: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cancelReader(reader);
      finishReject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      reader.read().then(finishResolve, finishReject);
    } catch (error) {
      finishReject(error);
    }
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort; the bounded result is already decided.
  }
}

function cancelBody(response: Response): void {
  try {
    if (response.body) void response.body.cancel().catch(() => undefined);
  } catch {
    // The response is already being rejected; never surface upstream details.
  }
}

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(finishResolve, finishReject);
  });
}

function retryMetadata(
  response: Response,
  nowEpochSeconds: () => number
): Pick<SteamOwnedFetchUnavailable, "retryAfterSeconds" | "retryDisposition"> {
  const raw = response.headers?.get("retry-after")?.trim();
  if (!raw) {
    return response.status === 429
      ? { retryAfterSeconds: 60, retryDisposition: "retryable" }
      : {};
  }

  if (/^\d+$/.test(raw)) {
    // Strip leading zeroes before comparing text lengths. This both accepts
    // ordinary zero-padded delta-seconds and avoids feeding an unbounded
    // provider header to BigInt.
    const canonical = raw.replace(/^0+/, "") || "0";
    const maximum = String(MAX_STEAM_RETRY_AFTER_SECONDS);
    if (canonical.length > maximum.length
      || (canonical.length === maximum.length && canonical > maximum)) {
      return { retryDisposition: "deferred" };
    }
    const value = Number(canonical);
    return Number.isSafeInteger(value)
      ? { retryAfterSeconds: value, retryDisposition: "retryable" }
      : { retryDisposition: "deferred" };
  }

  if (!isHttpDate(raw)) return { retryDisposition: "deferred" };
  // The obsolete asctime form intentionally has no zone token. RFC 9110
  // defines it as GMT; Date.parse otherwise interprets it in the host's local
  // timezone, which would shorten or lengthen the provider delay.
  const retryAtMilliseconds = parseHttpDate(raw);
  if (!Number.isFinite(retryAtMilliseconds)) return { retryDisposition: "deferred" };

  let now: number;
  try {
    now = nowEpochSeconds();
  } catch {
    return { retryDisposition: "deferred" };
  }
  if (!isEpochSeconds(now)) return { retryDisposition: "deferred" };

  const delay = Math.max(0, Math.ceil(retryAtMilliseconds / 1000 - now));
  return delay > MAX_STEAM_RETRY_AFTER_SECONDS
    ? { retryDisposition: "deferred" }
    : { retryAfterSeconds: delay, retryDisposition: "retryable" };
}

const HTTP_DATE_PATTERNS = [
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/
] as const;

function isHttpDate(value: string): boolean {
  return HTTP_DATE_PATTERNS.some((pattern) => pattern.test(value));
}

function parseHttpDate(value: string): number {
  return HTTP_DATE_PATTERNS[2].test(value)
    ? Date.parse(`${value} GMT`)
    : Date.parse(value);
}

function safeNormalizerDetail(reason: SteamOwnedSnapshotInvalid["reason"]): string {
  return `Steam owned-games body failed validation (${reason})`;
}

function invalid(reason: SteamOwnedFetchInvalidReason, detail: string): SteamOwnedFetchInvalid {
  return { status: "invalid", provider: "steam", reason, detail: detail.slice(0, 160) };
}

function unavailable(
  reason: SteamOwnedFetchUnavailableReason,
  detail?: string,
  metadata?: Pick<SteamOwnedFetchUnavailable, "httpStatus" | "retryAfterSeconds" | "retryDisposition">
): SteamOwnedFetchUnavailable {
  return {
    status: "unavailable",
    provider: "steam",
    reason,
    ...(detail ? { detail: detail.slice(0, 160) } : {}),
    ...(metadata?.httpStatus !== undefined ? { httpStatus: metadata.httpStatus } : {}),
    ...(metadata?.retryAfterSeconds !== undefined ? { retryAfterSeconds: metadata.retryAfterSeconds } : {}),
    ...(metadata?.retryDisposition !== undefined ? { retryDisposition: metadata.retryDisposition } : {})
  };
}
