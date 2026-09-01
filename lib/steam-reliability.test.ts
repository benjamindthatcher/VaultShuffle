import assert from "node:assert/strict";
import test from "node:test";
import { fetchSteamResponse, readSteamJson, SteamApiError, steamRetryAfter } from "./steam-api-error.ts";
import { steamOwnedGamesFromPayload, SteamLibraryUnavailableError } from "./steam-owned-games.ts";
import { CooldownError, readCooldown } from "./cooldown.ts";
import { RequestFailure, withTransientRetry } from "./request-failure.ts";
import { readStoredCooldown, saveCooldown, storedCooldownError } from "./cooldown-storage.ts";

test("Steam 429 keeps Retry-After and contains no API URL or key", async () => {
  await assert.rejects(fetchSteamResponse("owned_games", "https://example.test/?key=secret", {}, async () => new Response("private upstream body", { status: 429, headers: { "Retry-After": "90" } })), (error: unknown) => {
    assert.ok(error instanceof SteamApiError);
    assert.equal(error.code, "steam_rate_limited"); assert.equal(error.retryAfterSeconds, 90); assert.equal(error.upstreamStatus, 429);
    assert.ok(!JSON.stringify(error).includes("secret")); return true;
  });
});
test("Retry-After accepts seconds/date and bounds missing or unreasonable values", () => {
  assert.equal(steamRetryAfter(null), 60); assert.equal(steamRetryAfter("nonsense"), 60);
  assert.equal(steamRetryAfter("999999999"), 3600); assert.equal(steamRetryAfter("90"), 90);
  assert.equal(steamRetryAfter("Mon, 31 Aug 2026 01:02:00 GMT", Date.parse("2026-08-31T01:00:00Z")), 120);
});
test("Steam timeout, network failure and malformed JSON remain distinct", async () => {
  await assert.rejects(fetchSteamResponse("resolve_vanity", "https://example.test", {}, async () => { throw new DOMException("timeout with private data", "TimeoutError"); }), { code: "steam_timeout" });
  await assert.rejects(fetchSteamResponse("player_summary", "https://example.test", {}, async () => { throw new TypeError("network secret"); }), { code: "steam_network_error" });
  await assert.rejects(readSteamJson(new Response("<html>error</html>"), "owned_games"), { code: "steam_invalid_response" });
});
test("unknown visibility, explicit empty library and malformed Steam payloads are not labelled private", () => {
  assert.throws(() => steamOwnedGamesFromPayload({ response: {} }), { code: "library_unavailable" });
  assert.throws(() => steamOwnedGamesFromPayload({ response: { game_count: 0, games: [] } }), { code: "library_empty" });
  assert.throws(() => steamOwnedGamesFromPayload({ broken: true }), { code: "steam_invalid_response" });
  assert.throws(() => steamOwnedGamesFromPayload({ response: { game_count: 3 } }), { code: "steam_invalid_response" });
  assert.equal(new SteamLibraryUnavailableError("library_private").code, "library_private");
});
test("the incident regression: six Steam 429 attempts make six upstream calls, never eighteen", async () => {
  let calls = 0; let waits = 0;
  for (let i = 0; i < 6; i++) {
    await assert.rejects(withTransientRetry(async () => { calls++; throw new CooldownError(90, "Steam needs a moment.", "steam_rate_limited"); }, 3, async () => { waits++; }), { code: "steam_rate_limited" });
  }
  assert.equal(calls, 6); assert.equal(waits, 0);
  const notice = readCooldown(new Response(null, { status: 429 }), { code: "steam_rate_limited", retry_after_seconds: 90 });
  assert.equal(notice?.retryAfterSeconds, 90);
});
test("definite auth/validation/privacy failures never retry; temporary gateway errors can recover", async () => {
  for (const error of [new RequestFailure("unauthorized", 401), new RequestFailure("bad input", 400), new SteamLibraryUnavailableError()]) {
    let calls = 0;
    await assert.rejects(withTransientRetry(async () => { calls++; throw error; }, 3, async () => undefined));
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.equal(await withTransientRetry(async () => { if (++calls < 3) throw new RequestFailure("upstream", 502); return "ok"; }, 3, async () => undefined), "ok");
  assert.equal(calls, 3);
});
test("cooldown survives refresh, expires, is scoped and tolerates blocked storage", () => {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  saveCooldown("account-a", new CooldownError(90, "wait", "steam_rate_limited"), storage, 1000);
  const saved = readStoredCooldown("account-a", storage, 2000)!;
  assert.equal(saved.until, 91000); assert.equal(storedCooldownError(saved, 2000).retryAfterSeconds, 89);
  assert.equal(readStoredCooldown("account-b", storage, 2000), null);
  assert.equal(readStoredCooldown("account-a", storage, 91001), null);
  assert.equal(readStoredCooldown("account-a", { ...storage, getItem: () => { throw new Error("blocked"); } }), null);
});
