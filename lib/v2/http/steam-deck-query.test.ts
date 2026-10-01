import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GLOBAL_FILTERS } from "../../global-filters.ts";
import { globalFilterParams } from "../filter-query.ts";
import { libraryQuery } from "./library-query.ts";
import { dashboardQuery } from "./dashboard-query.ts";
import { collectionQuery } from "./collection-query.ts";
import { libraryGlobalFilters } from "../repositories/library-global-filters.ts";

test("strict Deck filtering survives URL transport on every paged surface", () => {
  const params = new URLSearchParams(globalFilterParams({ ...DEFAULT_GLOBAL_FILTERS, device: "deck", deckRating: "verified" }));
  assert.equal(libraryQuery(params).globalFilters?.deckRating, "verified");
  assert.equal(dashboardQuery(params).deckRating, "verified");
  assert.equal(collectionQuery(params).globalFilters.deckRating, "verified");
  assert.equal(libraryGlobalFilters({ ...DEFAULT_GLOBAL_FILTERS, deckRating: undefined }).deckRating, "verified-playable");
});
test("HTTP filters reject invalid and repeated Deck rating values", () => {
  for (const params of ["deck_rating=bad", "deck_rating=verified&deck_rating=verified"]) {
    assert.throws(() => libraryQuery(new URLSearchParams(params)));
    assert.throws(() => dashboardQuery(new URLSearchParams(params)));
  }
});
