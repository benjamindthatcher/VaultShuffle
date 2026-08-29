import assert from "node:assert/strict";
import test from "node:test";
import { collectionPatchSchema, collectionPayloadSchema, purgeReviewPayloadSchema } from "./validation.ts";

const gameId = "7f1dfe0e-a8ca-4c30-975b-953b97cc9f30";

test("purge decisions have one category-free request contract", () => {
  assert.deepEqual(
    purgeReviewPayloadSchema.parse({ game_id: gameId, action: "sleep" }),
    { game_id: gameId, action: "sleep" }
  );
  assert.equal(
    purgeReviewPayloadSchema.safeParse({ game_id: gameId, action: "sleep", category: "legacy" }).success,
    false
  );
  // Purge can mark a game completed now, so the contract accepts it. "pin" is
  // still accepted although nothing offers it any more: a tab opened before the
  // change will still send it, and the RPC still handles it.
  assert.equal(purgeReviewPayloadSchema.safeParse({ game_id: gameId, action: "complete" }).success, true);
  assert.equal(purgeReviewPayloadSchema.safeParse({ game_id: gameId, action: "pin" }).success, true);
  assert.equal(purgeReviewPayloadSchema.safeParse({ game_id: gameId, action: "nonsense" }).success, false);
});

test("collection create requires a rule for smart collections", () => {
  const parsed = collectionPayloadSchema.safeParse({ name: "Quick wins", kind: "smart" });

  assert.equal(parsed.success, false);
});

test("collection patch accepts partial updates independently of create refinements", () => {
  assert.deepEqual(collectionPatchSchema.parse({ name: "Updated shelf" }), { name: "Updated shelf" });
  assert.deepEqual(collectionPatchSchema.parse({ description: "A new description" }), { description: "A new description" });
});
