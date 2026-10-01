import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_GAMES,
  DEFAULT_MAX_FUTURE_SKEW_SECONDS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  MAX_FUTURE_SKEW_SECONDS,
  MAX_GAME_NAME_LENGTH,
  MAX_PLAYTIME_MINUTES,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_TIMESTAMPTZ_EPOCH_SECONDS,
  normalizeSteamOwnedSnapshot,
  STEAM_APP_ID_MAX
} from "./steam-owned-snapshot.ts";

function response(games: unknown[], gameCount = games.length) {
  return { response: { game_count: gameCount, games } };
}

const OBSERVATION_TIME = 1_800_000_000;
const observation = { observationTimeEpochSeconds: OBSERVATION_TIME };

function normalize(input: unknown) {
  return normalizeSteamOwnedSnapshot(input, observation);
}

test("normalizes an authoritative snapshot and preserves zero, null, names, and timestamp provenance", () => {
  const result = normalize(response([
    { appid: 2_147_483_648, name: "Beyond signed int32", playtime_forever: 0, rtime_last_played: 0 },
    { appid: 4_294_967_295, playtime_forever: null, rtime_last_played: 1_700_000_000 },
    { appid: 42, name: "  Named game  ", rtime_last_played: null }
  ]));

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.games.map((game) => game.appId), ["42", "2147483648", "4294967295"]);
  assert.equal(result.games[0]?.name, "Named game");
  assert.equal(result.games[0]?.nameSource, "steam.name");
  assert.equal(result.games[0]?.playtimeMinutes, null);
  assert.equal(result.games[0]?.lastPlayedSource, "steam.rtime_last_played_unknown");
  assert.equal(result.games[1]?.playtimeMinutes, 0);
  assert.equal(result.games[1]?.lastPlayedAtEpochSeconds, null);
  assert.equal(result.games[2]?.name, "Steam App 4294967295");
  assert.equal(result.games[2]?.nameSource, "catalog_stub");
  assert.equal(result.games[2]?.lastPlayedSource, "steam.rtime_last_played");
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  const reordered = normalize(response([
    { appid: 42, name: "  Named game  ", rtime_last_played: null },
    { appid: 4_294_967_295, playtime_forever: null, rtime_last_played: 1_700_000_000 },
    { appid: 2_147_483_648, name: "Beyond signed int32", playtime_forever: 0, rtime_last_played: 0 }
  ]));
  assert.equal(reordered.status, "complete");
  if (reordered.status === "complete") assert.equal(result.contentHash, reordered.contentHash);
});

test("distinguishes explicit empty from a private response", () => {
  const empty = normalize({ response: { game_count: 0, games: [] } });
  assert.equal(empty.status, "complete");
  if (empty.status === "complete") assert.deepEqual(empty.games, []);

  const omittedGames = normalize({ response: { game_count: 0 } });
  assert.equal(omittedGames.status, "complete");

  const privateResponse = normalize({ response: {} });
  assert.deepEqual(privateResponse, { status: "unavailable", provider: "steam", reason: "private" });
});

test("rejects count mismatch, duplicate IDs, and malformed records as a whole", () => {
  assert.equal(normalize(response([{ appid: 1 }], 2)).status, "invalid");
  assert.equal(normalize(response([{ appid: 1 }, { appid: "1" }])).status, "invalid");
  assert.equal(normalize(response([{ appid: 1 }, null])).status, "invalid");
  assert.equal(normalize({ response: { game_count: 1, games: null } }).status, "invalid");
  assert.equal(normalize({ response: { game_count: 1 } }).status, "invalid");
});

test("enforces the unsigned AppID range without signed truncation", () => {
  assert.equal(normalize(response([{ appid: STEAM_APP_ID_MAX }])).status, "complete");
  for (const appid of [0, -1, 4_294_967_296, 2.5, "01", "4294967296", true]) {
    const result = normalize(response([{ appid }]));
    assert.equal(result.status, "invalid", `appid ${String(appid)} should be rejected`);
    if (result.status === "invalid") assert.equal(result.reason, "invalid_app_id");
  }
});

