import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STEAM_FETCH_TIMEOUT_MS,
  MAX_STEAM_RETRY_AFTER_SECONDS,
  fetchSteamOwnedSnapshot,
  STEAM_COMPLETE_OWNED_SCOPE,
  STEAM_ID64_MAX,
  STEAM_ID_SQL_BIGINT_MAX,
  STEAM_OWNED_GAMES_ENDPOINT,
  type FetchSteamOwnedSnapshotOptions,
  type SteamOwnedGamesFetch
} from "./steam-owned-fetch.ts";
import { DEFAULT_MAX_PAYLOAD_BYTES } from "./steam-owned-snapshot.ts";

const STEAM_ID = "76561197960265728";
const API_KEY = "test-steam-api-key";
const OBSERVATION_TIME = 1_800_000_000;

function ownedPayload(games: unknown[], gameCount = games.length) {
  return { response: { game_count: gameCount, games } };
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function options(fetch: SteamOwnedGamesFetch, overrides: Partial<FetchSteamOwnedSnapshotOptions> = {}): FetchSteamOwnedSnapshotOptions {
  return {
    fetch,
    nowEpochSeconds: () => OBSERVATION_TIME,
    timeoutMs: DEFAULT_STEAM_FETCH_TIMEOUT_MS,
    ...overrides
  };
}

test("requests the complete owned scope and returns trusted body provenance", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  let clockCalls = 0;
  const payload = ownedPayload([{ appid: 42, name: "A game", playtime_forever: 0 }]);
  const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse(payload);
  }, { nowEpochSeconds: () => { clockCalls += 1; return OBSERVATION_TIME; } }));

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  const url = new URL(requestUrl);
  assert.equal(url.origin + url.pathname, STEAM_OWNED_GAMES_ENDPOINT);
  assert.equal(url.searchParams.get("key"), API_KEY);
  assert.equal(url.searchParams.get("steamid"), STEAM_ID);
  assert.equal(url.searchParams.get("include_appinfo"), "1");
  assert.equal(url.searchParams.get("include_played_free_games"), "1");
  assert.equal(url.searchParams.get("skip_unvetted_apps"), "0");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.has("appids_filter"), false);
  assert.equal(url.searchParams.has("input_json"), false);
  assert.equal(requestInit?.cache, "no-store");
  assert.ok(requestInit?.signal instanceof AbortSignal);
  assert.equal(clockCalls, 1);
  assert.deepEqual(result.provenance, {
    ...STEAM_COMPLETE_OWNED_SCOPE,
    httpStatus: 200,
    bodyBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    observationTimeEpochSeconds: OBSERVATION_TIME
  });
});

test("accepts explicit zero, while private and provider-error responses stay unavailable", async () => {
  const empty = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => jsonResponse({
    response: { game_count: 0, games: [] }
  })));
  assert.equal(empty.status, "complete");
  if (empty.status === "complete") assert.equal(empty.games.length, 0);

  const privateResponse = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => jsonResponse({ response: {} })));
  assert.deepEqual(privateResponse, { status: "unavailable", provider: "steam", reason: "private" });

  const providerError = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => jsonResponse({
    success: false,
    response: {}
  })));
  assert.deepEqual(providerError, { status: "unavailable", provider: "steam", reason: "provider_error" });

  const contradictoryZero = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => jsonResponse({
    success: false,
    response: { game_count: 0, games: [] }
  })));
  assert.equal(contradictoryZero.status, "invalid");
  if (contradictoryZero.status === "invalid") assert.equal(contradictoryZero.reason, "malformed_response");
});

test("rejects invalid Steam IDs and credentials before invoking the injected fetch", async () => {
  let calls = 0;
  const fetch: SteamOwnedGamesFetch = async () => {
    calls += 1;
    return jsonResponse(ownedPayload([]));
  };

  for (const steamId of ["", "0", "01", "not-a-steam-id", `${STEAM_ID64_MAX}0`, `${STEAM_ID_SQL_BIGINT_MAX}1`]) {
    const result = await fetchSteamOwnedSnapshot(steamId, API_KEY, options(fetch));
    assert.equal(result.status, "invalid", steamId);
    if (result.status === "invalid") assert.equal(result.reason, "invalid_steam_id");
  }
  const blankKey = await fetchSteamOwnedSnapshot(STEAM_ID, "  ", options(fetch));
  assert.equal(blankKey.status, "invalid");
  if (blankKey.status === "invalid") assert.equal(blankKey.reason, "invalid_api_key");
  assert.equal(calls, 0);
});

