import assert from "node:assert/strict";
import test from "node:test";
import { createWishlistDetailsClient, type WishlistDetails } from "./wishlist-details-client.ts";

test("card and budget requests share in-flight details and respect region and server expiry", async () => {
  let time = 1000;
  const calls: { ids: number[]; country: string; resolve: (games: WishlistDetails[]) => void }[] = [];
  const client = createWishlistDetailsClient((ids, country) => new Promise(resolve => calls.push({ ids, country, resolve })), () => time);
  const cards = client.load([1, 2], "GB");
  const budget = client.load([2, 3], "GB");
  assert.deepEqual(calls.map(call => call.ids), [[1, 2], [3]]);
  calls.forEach(call => call.resolve(call.ids.map(appId => ({ appId, description: "Fresh details", detailsExpiresAt: new Date(5000).toISOString() }))));
  await Promise.all([cards, budget]);
  assert.equal((await client.load([1, 2, 3], "GB")).length, 3);
  assert.equal(calls.length, 2);
  assert.equal(client.peek(1, "US"), undefined);
  time = 5001;
  assert.equal(client.peek(1, "GB"), undefined);
  const expired = client.load([1], "GB");
  assert.equal(calls.length, 3);
  calls[2].resolve([{ appId: 1, description: "Refreshed" }]);
  await expired;
  assert.equal(client.peek(1, "GB")?.description, "Refreshed");
});

test("failed details drop prices and back off before retrying", async () => {
  let time = 1000;
  let fail = false;
  const client = createWishlistDetailsClient(async ids => {
    if (fail) throw new Error("Steam unavailable");
    return ids.map(appId => ({ appId, description: "Keep this description", detailsExpiresAt: new Date(5000).toISOString(), price: { country: "GB", current: "£8.99", discount: 0 } }));
  }, () => time);
  await client.load([1], "GB");
  time = 5001;
  fail = true;
  await assert.rejects(client.load([1], "GB"));
  assert.equal(client.peek(1, "GB")?.price, undefined);
  assert.equal(client.peek(1, "GB")?.description, "Keep this description");
  assert.equal((await client.load([1], "GB"))[0].storeStatus, "unavailable");
});
