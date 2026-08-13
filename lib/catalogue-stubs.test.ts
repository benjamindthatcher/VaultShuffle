import assert from "node:assert/strict";
import test from "node:test";
import { catalogueGameStubRows } from "./catalogue-stubs.ts";

test("builds immediately usable catalogue identities for newly imported Steam games", () => {
  const rows = catalogueGameStubRows([
    { steam_appid: "461040", title: "PICO PARK:Classic Edition" },
    { steam_appid: "3321460", title: "Crimson Desert" }
  ], "2026-08-13T14:00:00.000Z");

  assert.deepEqual(rows, [
    {
      steam_appid: 461040,
      name: "PICO PARK:Classic Edition",
      normalized_name: "pico park classic edition",
      first_seen_reason: "user_import",
      metadata_fetched_at: "1970-01-01T00:00:00.000Z",
      updated_at: "2026-08-13T14:00:00.000Z"
    },
    {
      steam_appid: 3321460,
      name: "Crimson Desert",
      normalized_name: "crimson desert",
      first_seen_reason: "user_import",
      metadata_fetched_at: "1970-01-01T00:00:00.000Z",
      updated_at: "2026-08-13T14:00:00.000Z"
    }
  ]);
});

test("ignores malformed identities and deduplicates AppIDs", () => {
  const rows = catalogueGameStubRows([
    { steam_appid: null, title: "Missing" },
    { steam_appid: "not-an-id", title: "Invalid" },
    { steam_appid: "10", title: "" },
    { steam_appid: "20", title: "First name" },
    { steam_appid: "20", title: "Final name" }
  ], "2026-08-13T14:00:00.000Z");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.steam_appid, 20);
  assert.equal(rows[0]?.name, "Final name");
});
