import assert from "node:assert/strict";
import test from "node:test";
import { createWishlistStoreLoader, STORE_RETRY_MS, type StoreCacheEntry, type WishlistStoreCache } from "./wishlist-store-cache.ts";
import type { WishlistGame } from "./wishlist.ts";

function fixture() {
  let time = Date.parse("2026-09-23T00:00:00Z");
  const rows = new Map<string, StoreCacheEntry & { token?: string }>();
  let calls = 0;
  let fail = false;
  let discount = 0;
  const epoch = new Date(0).toISOString();
  const store: WishlistStoreCache = {
    async claim(id, country, token) {
      const key = `${country}:${id}`;
      const row = rows.get(key) ?? { game: null, checked_at: null, expires_at: epoch, retry_after: epoch, lease_until: epoch };
      const claimed = Date.parse(row.expires_at) <= time && Date.parse(row.retry_after) <= time && Date.parse(row.lease_until) <= time;
      if (claimed) { row.token = token; row.lease_until = new Date(time + 30_000).toISOString(); }
      rows.set(key, row);
      return { ...row, claimed };
    },
    async read(id, country) { return { ...rows.get(`${country}:${id}`)! }; },
    async finish(id, country, token, game, checkedAt, expiresAt) {
      const row = rows.get(`${country}:${id}`)!;
      if (row.token === token) Object.assign(row, { game, checked_at: checkedAt, expires_at: expiresAt, retry_after: epoch, lease_until: epoch });
    },
    async fail(id, country, token, retryAfter) {
      const row = rows.get(`${country}:${id}`)!;
      if (row.token === token) Object.assign(row, { retry_after: retryAfter, lease_until: epoch });
    },
  };
  const fetchGame = async (id: number, country: string): Promise<WishlistGame> => {
    calls++;
    if (fail) throw new Error("Steam unavailable");
    return { appId: id, title: "A game", image: "", genres: [], description: "Description", price: { current: "£8.50", discount, country, amountMinor: 850, currency: "GBP" }, storeStatus: "available" };
  };
  return { store, rows, fetchGame, now: () => time, advance: (ms: number) => { time += ms; }, calls: () => calls, fail: () => { fail = true; }, discount: () => { discount = 50; } };
}

test("fresh prices are shared across loaders; regions and IDs remain separate", async () => {
  const f = fixture();
  const a = createWishlistStoreLoader(f.store, f.fetchGame, f.now);
  const b = createWishlistStoreLoader(f.store, f.fetchGame, f.now);
  const first = await a(620, "GB");
  assert.equal((await b(620, "GB")).detailsCheckedAt, first.detailsCheckedAt);
  assert.equal(f.calls(), 1);
  assert.equal((await b(620, "US")).price?.country, "US");
  await a(400, "GB");
  assert.equal(f.calls(), 3);
});

test("normal prices expire after six hours; discounts after thirty minutes", async () => {
  const f = fixture();
  const load = createWishlistStoreLoader(f.store, f.fetchGame, f.now);
  await load(620, "GB");
  f.advance(6 * 60 * 60_000 - 1);
  await load(620, "GB");
  assert.equal(f.calls(), 1);
  f.advance(1);
  f.discount();
  const sale = await load(620, "GB");
  assert.equal(f.calls(), 2);
  assert.equal(Date.parse(sale.detailsExpiresAt!) - f.now(), 30 * 60_000);
  f.advance(30 * 60_000);
  await load(620, "GB");
  assert.equal(f.calls(), 3);
});

test("concurrent requests share one upstream refresh locally and across instances", async () => {
  const f = fixture();
  const wait = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
  const a = createWishlistStoreLoader(f.store, f.fetchGame, f.now, wait);
  const b = createWishlistStoreLoader(f.store, f.fetchGame, f.now, wait);
  const games = await Promise.all([a(620, "GB"), a(620, "GB"), b(620, "GB")]);
  assert.equal(f.calls(), 1);
  assert.ok(games.every((game) => game.price?.amountMinor === 850));
});

test("failed refresh hides expired deals, preserves metadata, and backs off", async () => {
  const f = fixture();
  f.discount();
  const load = createWishlistStoreLoader(f.store, f.fetchGame, f.now);
  await load(620, "GB");
  f.advance(30 * 60_000);
  f.fail();
  const stale = await load(620, "GB");
  assert.equal(stale.price, undefined);
  assert.equal(stale.description, "Description");
  assert.equal(stale.storeStatus, "unavailable");
  await load(620, "GB");
  assert.equal(f.calls(), 2);
  f.advance(STORE_RETRY_MS);
  await load(620, "GB");
  assert.equal(f.calls(), 3);
});

test("cold failures back off too; crashed leases become refreshable", async () => {
  const f = fixture();
  f.fail();
  const load = createWishlistStoreLoader(f.store, f.fetchGame, f.now, async () => {});
  await assert.rejects(load(620, "GB"));
  await assert.rejects(load(620, "GB"));
  assert.equal(f.calls(), 1);
  await f.store.claim(400, "GB", "crashed-instance");
  await assert.rejects(load(400, "GB"));
  assert.equal(f.calls(), 1);
  f.advance(30_000);
  await assert.rejects(load(400, "GB"));
  assert.equal(f.calls(), 2);
});