test("maps non-2xx responses to one sanitized unavailable result without retrying", async () => {
  let calls = 0;
  const secretBody = `provider body includes ${API_KEY} and ${STEAM_OWNED_GAMES_ENDPOINT}`;
  const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => {
    calls += 1;
    return new Response(secretBody, {
      status: 503,
      headers: { "retry-after": "999999" }
    });
  }));

  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") {
    assert.equal(result.reason, "http_error");
    assert.equal(result.httpStatus, 503);
    assert.equal(result.retryAfterSeconds, 999999);
    assert.equal(result.retryDisposition, "retryable");
    assert.doesNotMatch(result.detail ?? "", new RegExp(API_KEY));
    assert.doesNotMatch(result.detail ?? "", /api\.steampowered\.com/);
    assert.doesNotMatch(result.detail ?? "", /provider body includes/);
  }
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes(secretBody), false);
  assert.equal(calls, 1);
});

test("parses HTTP-date Retry-After with the injected clock and never shortens it", async () => {
  const futureDate = new Date((OBSERVATION_TIME + 7_200) * 1_000).toUTCString();
  const future = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(null, {
    status: 429,
    headers: { "retry-after": futureDate }
  })));
  assert.equal(future.status, "unavailable");
  if (future.status === "unavailable") {
    assert.equal(future.retryAfterSeconds, 7_200);
    assert.equal(future.retryDisposition, "retryable");
  }

  const pastDate = new Date((OBSERVATION_TIME - 30) * 1_000).toUTCString();
  const past = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(null, {
    status: 503,
    headers: { "retry-after": pastDate }
  })));
  assert.equal(past.status, "unavailable");
  if (past.status === "unavailable") {
    assert.equal(past.retryAfterSeconds, 0);
    assert.equal(past.retryDisposition, "retryable");
  }
});

test("parses obsolete asctime Retry-After as GMT under a non-UTC host timezone", async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const observation = Date.parse("Sun, 06 Sep 2026 16:00:00 GMT") / 1_000;
    const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(null, {
      status: 503,
      headers: { "retry-after": "Sun Sep  6 17:00:00 2026" }
    }), { nowEpochSeconds: () => observation }));
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.equal(result.retryAfterSeconds, 3_600);
      assert.equal(result.retryDisposition, "retryable");
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("defers malformed and over-range Retry-After values without unsafe shortening", async () => {
  for (const retryAfter of ["not a retry date", "-1", "1.5"]) {
    const malformed = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(null, {
      status: 503,
      headers: { "retry-after": retryAfter }
    })));
    assert.equal(malformed.status, "unavailable", retryAfter);
    if (malformed.status === "unavailable") {
      assert.equal(malformed.retryAfterSeconds, undefined, retryAfter);
      assert.equal(malformed.retryDisposition, "deferred", retryAfter);
    }
  }

  const overRange = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(null, {
    status: 503,
    headers: { "retry-after": String(MAX_STEAM_RETRY_AFTER_SECONDS + 1) }
  })));
  assert.equal(overRange.status, "unavailable");
  if (overRange.status === "unavailable") {
    assert.equal(overRange.retryAfterSeconds, undefined);
    assert.equal(overRange.retryDisposition, "deferred");
  }

  const overflow = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(null, {
    status: 429,
    headers: { "retry-after": "999999999999999999999999999999999999" }
  })));
  assert.equal(overflow.status, "unavailable");
  if (overflow.status === "unavailable") {
    assert.equal(overflow.retryAfterSeconds, undefined);
    assert.equal(overflow.retryDisposition, "deferred");
  }
});

test("does not authorize a sweep from partial or queued 2xx responses", async () => {
  for (const status of [202, 204, 206]) {
    const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => status === 204
      ? new Response(null, { status })
      : jsonResponse(ownedPayload([]), status)));
    assert.equal(result.status, "unavailable", String(status));
    if (result.status === "unavailable") {
      assert.equal(result.reason, "http_error");
      assert.equal(result.httpStatus, status);
    }
  }
});

