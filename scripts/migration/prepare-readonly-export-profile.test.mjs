import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_DIRECT_HOST,
  SOURCE_PROJECT_REF,
  buildProfile,
  parseArgs,
  parseLoginRoleResponse,
} from "./prepare-readonly-export-profile.mjs";

test("the prepared profile uses the existing direct source contract and generated role identity", () => {
  const profile = buildProfile(
    { role: "temporary_reader", password: "synthetic-password" },
    { label: "synthetic", caCertificatesPemPath: "/tmp/source-ca.pem" },
  );
  assert.equal(profile.connection.host, SOURCE_DIRECT_HOST);
  assert.equal(profile.connection.user, "temporary_reader");
  assert.equal(profile.connection.activate_role, "supabase_read_only_user");
  assert.equal(profile.identity.project_ref, SOURCE_PROJECT_REF);
  assert.equal(profile.identity.expected_current_user, "temporary_reader");
  assert.deepEqual(profile.identity.expect_schemas_absent, ["app"]);
  assert.deepEqual(profile.tls, { ca_certificates_pem_path: "/tmp/source-ca.pem" });
});

test("the helper refuses an unapproved request or malformed API response", () => {
  assert.throws(() => parseArgs(["--profile-path", "/tmp/profile.json"]), /approve-source-login-creation/);
  assert.throws(() => parseLoginRoleResponse({ role: "r", password: "p", ttl_seconds: 0 }), /positive TTL/);
  assert.throws(() => parseLoginRoleResponse({ role: "r", ttl_seconds: 10 }), /role, password, or positive TTL/);
});
