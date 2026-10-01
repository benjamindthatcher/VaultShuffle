import assert from "node:assert/strict";
import test from "node:test";
import { transformWishlist } from "./wishlist.ts";
import { LibraryTransformError } from "./library-shared.ts";
const A = "10000000-0000-4000-8000-00000000000a";
const B = "10000000-0000-4000-8000-00000000000b";
const RUN = { runId: "wishlist-fixture", snapshotHash: "ab".repeat(32) };
const MAP = [A, B].map((legacy_id, i) => ({ legacy_id, account_id: i + 1, source_kind: "app_accounts", source_snapshot_hash: RUN.snapshotHash }));
const row = (overrides = {}) => ({ user_id: A, steam_appid: "4294967295", source: "local", added_at: "2026-09-19 15:44:42.123456+01", ...overrides });
const run = (rows = [row()], accountMap = MAP) => transformWishlist({ runIdentity: RUN, accountMap, rows });
const code = (expected: string) => (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === expected;

test("non-catalogue unsigned AppID and exact added instant survive without a game map", () => {
  const actual = run().wishlist_games[0];
  assert.equal(actual.account_id, 1);
  assert.equal(actual.steam_app_id, BigInt(4294967295));
  assert.equal(actual.source, "local");
  assert.equal(actual.added_at.canonicalUtc, "2026-09-19T14:44:42.123456Z");
  assert.deepEqual(Object.keys(actual), ["account_id", "steam_app_id", "source", "added_at"]);
});
test("same AppID across owners remains separate, deterministic and retains Steam source", () => {
  const rows = [row({ user_id: B, source: "steam" }), row({ steam_appid: "1" }), row()];
  const values = (entries: ReturnType<typeof run>["wishlist_games"]) => entries.map(x => [x.account_id, x.steam_app_id.toString(), x.source, x.added_at.canonicalUtc]);
  assert.deepEqual(values(run(rows).wishlist_games), values(run([...rows].reverse()).wishlist_games));
  assert.deepEqual(run(rows).wishlist_games.map(x => [x.account_id, x.steam_app_id, x.source]), [[1, BigInt(1), "local"], [1, BigInt(4294967295), "local"], [2, BigInt(4294967295), "steam"]]);
});
test("duplicate owner/AppID is refused instead of overwriting source or added_at", () => {
  assert.throws(() => run([row(), row({ source: "steam" })]), code("library_duplicate_identity"));
});
test("unmapped owners and maps from a different snapshot fail without source values", () => {
  assert.throws(() => run([row({ user_id: "10000000-0000-4000-8000-00000000000c" })]), code("library_account_unmapped"));
  assert.throws(() => run([row()], [{ ...MAP[0], source_snapshot_hash: "cd".repeat(32) }]), code("library_mixed_run_identity"));
  try { run([row({ user_id: "10000000-0000-4000-8000-00000000000c" })]); } catch (error) {
    assert.equal(JSON.stringify(error).includes("10000000-0000"), false);
  }
});
test("invalid AppIDs and source enums are never repaired or silently lost", () => {
  for (const steam_appid of ["0", "4294967296", "-1", "1.5", "0001"]) assert.throws(() => run([row({ steam_appid })]), LibraryTransformError);
  assert.throws(() => run([row({ source: "import" })]), code("library_invalid_enum"));
});
test("missing timezone, excessive precision and mixed-run rows are refused", () => {
  assert.throws(() => run([row({ added_at: "2026-09-19 15:44:42" })]), code("library_invalid_timestamp"));
  assert.throws(() => run([row({ added_at: "2026-09-19 15:44:42.1234567+00" })]), code("library_invalid_timestamp"));
  assert.throws(() => run([row({ runId: "different" })]), code("library_mixed_run_identity"));
});
test("empty Wishlist stays empty", () => assert.deepEqual(run([]).wishlist_games, []));