test("uses redirect error policy so credentials cannot follow a redirected request", async () => {
  let requestInit: RequestInit | undefined;
  const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async (_input, init) => {
    requestInit = init;
    return jsonResponse(ownedPayload([]));
  }));
  assert.equal(result.status, "complete");
  assert.equal(requestInit?.redirect, "error");
});

test("returns timeout and caller cancellation as unavailable without completing", async () => {
  const timeout = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async (_input, init) => {
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("upstream timeout")), { once: true });
    });
    throw new Error("unreachable");
  }, { timeoutMs: 5 }));
  assert.equal(timeout.status, "unavailable");
  if (timeout.status === "unavailable") assert.equal(timeout.reason, "timeout");

  const controller = new AbortController();
  let cancellationCalls = 0;
  const pending = fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async (_input, init) => {
    cancellationCalls += 1;
    await new Promise<never>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    throw new Error("unreachable");
  }, { signal: controller.signal }));
  await Promise.resolve();
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, "unavailable");
  if (cancelled.status === "unavailable") assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancellationCalls, 1);
});

test("keeps the timeout bounded when injected fetch or stream ignores abort", async () => {
  const ignoredFetch = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Promise<Response>(() => {
    // Deliberately never observes the request signal.
  }), { timeoutMs: 5 }));
  assert.equal(ignoredFetch.status, "unavailable");
  if (ignoredFetch.status === "unavailable") assert.equal(ignoredFetch.reason, "timeout");

  const ignoredStream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {
        // Deliberately never settles or observes cancellation.
      });
    }
  });
  const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(ignoredStream), {
    timeoutMs: 5
  }));
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "timeout");
});

test("bounds a streamed body before parsing and rejects a truncated stream", async () => {
  let streamCancelled = false;
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      const oversized = new Uint8Array(65);
      oversized.fill(0x20);
      controller.enqueue(oversized);
    },
    cancel() {
      streamCancelled = true;
    }
  });
  const tooLarge = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(oversizedStream), {
    maxPayloadBytes: 64
  }));
  assert.equal(tooLarge.status, "invalid");
  if (tooLarge.status === "invalid") assert.equal(tooLarge.reason, "payload_too_large");
  assert.equal(streamCancelled, true);

  const encoder = new TextEncoder();
  const truncated = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":{"game_count":1'));
        controller.close();
      }
    })
  )));
  assert.equal(truncated.status, "invalid");
  if (truncated.status === "invalid") assert.equal(truncated.reason, "invalid_json");
});

test("rejects malformed UTF-8 and stream read failures as typed invalid results", async () => {
  const malformedUtf8 = new Uint8Array([0x7b, 0x22, 0x72, 0x65, 0x73, 0x70, 0x6f, 0x6e, 0x73, 0x65, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
  const malformed = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(malformedUtf8)));
  assert.equal(malformed.status, "invalid");
  if (malformed.status === "invalid") assert.equal(malformed.reason, "invalid_json");

  const streamFailure = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"response":'));
        controller.error(new Error("secret upstream body failure"));
      }
    })
  )));
  assert.equal(streamFailure.status, "invalid");
  if (streamFailure.status === "invalid") {
    assert.equal(streamFailure.reason, "truncated_body");
    assert.doesNotMatch(streamFailure.detail, /secret upstream/);
  }
});

test("does not publish provider validation failures or leak body text", async () => {
  const body = ownedPayload([{ appid: 1, name: "secret-provider-title\u0000" }]);
  const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => jsonResponse(body)));
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.equal(result.reason, "malformed_response");
    assert.doesNotMatch(result.detail, /secret-provider-title/);
  }
  assert.equal(JSON.stringify(result).includes("secret-provider-title"), false);
});

test("uses the received body time as the normalizer anchor and keeps the full byte cap", async () => {
  let nowCalls = 0;
  const result = await fetchSteamOwnedSnapshot(STEAM_ID, API_KEY, options(async () => jsonResponse(ownedPayload([
    { appid: 1, rtime_last_played: OBSERVATION_TIME + 301 }
  ])), {
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    nowEpochSeconds: () => {
      nowCalls += 1;
      return OBSERVATION_TIME;
    }
  }));
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "invalid_last_played");
  assert.equal(nowCalls, 1);
});
