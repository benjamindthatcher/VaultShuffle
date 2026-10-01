import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedRead, type ReadFailureStage } from "./read-response.ts";
import { DatabaseUnavailableError, RequestLimitError } from "../db/errors.ts";
import type { VerifiedServerPrincipal } from "../db/client.ts";
import { InvalidPageQueryError, PageCursorRestartRequiredError } from "../repositories/page-errors.ts";
import { diagnosticFailure } from "../../diagnostics.ts";

const principal: VerifiedServerPrincipal = {
  accountId: 1, accountPublicId: "11111111-1111-4111-8111-111111111111",
  accountKind: "manual", sessionId: "7", sessionKind: "manual", identityVerified: false,
};
const runtime = { sessions: { resolveCookie: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }) } };

test("unexpected V2 failures report their stage and preserve the safe retry response", async () => {
  const privateValue = "private-password-account-sql";
  const cause = Object.assign(new Error(privateValue), { code: "42501", query: privateValue });
  const failure = new DatabaseUnavailableError(cause);
  const cases: ReadFailureStage[] = ["configuration", "database_connection", "session_lookup", "database_operation", "response_encoding"];
  for (const expectedStage of cases) {
    const events: { error: unknown; stage: ReadFailureStage }[] = [];
    const services = async () => {
      if (expectedStage === "database_connection") throw failure;
      return { sessions: { resolveCookie: async () => {
        if (expectedStage === "session_lookup") throw failure;
        return { principal, expiresAt: "2099-01-01T00:00:00Z" };
      } } };
    };
    const response = await authenticatedRead("private-cookie", expectedStage === "configuration" ? undefined : "private-secret", services, async () => {
      if (expectedStage === "database_operation") throw failure;
      return { value: BigInt(1) }; // JSON encoding failures use the same boundary.
    }, (error, stage) => events.push({ error, stage }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: "database_unavailable", retryable: true });
    assert.ok(!body.includes(privateValue));
    assert.equal(events.length, 1);
    assert.equal(events[0].stage, expectedStage);
    if (expectedStage === "session_lookup" || expectedStage === "database_operation" || expectedStage === "database_connection") {
      assert.equal(events[0].error, failure);
      assert.equal(diagnosticFailure(events[0].error).database_code, "42501");
      assert.ok(!JSON.stringify(diagnosticFailure(events[0].error)).includes(privateValue));
    }
  }
});

test("normal V2 responses and expected rejections do not report database failures", async () => {
  const report = () => assert.fail("Expected responses must not emit database failures");
  const guest = await authenticatedRead(undefined, undefined, async () => { throw Error("must not connect"); }, async () => null, report);
  assert.equal(guest.status, 401);
  const expired = await authenticatedRead("expired", "secret", async () => ({ sessions: { resolveCookie: async () => null } }), async () => null, report);
  assert.equal(expired.status, 401);
  for (const [error, status] of [[new InvalidPageQueryError(), 400], [new PageCursorRestartRequiredError(), 409], [new RequestLimitError(20), 429]] as const) {
    const response = await authenticatedRead("token", "secret", async () => runtime, async () => { throw error; }, report);
    assert.equal(response.status, status);
    if (status === 429) assert.equal(response.headers.get("retry-after"), "20");
  }
  const missing = await authenticatedRead("token", "secret", async () => runtime, async () => null, report);
  assert.equal(missing.status, 404);
  const success = await authenticatedRead("token", "secret", async () => runtime, async () => ({ total: 5 }), report);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { total: 5 });
});

test("a diagnostic reporter failure cannot alter a V2 database response", async () => {
  const response = await authenticatedRead("token", "secret", async () => runtime, async () => { throw new DatabaseUnavailableError(); }, () => { throw Error("diagnostic transport offline"); });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "database_unavailable", retryable: true });
});
