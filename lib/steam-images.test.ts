import assert from "node:assert/strict";
import test from "node:test";
import { steamLaunchUrl, steamStoreUrl } from "./steam-images.ts";

test("builds a Steam client launch URL for an app ID", () => {
  assert.equal(steamLaunchUrl(234630), "steam://run/234630");
});

test("keeps the store URL separate from the client launch URL", () => {
  assert.equal(steamStoreUrl(234630), "https://store.steampowered.com/app/234630/");
  assert.notEqual(steamLaunchUrl(234630), steamStoreUrl(234630));
});