test("requires finite exact nonnegative minutes and keeps omitted minutes unknown", () => {
  const valid = normalize(response([
    { appid: 1 },
    { appid: 2, playtime_forever: 0 },
    { appid: 3, playtime_forever: null },
    { appid: 4, playtime_forever: MAX_PLAYTIME_MINUTES }
  ]));
  assert.equal(valid.status, "complete");
  if (valid.status === "complete") assert.deepEqual(valid.games.map((game) => game.playtimeMinutes), [null, 0, null, MAX_PLAYTIME_MINUTES]);

  for (const playtime_forever of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", true, MAX_PLAYTIME_MINUTES + 1, Number.MAX_SAFE_INTEGER]) {
    const result = normalize(response([{ appid: 1, playtime_forever }]));
    assert.equal(result.status, "invalid", `minutes ${String(playtime_forever)} should be rejected`);
    if (result.status === "invalid") assert.equal(result.reason, "invalid_playtime_minutes");
  }
});

test("rejects malformed timestamps and names while retaining timestamp provenance", () => {
  for (const rtime_last_played of [-1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, "1700000000", true, MAX_TIMESTAMPTZ_EPOCH_SECONDS + 1, Number.MAX_SAFE_INTEGER]) {
    const result = normalize(response([{ appid: 1, rtime_last_played }]));
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") assert.equal(result.reason, "invalid_last_played");
  }
  for (const name of [42, true, {}, []]) {
    const result = normalize(response([{ appid: 1, name }]));
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") assert.equal(result.reason, "invalid_name");
  }
});

test("requires an explicit observation anchor and rejects future timestamps without using the wall clock", () => {
  const timestamp = OBSERVATION_TIME + DEFAULT_MAX_FUTURE_SKEW_SECONDS;
  const valid = normalize(response([{ appid: 1, rtime_last_played: timestamp }]));
  assert.equal(valid.status, "complete");

  const tooFuture = normalize(response([{ appid: 1, rtime_last_played: timestamp + 1 }]));
  assert.equal(tooFuture.status, "invalid");
  if (tooFuture.status === "invalid") assert.equal(tooFuture.reason, "invalid_last_played");

  const missingAnchor = normalizeSteamOwnedSnapshot(response([{ appid: 1, rtime_last_played: 1_700_000_000 }]));
  assert.equal(missingAnchor.status, "invalid");
  if (missingAnchor.status === "invalid") assert.equal(missingAnchor.reason, "invalid_last_played");

  const olderObservation = normalizeSteamOwnedSnapshot(response([{ appid: 1, rtime_last_played: 1_700_000_000 }]), {
    observationTimeEpochSeconds: 1_750_000_000
  });
  const newerObservation = normalizeSteamOwnedSnapshot(response([{ appid: 1, rtime_last_played: 1_700_000_000 }]), {
    observationTimeEpochSeconds: 1_850_000_000
  });
  assert.equal(olderObservation.status, "complete");
  assert.equal(newerObservation.status, "complete");
  if (olderObservation.status === "complete" && newerObservation.status === "complete") {
    assert.equal(olderObservation.contentHash, newerObservation.contentHash);
    assert.equal(olderObservation.canonicalJson, newerObservation.canonicalJson);
  }

  const customSkew = normalizeSteamOwnedSnapshot(response([{ appid: 1, rtime_last_played: OBSERVATION_TIME + 601 }]), {
    observationTimeEpochSeconds: OBSERVATION_TIME,
    maxFutureSkewSeconds: 601
  });
  assert.equal(customSkew.status, "complete");
  assert.equal(normalizeSteamOwnedSnapshot(response([{ appid: 1 }]), {
    observationTimeEpochSeconds: OBSERVATION_TIME,
    maxFutureSkewSeconds: MAX_FUTURE_SKEW_SECONDS + 1
  }).status, "invalid");
});

