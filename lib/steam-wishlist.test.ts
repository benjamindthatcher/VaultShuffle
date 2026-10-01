import assert from "node:assert/strict";
import test from "node:test";
import { fetchSteamWishlistIds, SteamWishlistError } from "./steam-wishlist.ts";

const steamId = "76561197960434622";
function response(body: unknown, result?: string, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: result ? { "x-eresult": result } : {} });
}

test("Steam public import uses full SteamID, no stale cache or credentials, and deduplicates", async () => {
  const ids = await fetchSteamWishlistIds(steamId, async (url, options) => {
    assert.equal(String(url), `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`);
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal);
    assert.equal(options?.headers, undefined);
    return response({ response: { items: [{ appid: 620 }, { appid: 620 }, { appid: 400 }] } }, "1");
  });
  assert.deepEqual(ids, [620, 400]);
});

test("empty protobuf list requires explicit success; inaccessible lists never count as empty", async () => {
  assert.deepEqual(await fetchSteamWishlistIds(steamId, async () => response({ response: {} }, "1")), []);
  assert.deepEqual(await fetchSteamWishlistIds(steamId, async () => response({ response: { items: [] } }, "1")), []);
  for (const reply of [response({ response: {} }), response({ response: {} }, "15"), response({ response: { items: [] } }, "15"), response({}, undefined, 403)]) {
    await assert.rejects(fetchSteamWishlistIds(steamId, async () => reply), (error: unknown) => error instanceof SteamWishlistError && error.status === 422);
  }
});

test("rate limits are not retried, transient failures retry once, and malformed success fails safely", async () => {
  let calls = 0;
  await assert.rejects(fetchSteamWishlistIds(steamId, async () => { calls++; return response({}, undefined, 429); }), (error: unknown) => error instanceof SteamWishlistError && error.status === 429);
  assert.equal(calls, 1);
  calls = 0;
  assert.deepEqual(await fetchSteamWishlistIds(steamId, async () => ++calls === 1 ? response({}, undefined, 503) : response({ response: { items: [{ appid: 620 }] } }, "1")), [620]);
  assert.equal(calls, 2);
  await assert.rejects(fetchSteamWishlistIds(steamId, async () => new Response("<html>Steam error</html>")), /unreadable/);
  await assert.rejects(fetchSteamWishlistIds(steamId, async () => response({ response: { items: [{ appid: -1 }] } }, "1")), /incomplete/);
  await assert.rejects(fetchSteamWishlistIds("a vanity name", async () => { throw new Error("must not fetch"); }), /Reconnect/);
});
