import assert from "node:assert/strict";
import test from "node:test";
import { collectionPageQuery, wishlistPageQuery, noPageQuery } from "./page-query.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

test("member pages reject account selectors, duplicate cursors and oversized pages", () => {
  assert.deepEqual(collectionPageQuery(new URLSearchParams()), { cursor: undefined, limit: 50 });
  for (const query of ["account_id=2", "limit=101", "limit=-1", "limit=1e2", "cursor=", "cursor=a&cursor=b"]) {
    assert.throws(() => collectionPageQuery(new URLSearchParams(query)), InvalidPageQueryError);
  }
});

test("Wishlist metadata stays limited to 24 items and pagination cannot change tenants", () => {
  assert.deepEqual(wishlistPageQuery(new URLSearchParams("offset=100000&limit=24")), { offset: 100000, limit: 24 });
  for (const query of ["offset=100001", "offset=0.5", "limit=25", "limit=0", "user_id=other", "offset=1&offset=2"]) {
    assert.throws(() => wishlistPageQuery(new URLSearchParams(query)), InvalidPageQueryError);
  }
  assert.throws(() => noPageQuery(new URLSearchParams("account_id=2")), InvalidPageQueryError);
});
