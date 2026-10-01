import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { buildManifest, serializeManifest, type ManifestRelation } from "../export/manifest.ts";
import { describePlanFromServer } from "../export/plan.ts";
import { parseConnectionProfile, type ConnectionProfile } from "../export/profile.ts";
import { runExport } from "../export/run.ts";
import { WireConnection } from "../export/wire.ts";
import { inspectRun, type ReaderExpectations } from "./reader.ts";

/**
 * This is opt-in because it reads a disposable local PostgreSQL fixture. It
 * creates no database objects and never points at a remote or VaultShuffle
 * evidence database.
 *
 *   VAULTSHUFFLE_M3_READER_INTEGRATION=1 \
 *     node --experimental-strip-types --test \
 *     lib/v2/migration/read/reader-roundtrip.integration.ts
 */
const ENABLED = process.env.VAULTSHUFFLE_M3_READER_INTEGRATION === "1";

function environment(name: string, fallback: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const SOCKET_DIRECTORY = environment("VAULTSHUFFLE_M3_EXPORT_PGHOST", "/tmp/vs-m3");
const PORT = Number.parseInt(environment("VAULTSHUFFLE_M3_EXPORT_PGPORT", "55441"), 10);
const ADMIN_USER = environment("VAULTSHUFFLE_M3_EXPORT_PGUSER", "vault_local_admin");
const SOURCE_DATABASE = environment("VAULTSHUFFLE_M3_EXPORT_SOURCE_DB", "vaultshuffle_m3_export_a");

function assertDisposableDatabase(name: string): void {
  if (/^vaultshuffle_m[12](_|$)/.test(name)) {
    throw new Error("The reader fixture refuses M1/M2 evidence databases.");
  }
}
assertDisposableDatabase(SOURCE_DATABASE);

let scratch = "";

before(async () => {
  if (!ENABLED) return;
  scratch = await mkdtemp(join(tmpdir(), "vs-m3-reader-roundtrip-"));
});

after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function fixtureProfile(): ConnectionProfile {
  return parseConnectionProfile(
    JSON.stringify({
      profile_version: 1,
      role: "source-read-only",
      label: "m3-c synthetic exporter-reader roundtrip",
      connection: {
        transport: "unix-socket",
        host: SOCKET_DIRECTORY,
        port: PORT,
        database: SOURCE_DATABASE,
        user: ADMIN_USER,
      },
      identity: {
        expected_database: SOURCE_DATABASE,
        expected_current_user: ADMIN_USER,
        expect_schemas_present: ["public"],
        expect_schemas_absent: ["app", "ops", "migration"],
      },
    }),
  );
}

async function fixturePlan(relations: readonly string[]) {
  const connection = await WireConnection.connect({
    host: SOCKET_DIRECTORY,
    port: PORT,
    user: ADMIN_USER,
    database: SOURCE_DATABASE,
    password: null,
    tls: { kind: "unix-socket" },
    applicationName: "vaultshuffle-v2-reader-test",
    connectTimeoutMs: 10_000,
  });
  try {
    return await describePlanFromServer(connection, { schema: "public", relations });
  } finally {
    await connection.close();
  }
}

async function copyControlFixture(): Promise<Buffer> {
  const connection = await WireConnection.connect({
    host: SOCKET_DIRECTORY,
    port: PORT,
    user: ADMIN_USER,
    database: SOURCE_DATABASE,
    password: null,
    tls: { kind: "unix-socket" },
    applicationName: "vaultshuffle-v2-reader-control-test",
    connectTimeoutMs: 10_000,
  });
  const chunks: Buffer[] = [];
  try {
    const controls = Array.from({ length: 31 }, (_, index) => index + 1);
    const expression = controls.map((codePoint) => `chr(${codePoint})`).join(" || ");
    const result = await connection.copyOut(
      `COPY (SELECT ${expression}) TO STDOUT WITH (FORMAT text, ENCODING 'UTF8')`,
      {
        write(chunk) {
          chunks.push(Buffer.from(chunk));
          return true;
        },
        whenDrained: async () => {},
      },
    );
    assert.equal(result.commandTag, "COPY 1");
  } finally {
    await connection.close();
  }
  return Buffer.concat(chunks);
}

test("a clean exporter run is verified and streamed back without value coercion", { skip: !ENABLED }, async () => {
  const plan = await fixturePlan(["exp_bulk", "exp_scalars"]);
  const outputRoot = join(scratch, "exports");
  await mkdir(outputRoot, { mode: 0o700 });
  const profile = fixtureProfile();
  const exported = await runExport({ profile, plan, outputRoot });
  const expected: ReaderExpectations = {
    source: {
      kind: "synthetic-fixture",
      database: SOURCE_DATABASE,
      user: ADMIN_USER,
      label: profile.label,
    },
    relations: plan.relations.map((relation) => ({
      schema: relation.schema,
      name: relation.name,
      columns: relation.columns.map((column) => column.name),
    })),
  };

  const verified = await inspectRun(exported.runDirectory, expected);
  assert.equal(verified.manifest.manifest_version, 2);
  assert.equal(verified.manifest.snapshot.current_snapshot, verified.manifest.snapshot.closing_snapshot);
  assert.deepEqual(
    verified.relations.map((relation) => relation.name),
    ["exp_bulk", "exp_scalars"],
  );
  assert.ok(
    (verified.relations.find((relation) => relation.name === "exp_bulk")?.bytes ?? 0) > 12 * 1024 * 1024,
    "the bounded stream fixture must remain large enough to exercise backpressure",
  );

  const scalarRows: Array<readonly (string | null)[]> = [];
  await verified.streamRelationRows("public.exp_scalars", (row) => {
    scalarRows.push(row);
  });
  const byLabel = new Map(scalarRows.map((row) => [row[1], row] as const));
  const allNull = scalarRows.find((row) => row[0] === "1");
  assert.ok(allNull);
  assert.equal(allNull[1], null);
  assert.equal(allNull[2], null);
  assert.equal(byLabel.get("bigint-min")?.[0], "-9223372036854775808");
  assert.equal(byLabel.get("bigint-max")?.[0], "9223372036854775807");
  assert.equal(byLabel.get("numeric-wide")?.[2], "1234567890123456789012345678.0123456789");
  assert.equal(byLabel.get("float-precise")?.[4], "1.2345678901234567");
  assert.equal(byLabel.get("leap-day")?.[6], "2024-02-29");
  assert.equal(byLabel.get("uk-dst-start")?.[6], "2026-03-29");
  assert.equal(byLabel.get("uk-dst-end")?.[6], "2026-10-25");
  assert.equal(byLabel.get("uk-dst-spring-forward")?.[7], "2026-03-29 00:59:59+00");
  assert.equal(byLabel.get("uk-dst-fall-back")?.[7], "2026-10-25 01:59:59+00");

  // Do not collect this relation. The callback proves every row arrived while
  // the reader retained only one row; the fixture is approximately 12.7 MiB.
  let bulkRows = 0;
  await verified.streamRelationRows("public.exp_bulk", (row) => {
    assert.equal(row.length, 2);
    bulkRows += 1;
  });
  assert.equal(bulkRows, 60_000);
});

test("the live PostgreSQL COPY stream preserves every non-NUL ASCII control", { skip: !ENABLED }, async () => {
  const relationBytes = await copyControlFixture();
  const expectedValue = String.fromCodePoint(...Array.from({ length: 31 }, (_, index) => index + 1));
  const relation: ManifestRelation = {
    schema: "public",
    name: "controls",
    rowsReportedByServer: 1,
    rowsCountedOnWire: 1,
    bytes: relationBytes.length,
    sha256: createHash("sha256").update(relationBytes).digest("hex"),
    columns: ["value"],
    durationMs: 0,
    file: "relations/public.controls.copy",
  };
  const manifest = buildManifest({
    runId: "20260910-reader-control-copy",
    codeRevision: null,
    profile: {
      label: "m3-c synthetic direct-copy control fixture",
      transport: "unix-socket",
      host: SOCKET_DIRECTORY,
      port: PORT,
      database: SOURCE_DATABASE,
      user: ADMIN_USER,
    },
    tlsProtocol: null,
    identity: {
      currentDatabase: SOURCE_DATABASE,
      currentUser: ADMIN_USER,
      sessionUser: ADMIN_USER,
      serverVersion: "PostgreSQL 17.6",
      serverVersionNum: 170006,
      systemIdentifier: null,
      inRecovery: false,
      schemasPresent: ["public"],
      transactionIsolation: "repeatable read",
      transactionReadOnly: "on",
      projectRef: null,
    },
    watermark: {
      snapshotXmin: "1",
      currentSnapshot: "1:2:",
      walLsn: null,
      statementStartUtc: "2026-09-10T12:00:00.000Z",
      transactionStartUtc: "2026-09-10T12:00:00.000Z",
      backendPid: "1",
    },
    closingSnapshot: "1:2:",
    sessionSettings: {
      TimeZone: "UTC",
      DateStyle: "ISO, YMD",
      IntervalStyle: "iso_8601",
      extra_float_digits: "3",
      bytea_output: "hex",
      client_encoding: "UTF8",
      synchronize_seqscans: "off",
    },
    rowSecurity: {
      setting: "off",
      settingAtClose: "off",
      roleIsSuperuser: true,
      roleBypassesRowSecurity: true,
    },
    walLsnAvailable: false,
    relations: [relation],
    runDirectoryMode: "0700",
    fileMode: "0600",
    insideGitWorktree: null,
    startedUtc: "2026-09-10T12:00:00.000Z",
    finishedUtc: "2026-09-10T12:00:00.001Z",
    durationMs: 1,
  });
  const runDirectory = join(scratch, "control-copy");
  await mkdir(join(runDirectory, "relations"), { recursive: true, mode: 0o700 });
  const serialized = serializeManifest(manifest);
  await writeFile(join(runDirectory, "relations", "public.controls.copy"), relationBytes, { mode: 0o600 });
  await writeFile(join(runDirectory, "manifest.json"), serialized.text, { mode: 0o600 });
  await writeFile(join(runDirectory, "manifest.sha256"), `${serialized.sha256}  manifest.json\n`, { mode: 0o600 });

  const verified = await inspectRun(runDirectory, {
    source: {
      kind: "synthetic-fixture",
      database: SOURCE_DATABASE,
      user: ADMIN_USER,
      label: "m3-c synthetic direct-copy control fixture",
    },
    relations: [{ schema: "public", name: "controls", columns: ["value"] }],
  });
  const rows: Array<readonly (string | null)[]> = [];
  const result = await verified.streamRelationRows("public.controls", (row) => {
    rows.push(row);
  });
  assert.deepEqual(rows, [[expectedValue]]);
  assert.equal(result.rows, 1);
  assert.equal(result.bytes, relationBytes.length);
});