test("rejects contradictory success and error markers before interpreting zero as an empty library", () => {
  const providerError = normalize({ response: { success: false, error: { code: "private" } } });
  assert.deepEqual(providerError, { status: "unavailable", provider: "steam", reason: "provider_error" });

  for (const payload of [
    { success: false, error: { code: "private" }, game_count: 0, games: [] },
    { success: false, error: { code: "private" }, game_count: 0 },
    { success: false, game_count: 0, games: [] },
    { success: true, error: { code: "provider_failure" }, game_count: 0, games: [] },
    { success: true, error: { code: "provider_failure" } }
  ]) {
    const result = normalize({ response: payload });
    assert.equal(result.status, "invalid", JSON.stringify(payload));
    if (result.status === "invalid") assert.equal(result.reason, "malformed_response");
  }

  for (const payload of [
    { success: false, response: { game_count: 0, games: [] } },
    { success: false, error: { code: "private" }, response: { game_count: 0, games: [] } },
    { success: true, error: { code: "provider_failure" }, response: { game_count: 0, games: [] } }
  ]) {
    const result = normalize(payload);
    assert.equal(result.status, "invalid", JSON.stringify(payload));
    if (result.status === "invalid") assert.equal(result.reason, "malformed_response");
  }

  assert.deepEqual(normalize({ success: false, response: {} }), {
    status: "unavailable",
    provider: "steam",
    reason: "provider_error"
  });
  assert.equal(normalize({ success: true, response: {} }).status, "invalid");

  assert.equal(normalize({ response: { success: "false", game_count: 0, games: [] } }).status, "invalid");
  assert.equal(normalize({ response: { error: "provider failure" } }).status, "unavailable");
  assert.equal(normalize({ response: { success: true, error: null, game_count: 0, games: [] } }).status, "complete");
});

test("bounds provider names and keeps valid empty names as catalogue stubs", () => {
  const result = normalize(response([
    { appid: 1, name: "   " },
    { appid: 2, name: null },
    { appid: 3 }
  ]));
  assert.equal(result.status, "complete");
  if (result.status === "complete") {
    assert.deepEqual(result.games.map((game) => [game.name, game.nameSource]), [
      ["Steam App 1", "catalog_stub"],
      ["Steam App 2", "catalog_stub"],
      ["Steam App 3", "catalog_stub"]
    ]);
  }
  const tooLong = normalize(response([{ appid: 1, name: "x".repeat(MAX_GAME_NAME_LENGTH + 1) }]));
  assert.equal(tooLong.status, "invalid");
  if (tooLong.status === "invalid") assert.equal(tooLong.reason, "invalid_name");

  const malformedUnicode = normalize(response([{ appid: 1, name: "\ud800" }]));
  assert.equal(malformedUnicode.status, "invalid");
  if (malformedUnicode.status === "invalid") assert.equal(malformedUnicode.reason, "malformed_response");

  for (const name of ["bad\u0000name", "bad\u0001name"]) {
    const invalid = normalize(response([{ appid: 1, name }]));
    assert.equal(invalid.status, "invalid", JSON.stringify(name));
    if (invalid.status === "invalid") assert.equal(invalid.reason, "malformed_response");
  }

  assert.equal(normalize(response([{ appid: 4, name: "🎮".repeat(MAX_GAME_NAME_LENGTH) }])).status, "complete");
  assert.equal(normalize(response([{ appid: 5, name: "🎮".repeat(MAX_GAME_NAME_LENGTH + 1) }])).status, "invalid");
});

