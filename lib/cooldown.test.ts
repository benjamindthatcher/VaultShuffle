import assert from "node:assert/strict";
import test from "node:test";
import { readCooldown } from "./cooldown.ts";

test("reads an honest retry time from a rate-limit payload", () => {
  const response = new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  assert.deepEqual(readCooldown(response, {
    code: "rate_limited",
    error: "Steam was refreshed recently.",
    retry_after_seconds: 487
  }), {
    message: "Steam was refreshed recently.",
    retryAfterSeconds: 487
  });
});

test("falls back to Retry-After and ignores ordinary failures", () => {
  assert.equal(readCooldown(new Response(null, { status: 500 }), { error: "No" }), null);
  assert.equal(
    readCooldown(new Response(null, { status: 429, headers: { "Retry-After": "9" } }), {})?.retryAfterSeconds,
    9
  );
});
