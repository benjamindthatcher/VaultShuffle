import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapResponse } from "./bootstrap.ts";
import type { VerifiedServerPrincipal } from "../db/client.ts";

const principal: VerifiedServerPrincipal = {
  accountId: 1, accountPublicId: "11111111-1111-4111-8111-111111111111",
  accountKind: "manual", sessionId: "7", sessionKind: "manual", identityVerified: false,
};

test("bootstrap does not connect for guests; expired cookies return 401", async () => {
  const guest = await bootstrapResponse(undefined, undefined, async () => { throw Error("must not connect"); });
  assert.equal(guest.status, 401);
  const expired = await bootstrapResponse("manual.expired", "secret", async () => ({
    sessions: { resolveCookie: async () => null },
    bootstrap: { read: async () => { throw Error("must not read"); } },
  }));
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get("cache-control"), "private, no-store");
});

test("bootstrap preserves session failures as retriable 503 and never exposes diagnostics", async () => {
  for (const secret of [undefined, "secret"]) {
    const response = await bootstrapResponse("manual.token", secret, async () => { throw Error("private-credential"); });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(await response.json(), { error: "database_unavailable", retryable: true });
  }
});

test("bootstrap uses only the resolved principal and returns bounded public metadata", async () => {
  const payload = { accountPublicId: principal.accountPublicId, libraryRevision: "3", stateRevision: "4", ownedTotal: 10_000, familyTotal: 0, pins: [], currentPick: null };
  const response = await bootstrapResponse("manual.token", "secret", async () => ({
    sessions: { resolveCookie: async (token, secret) => {
      assert.equal(token, "manual.token"); assert.equal(secret, "secret");
      return { principal, expiresAt: "2099-01-01T00:00:00Z" };
    } },
    bootstrap: { read: async resolved => { assert.equal(resolved, principal); return payload; } },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(await response.json(), payload);
});
