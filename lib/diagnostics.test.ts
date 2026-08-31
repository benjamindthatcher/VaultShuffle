import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticConsent, diagnosticFailure, diagnosticId, diagnosticRoute, safeDiagnosticProperties } from "./diagnostics.ts";
import { deliverDiagnostics, type DiagnosticEvent } from "./diagnostics-transport.ts";
import { SteamApiError } from "./steam-api-error.ts";

const id = "11111111-2222-4333-8444-555555555555";
const event: DiagnosticEvent = { event: "server_error", uuid: id, timestamp: "2026-08-31T01:14:34Z", properties: { request_id: id, operation: "manual_profile_lookup", error_code: "steam_rate_limited" } };

test("diagnostics only allow approved metadata, not secrets, URLs, DB messages or bodies", () => {
  const secret = "private-session-secret";
  const result = safeDiagnosticProperties({ request_id: id, operation: "steam_library_import", error_code: "steam_rate_limited", upstream_status: 429,
    token: secret, body: secret, headers: { Cookie: secret }, url: `https://steamcommunity.com/id/${secret}`, message: secret,
    route: `/api/games/${secret}?key=${secret}`, account_id: "76561198000000000", error_type: "https://bad.example", duration_ms: Infinity });
  assert.deepEqual(result, { request_id: id, operation: "steam_library_import", error_code: "steam_rate_limited", upstream_status: 429, route: "/api/games/:id" });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(diagnosticId("76561198000000000"), undefined);
  assert.equal(diagnosticRoute("/api/auth/steam/callback?openid.sig=secret"), "/api/auth/steam/callback");
});

test("classifies upstream and nested database errors without serializing their contents", () => {
  const { error_fingerprint, ...failure } = diagnosticFailure(new SteamApiError("owned_games", "steam_rate_limited", 429, 90));
  assert.match(String(error_fingerprint), /^[a-f0-9]{8}$/);
  assert.deepEqual(failure, {
    error_type: "steam", error_code: "steam_rate_limited", upstream_status: 429, upstream_operation: "owned_games", retry_after_seconds: 90,
  });
  const error = new Error("raw private account data", { cause: { code: "42702", message: "sensitive SQL values" } });
  assert.equal(diagnosticFailure(error).database_code, "42702");
  assert.ok(!JSON.stringify(diagnosticFailure(error)).includes("sensitive"));
  assert.equal(diagnosticFailure(new Error("Missing required environment variable: SESSION_SECRET")).error_code, "configuration_missing");
});

test("PostHog diagnostics require consent and honour DNT/GPC without reading app session cookies", () => {
  assert.equal(diagnosticConsent(new Headers()).enabled, false);
  const cookie = `vault_session=secret; vault_diagnostics=enabled.${id}.${id}`;
  assert.deepEqual(diagnosticConsent(new Headers({ cookie })), { enabled: true, person: id, replay: id });
  assert.equal(diagnosticConsent(new Headers({ cookie, DNT: "1" })).enabled, false);
  assert.equal(diagnosticConsent(new Headers({ cookie, "sec-gpc": "1" })).enabled, false);
  assert.equal(diagnosticConsent(new Headers({ cookie: "vault_diagnostics=disabled" })).enabled, false);
});

test("delivery is bounded, directly awaited, anonymous by default and has no person creation", async () => {
  let sent = 0;
  const result = await deliverDiagnostics({ events: [event], enabled: true, token: "project-token", person: id, replay: id, environment: "production", release: "abcdef123" }, async (url, init) => {
    sent += 1;
    assert.equal(url, "https://eu.i.posthog.com/batch/");
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.batch[0].properties.distinct_id, id);
    assert.equal(body.batch[0].properties.$session_id, id);
    assert.equal(body.batch[0].properties.$process_person_profile, false);
    assert.equal(body.batch[0].properties.$geoip_disable, true);
    assert.equal(body.batch[0].properties.release, "abcdef123");
    return new Response("{}", { status: 200 });
  });
  assert.equal(result, "delivered"); assert.equal(sent, 1);
});

test("opt-out/missing configuration makes no network request; failures never throw or retry", async () => {
  const forbidden: typeof fetch = async () => { throw new Error("must not call"); };
  assert.equal(await deliverDiagnostics({ events: [event], enabled: false, token: "test" }, forbidden), "disabled");
  assert.equal(await deliverDiagnostics({ events: [event], enabled: true }, forbidden), "unconfigured");
  let attempts = 0;
  assert.equal(await deliverDiagnostics({ events: [event], enabled: true, token: "test" }, async () => { attempts++; throw new Error("offline"); }), "failed");
  assert.equal(attempts, 1);
  assert.equal(await deliverDiagnostics({ events: [event], enabled: true, token: "test" }, async () => new Response(null, { status: 429 })), "failed");
});
