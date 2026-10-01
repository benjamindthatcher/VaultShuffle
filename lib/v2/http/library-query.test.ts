import assert from "node:assert/strict";
import test from "node:test";
import { libraryQuery, libraryGameId } from "./library-query.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

test("Library HTTP queries are bounded and cannot supply an account principal", () => {
  for (const query of ["account_id=2", "limit=1000", "limit=0", "limit=1e2", "sort=hours&sort=title", "section=slept", "access=private", "cursor=", `search=${"x".repeat(121)}`]) {
    assert.throws(() => libraryQuery(new URLSearchParams(query)), InvalidPageQueryError);
  }
  assert.throws(() => libraryQuery(new URLSearchParams(Array.from({ length: 19 }, () => ["genre", "RPG"]))), InvalidPageQueryError);
  const query = libraryQuery(new URLSearchParams("limit=100&section=blacklisted&sort=title&direction=asc&genre=RPG&genre=Puzzle"));
  assert.equal(query.limit, 100);
  assert.equal(query.section, "blacklisted");
  assert.deepEqual(query.genres, ["RPG", "Puzzle"]);
  assert.equal(libraryQuery(new URLSearchParams()).section, "active");
});

test("Library detail IDs validate internal integer keys without parsing prefixes", () => {
  assert.equal(libraryGameId("2147483647"), 2147483647);
  for (const id of ["0", "01", "-1", "1e2", "1/2", "2147483648"]) assert.throws(() => libraryGameId(id), InvalidPageQueryError);
});
