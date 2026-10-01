import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConnectionProfile } from "./profile.ts";
import { runExport } from "./run.ts";
import { quoteIdentifier, WireConnection } from "./wire.ts";
import { streamSnapshot, type ExportPlan } from "./snapshot.ts";

/**
 * Opt-in PostgreSQL regression for format-sensitive constraint rendering.
 * The selected database must be a disposable synthetic fixture.
 */
const ENABLED = process.env.VAULTSHUFFLE_M3_CONSTRAINT_INTEGRATION === "1";
const HOST = process.env.VAULTSHUFFLE_M3_EXPORT_PGHOST ?? "/tmp/vaultshuffle-pg17-socket";
const PORT = Number.parseInt(process.env.VAULTSHUFFLE_M3_EXPORT_PGPORT ?? "55432", 10);
const USER = process.env.VAULTSHUFFLE_M3_EXPORT_PGUSER ?? "vault_local_admin";
const DATABASE = process.env.VAULTSHUFFLE_M3_EXPORT_SOURCE_DB ?? "vaultshuffle_m3_constraint_fixture";
const SCHEMA = "export_constraint_rendering_fixture";

if (!/(fixture|test|synthetic|export_guard)/i.test(DATABASE)) {
  throw new Error(`Refusing to mutate non-fixture database ${DATABASE}.`);
}

async function connect(): Promise<WireConnection> {
  return WireConnection.connect({
    host: HOST,
    port: PORT,
    user: USER,
    database: DATABASE,
    password: null,
    tls: { kind: "unix-socket" },
    applicationName: "vaultshuffle-constraint-rendering-test",
    connectTimeoutMs: 10_000,
  });
}

test(
  "schema drift guard compares interval CHECKs under the inventory representation",
  { skip: ENABLED ? false : "set VAULTSHUFFLE_M3_CONSTRAINT_INTEGRATION=1" },
  async () => {
    const connection = await connect();
    try {
      await connection.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(SCHEMA)} CASCADE`);
      await connection.query(`CREATE SCHEMA ${quoteIdentifier(SCHEMA)}`);
      await connection.query(
        `CREATE TABLE ${quoteIdentifier(SCHEMA)}.intent (` +
          "created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, " +
          "CONSTRAINT intent_window CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'))",
      );
      await connection.query(
        `INSERT INTO ${quoteIdentifier(SCHEMA)}.intent VALUES (` +
          "'2026-01-01T00:00:00Z', '2026-01-01T00:15:00Z')",
      );
      await connection.query(
        `CREATE VIEW ${quoteIdentifier(SCHEMA)}.intent_view AS ` +
          `SELECT created_at, expires_at FROM ${quoteIdentifier(SCHEMA)}.intent`,
      );

      await connection.query("SET IntervalStyle = 'iso_8601'");
      const rendered = await connection.query(
        "SELECT pg_get_constraintdef(con.oid, false) " +
          "FROM pg_catalog.pg_constraint con " +
          "JOIN pg_catalog.pg_class c ON c.oid = con.conrelid " +
          "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
          `WHERE n.nspname = '${SCHEMA}' AND con.conname = 'intent_window'`,
      );
      assert.match(rendered.rows[0]?.[0] ?? "", /'PT15M'::interval/);

      const plan: ExportPlan = {
        relations: [
          {
            schema: SCHEMA,
            name: "intent",
            kind: "r",
            columns: [
              { ordinal: 1, name: "created_at", type: "timestamp with time zone" },
              { ordinal: 2, name: "expires_at", type: "timestamp with time zone" },
            ],
          },
          {
            schema: SCHEMA,
            name: "intent_view",
            kind: "v",
            columns: [
              { ordinal: 1, name: "created_at", type: "timestamp with time zone" },
              { ordinal: 2, name: "expires_at", type: "timestamp with time zone" },
            ],
          },
        ],
        schemaContract: {
          schema: SCHEMA,
          relations: [
            {
              schema: SCHEMA,
              name: "intent",
              kind: "r",
              rls: false,
              columns: [
                { ordinal: 1, name: "created_at", type: "timestamp with time zone", nullable: false },
                { ordinal: 2, name: "expires_at", type: "timestamp with time zone", nullable: false },
              ],
              constraints: [
                {
                  name: "intent_window",
                  type: "c",
                  definition:
                    "CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:15:00'::interval))))",
                },
              ],
            },
            {
              schema: SCHEMA,
              name: "intent_view",
              kind: "v",
              rls: false,
              columns: [
                { ordinal: 1, name: "created_at", type: "timestamp with time zone", nullable: true },
                { ordinal: 2, name: "expires_at", type: "timestamp with time zone", nullable: true },
              ],
              constraints: [],
            },
          ],
        },
      };

      const snapshot = await streamSnapshot(connection, {
        plan,
        statementTimeoutMs: 10_000,
        openRelationOutput: async () => ({
          sink: { write: () => true, whenDrained: async () => {} },
          finish: async () => {},
          abort: async () => {},
        }),
      });

      assert.equal(snapshot.sessionSettings.IntervalStyle, "iso_8601");
      assert.equal(snapshot.relations[0]?.rowsReportedByServer, 1);
      assert.equal(snapshot.viewDefinitions.length, 1);
      assert.equal(snapshot.viewDefinitions[0]?.name, "intent_view");
      assert.match(snapshot.viewDefinitions[0]?.definition ?? "", /intent/);
      assert.equal(
        snapshot.viewDefinitions[0]?.sha256,
        createHash("sha256").update(snapshot.viewDefinitions[0]?.definition ?? "", "utf8").digest("hex"),
      );

      const outputRoot = await mkdtemp(join(tmpdir(), "vs-export-sidecar-"));
      try {
        const profile = parseConnectionProfile(
          JSON.stringify({
            profile_version: 1,
            role: "source-read-only",
            label: "schema view sidecar fixture",
            connection: {
              transport: "unix-socket",
              host: HOST,
              port: PORT,
              database: DATABASE,
              user: USER,
            },
            identity: {
              expected_database: DATABASE,
              expected_current_user: USER,
              expect_schemas_present: [SCHEMA],
              expect_schemas_absent: ["app", "ops", "migration"],
            },
          }),
        );
        const run = await runExport({ profile, plan, outputRoot });
        assert.ok(run.schemaViewsSidecarPath);
        assert.equal(`0${((await stat(run.schemaViewsSidecarPath)).mode & 0o777).toString(8)}`, "0600");
        assert.deepEqual((await readdir(run.runDirectory)).sort(), ["manifest.json", "manifest.sha256", "relations"]);

        const sidecar = JSON.parse(await readFile(run.schemaViewsSidecarPath, "utf8")) as {
          run_id: string;
          manifest_sha256: string;
          snapshot: { current_snapshot: string; transaction_start_utc: string };
          views: Array<{ name: string; definition: string; sha256: string }>;
        };
        assert.equal(sidecar.run_id, run.runId);
        assert.equal(sidecar.manifest_sha256, run.manifestSha256);
        assert.equal(sidecar.snapshot.current_snapshot, run.manifest.snapshot.current_snapshot);
        assert.equal(sidecar.snapshot.transaction_start_utc, run.manifest.snapshot.transaction_start_utc);
        assert.equal(sidecar.views.length, 1);
        assert.equal(sidecar.views[0]?.name, "intent_view");
        assert.equal(
          sidecar.views[0]?.sha256,
          createHash("sha256").update(sidecar.views[0]?.definition ?? "", "utf8").digest("hex"),
        );
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
      }
    } finally {
      await connection.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(SCHEMA)} CASCADE`).catch(() => {});
      await connection.close();
    }
  },
);
