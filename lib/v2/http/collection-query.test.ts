import assert from "node:assert/strict";
import test from "node:test";
import { collectionQuery } from "./collection-query.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

test("Collections accept bounded paging and standing filters without tenant selectors", () => {
  const query = collectionQuery(new URLSearchParams("limit=60&cursor=abc&device=mac&excluded=puzzle&excluded=strategy"));
  assert.equal(query.limit, 60);
  assert.equal(query.cursor, "abc");
  assert.equal(query.globalFilters.device, "mac");
  assert.deepEqual(query.globalFilters.excluded, ["puzzle", "strategy"]);
  for (const value of ["account_id=1", "limit=101", "limit=60&limit=60", "cursor=a&cursor=b", "device=mac&device=linux", "search=games", "cursor=" + "x".repeat(4097)]) {
    assert.throws(() => collectionQuery(new URLSearchParams(value)), InvalidPageQueryError);
  }
});
