import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The client casts the vault-state response straight to VaultState, so nothing in
 * TypeScript checks that the server actually returns every field. When `pins` was
 * added to the type, recordVaultAction went on returning its own hand-built
 * object without it — every pin, unpin and snooze then replaced the client's
 * state with one missing a field the type promised, and the next render crashed.
 */
const source = readFileSync(new URL("./vault-state.ts", import.meta.url), "utf8");

test("a vault action returns the state by reading it, not by rebuilding it", () => {
  const body = source.slice(source.indexOf("export async function recordVaultAction"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 2);

  assert.match(fn, /return getVaultState\(userId\)/,
    "recordVaultAction must re-read the state so its shape cannot drift from getVaultState");
  assert.ok(!/pinnedIds:\s*Array\.isArray/.test(fn),
    "hand-assembling the response is what let a field go missing in the first place");
});

test("the action's return type is pinned to VaultState", () => {
  assert.match(source, /recordVaultAction\([\s\S]*?\): Promise<VaultState>/,
    "an explicit return type is what makes a missing field a compile error here");
});
