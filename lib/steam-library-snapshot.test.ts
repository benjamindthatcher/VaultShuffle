import assert from "node:assert/strict";
import test from "node:test";
import { saveLibrarySnapshot, readLibrarySnapshot, deleteLibrarySnapshot, SNAPSHOT_TTL_SECONDS, type SnapshotCache } from "./steam-library-snapshot.ts";
import { steamOwnedGamesFromPayload } from "./steam-owned-games.ts";

function fixture() {
  const values = new Map<string, unknown>();
  const cache: SnapshotCache = { get: async (key) => values.get(key), set: async (key, value, options) => { assert.equal(options.ttl, SNAPSHOT_TTL_SECONDS); values.set(key, value); }, delete: async (key) => { values.delete(key); } };
  const games = steamOwnedGamesFromPayload({ response: { games: Array.from({ length: 1250 }, (_, i) => ({ appid: i + 1, name: `Game ${i}`, playtime_forever: 60 })) } });
  return { values, cache, games };
}
test("setup library survives a separate request, chunked with a fifteen-minute TTL", async () => {
  const { cache, games, values } = fixture();
  const id = await saveLibrarySnapshot(cache, "76561198000000000", games, 1000);
  assert.equal(values.size, 4);
  assert.deepEqual(await readLibrarySnapshot({ ...cache }, id, "76561198000000000", 2000), games);
  await deleteLibrarySnapshot(cache, id, games.length); assert.equal(values.size, 0);
});
test("snapshot cannot cross identities, outlive the token, or return a partial library", async () => {
  const { cache, games, values } = fixture();
  const id = await saveLibrarySnapshot(cache, "76561198000000000", games, 1000);
  assert.equal(await readLibrarySnapshot(cache, id, "76561198000000001", 2000), null);
  assert.equal(await readLibrarySnapshot(cache, id, "76561198000000000", 1000 + SNAPSHOT_TTL_SECONDS * 1000), null);
  assert.equal(await readLibrarySnapshot(cache, "invalid-cache-key", "76561198000000000", 2000), null);
  values.delete(`steam-setup-v1:${id}:1`);
  assert.equal(await readLibrarySnapshot(cache, id, "76561198000000000", 2000), null);
});
test("incomplete writes never publish a usable manifest", async () => {
  const { cache, games, values } = fixture();
  await assert.rejects(saveLibrarySnapshot({ ...cache, set: async (key, value, options) => {
    if (key.endsWith(":1")) throw new Error("cache unavailable");
    return cache.set(key, value, options);
  } }, "76561198000000000", games));
  assert.ok([...values.keys()].every((key) => /:[0-9]+$/.test(key)));
});
