import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExportError } from "../shared/redaction.ts";
import { parseConnectionProfile, readCaCertificatesPem } from "./profile.ts";

const CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "synthetic-public-ca-material",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

function tcpProfile(tls: Record<string, unknown> = {}, connectionOverrides: Record<string, unknown> = {}) {
  return parseConnectionProfile(
    JSON.stringify({
      profile_version: 1,
      role: "source-read-only",
      label: "synthetic profile",
      connection: {
        transport: "tcp",
        host: "pfvblcopcmairdfeqdep.example",
        port: 5432,
        database: "postgres",
        user: "source_reader",
        password: "synthetic-password",
        ...connectionOverrides,
      },
      identity: {
        project_ref: "pfvblcopcmairdfeqdep",
        expected_database: "postgres",
        expected_current_user: "source_reader",
        expect_schemas_present: ["public"],
        expect_schemas_absent: ["app"],
      },
      tls,
    }),
  );
}

test("a profile can activate only Supabase's fixed read-only role", () => {
  const profile = tcpProfile({}, { activate_role: "supabase_read_only_user" });
  assert.equal(profile.activateRole, "supabase_read_only_user");
  assert.throws(
    () => tcpProfile({}, { activate_role: "postgres" }),
    (error: unknown) => error instanceof ExportError && error.code === "profile_role_activation_refused",
  );
});

test("a TCP profile loads its absolute CA bundle for certificate verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vs-profile-"));
  try {
    const path = join(directory, "source-ca.pem");
    await writeFile(path, CERTIFICATE, { mode: 0o644 });
    const profile = tcpProfile({ ca_certificates_pem_path: path });
    assert.equal(profile.caCertificatesPemPath, path);
    assert.equal(await readCaCertificatesPem(profile), CERTIFICATE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CA bundle paths are explicit and bounded", async (t) => {
  await t.test("relative path is refused during profile parsing", () => {
    assert.throws(
      () => tcpProfile({ ca_certificates_pem_path: "source-ca.pem" }),
      (error: unknown) => error instanceof ExportError && error.code === "profile_invalid",
    );
  });

  await t.test("a missing certificate is a TLS CA error", async () => {
    const profile = tcpProfile({ ca_certificates_pem_path: "/tmp/vs-ca-that-does-not-exist.pem" });
    await assert.rejects(
      () => readCaCertificatesPem(profile),
      (error: unknown) => error instanceof ExportError && error.code === "tls_ca_unreadable",
    );
  });

  await t.test("a non-PEM bundle is refused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vs-profile-invalid-"));
    try {
      const path = join(directory, "source-ca.pem");
      await writeFile(path, "not a certificate", { mode: 0o644 });
      const profile = tcpProfile({ ca_certificates_pem_path: path });
      await assert.rejects(
        () => readCaCertificatesPem(profile),
        (error: unknown) => error instanceof ExportError && error.code === "tls_ca_invalid",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a Unix-socket profile cannot carry an ignored TLS CA path", () => {
  assert.throws(
    () =>
      parseConnectionProfile(
        JSON.stringify({
          profile_version: 1,
          role: "source-read-only",
          label: "synthetic socket profile",
          connection: {
            transport: "unix-socket",
            host: "/tmp/vaultshuffle-pg17-socket",
            port: 55432,
            database: "fixture",
            user: "fixture_reader",
          },
          identity: {
            expected_database: "fixture",
            expected_current_user: "fixture_reader",
            expect_schemas_present: ["public"],
            expect_schemas_absent: ["app"],
          },
          tls: { ca_certificates_pem_path: "/tmp/source-ca.pem" },
        }),
      ),
    (error: unknown) => error instanceof ExportError && error.code === "profile_invalid",
  );
});
