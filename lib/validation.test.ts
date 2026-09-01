import assert from "node:assert/strict";
import test from "node:test";
import { collectionPatchSchema, collectionPayloadSchema } from "./validation.ts";

const gameId = "7f1dfe0e-a8ca-4c30-975b-953b97cc9f30";

test("collection create requires a rule for smart collections", () => {
  const parsed = collectionPayloadSchema.safeParse({ name: "Quick wins", kind: "smart" });

  assert.equal(parsed.success, false);
});

test("collection patch accepts partial updates independently of create refinements", () => {
  assert.deepEqual(collectionPatchSchema.parse({ name: "Updated shelf" }), { name: "Updated shelf" });
  assert.deepEqual(collectionPatchSchema.parse({ description: "A new description" }), { description: "A new description" });
});