test("accepts the 1,000 and 10,000 game stress fixtures, then rejects the cap", () => {
  for (const count of [1_001, DEFAULT_MAX_GAMES]) {
    const result = normalize(response(
      Array.from({ length: count }, (_, index) => ({ appid: index + 1, playtime_forever: index === 0 ? 0 : undefined }))
    ));
    assert.equal(result.status, "complete");
    if (result.status === "complete") {
      assert.equal(result.gameCount, count);
      assert.equal(result.games.length, count);
    }
  }
  const tooMany = normalize(response(
    Array.from({ length: DEFAULT_MAX_GAMES + 1 }, (_, index) => ({ appid: index + 1 }))
  ));
  assert.equal(tooMany.status, "invalid");
  if (tooMany.status === "invalid") assert.equal(tooMany.reason, "too_many_games");
});

test("enforces the payload byte cap before publication", () => {
  const result = normalizeSteamOwnedSnapshot(response([{ appid: 1, name: "a long enough name" }]), { ...observation, maxPayloadBytes: 32 });
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "payload_too_large");

  const raw = JSON.stringify(response([{ appid: 1 }]));
  const parsed = normalizeSteamOwnedSnapshot(raw, { ...observation, maxPayloadBytes: 256 });
  assert.equal(parsed.status, "complete");
  assert.equal(normalizeSteamOwnedSnapshot("{not json", { ...observation, maxPayloadBytes: 100 }).status, "invalid");
  assert.equal(normalizeSteamOwnedSnapshot(response([{ appid: 1 }]), { ...observation, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES + 1 }).status, "invalid");
});

test("rejects malformed UTF-8 instead of replacement-decoding it", () => {
  const valid = new TextEncoder().encode(JSON.stringify(response([{ appid: 1 }])));
  const malformed = new Uint8Array([...valid, 0xc3, 0x28]);
  const result = normalizeSteamOwnedSnapshot(malformed, observation);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "invalid_json");
});

test("rejects escaped NUL in any provider JSON field before a JSONB publish", () => {
  const raw = JSON.stringify({ response: { game_count: 0, games: [], provider_note: "bad\u0000value" } });
  const result = normalizeSteamOwnedSnapshot(raw, observation);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "malformed_response");
});

test("bounds deeply nested JSON iteratively and never throws", () => {
  const depth = MAX_JSON_DEPTH + 10_000;
  const nested = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
  const raw = `{"response":{"game_count":0,"games":[],"metadata":${nested}}}`;
  let result: ReturnType<typeof normalizeSteamOwnedSnapshot> | undefined;
  assert.doesNotThrow(() => {
    result = normalizeSteamOwnedSnapshot(raw, observation);
  });
  assert.equal(result?.status, "invalid");
  if (result?.status === "invalid") assert.equal(result.reason, "malformed_response");
});

test("rejects malformed Unicode in object keys and irrelevant values", () => {
  for (const raw of [
    JSON.stringify({ response: { game_count: 0, games: [], ["\u0000"]: 1 } }),
    JSON.stringify({ response: { game_count: 0, games: [], ["\ud800"]: 1 } }),
    JSON.stringify({ response: { game_count: 0, games: [], metadata: "\ud800" } })
  ]) {
    const result = normalizeSteamOwnedSnapshot(raw, observation);
    assert.equal(result.status, "invalid", raw);
    if (result.status === "invalid") assert.equal(result.reason, "malformed_response");
  }
});

test("keeps the compatibility node budget below the raw body byte budget", () => {
  const metadata = Object.fromEntries(Array.from({ length: MAX_JSON_NODES }, (_, index) => [`k${index}`, 1]));
  const raw = JSON.stringify({ response: { game_count: 0, games: [], metadata } });
  assert.ok(new TextEncoder().encode(raw).byteLength < 8 * 1024 * 1024);
  const result = normalizeSteamOwnedSnapshot(raw, observation);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "malformed_response");
});

test("rejects direct bigint input at the JSON boundary", () => {
  const result = normalizeSteamOwnedSnapshot({ response: { game_count: 1, games: [{ appid: BigInt(1) }] } }, observation);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "malformed_response");
});
