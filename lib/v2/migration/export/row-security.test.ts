import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { ExportError } from "../shared/redaction.ts";
import { buildManifest, MANIFEST_VERSION } from "./manifest.ts";
import {
  REQUIRED_TRANSACTION_LOCAL_SETTINGS,
  streamSnapshot,
  type ExportPlan,
  type RelationOutput,
  type RowSecurityEvidence,
} from "./snapshot.ts";
import type { CopySink, QueryResult, WireConnection } from "./wire.ts";

/**
 * The row-visibility guard, driven through `streamSnapshot` against a scripted
 * server.
 *
 * These cover *ordering and refusal*: that the guard is the first thing the
 * transaction does, that a server which does not honour it stops the run before
 * a relation is opened, and that the run cannot finish with a result when the
 * setting moved underneath it. Whether PostgreSQL really errors on a filtered
 * read is not assertable against a fake and is not asserted here - that is
 * proven against a real server, with real non-owner roles and real policies, in
 * `export-snapshot.integration.ts`.
 */

const PLAN: ExportPlan = {
  relations: [
    {
      schema: "public",
      name: "rows_here",
      kind: "r",
      columns: [{ ordinal: 1, name: "id", type: "bigint" }],
    },
  ],
};

const COPY_PAYLOAD = Buffer.from("1\n2\n3\n", "utf8");

type ServerScript = {
  /** What `current_setting('row_security')` returns, by call number (1-based). */
  rowSecurity: (call: number) => string;
  rolsuper?: string | null;
  rolbypassrls?: string | null;
  /** Answer the role-attribute query with no rows, as an unreadable catalog would. */
  roleRowMissing?: boolean;
};

function queryResult(rows: ReadonlyArray<ReadonlyArray<string | null>>): QueryResult {
  return { fields: [], rows, commandTag: "SELECT" };
}

/**
 * A server that answers only what this path needs, and records every statement.
 *
 * Anything unscripted throws rather than returning an empty result: a silent
 * default is how a test quietly stops testing the thing it is named after.
 */
function scriptedConnection(script: ServerScript, log: string[], counters: { opened: number }) {
  let rowSecurityCalls = 0;

  const connection = {
    async query(sql: string): Promise<QueryResult> {
      log.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return queryResult([]);
      if (/^SET /.test(sql)) return queryResult([]);
      if (sql.includes("pg_current_wal_lsn")) throw new ExportError("pg.42501", "no wal access here");
      if (sql.includes("pg_has_role(session_user")) {
        return queryResult([["temporary_login", "temporary_login", "true"]]);
      }
      if (sql.includes("current_user, session_user, r.rolsuper::text")) {
        return queryResult([["supabase_read_only_user", "temporary_login", "false", "true", "on"]]);
      }

      if (sql.includes("r.rolsuper::text")) {
        rowSecurityCalls += 1;
        if (script.roleRowMissing) return queryResult([]);
        return queryResult([
          [
            script.rowSecurity(rowSecurityCalls),
            script.rolsuper === undefined ? "false" : script.rolsuper,
            script.rolbypassrls === undefined ? "false" : script.rolbypassrls,
          ],
        ]);
      }
      if (sql === "SELECT current_setting('row_security')") {
        rowSecurityCalls += 1;
        return queryResult([[script.rowSecurity(rowSecurityCalls)]]);
      }
      if (sql.includes("current_setting('transaction_isolation')")) {
        return queryResult([["repeatable read", "on"]]);
      }
      if (sql.includes("current_setting('TimeZone')")) {
        // The formatting read-back, in REQUIRED_SESSION_SETTINGS order.
        return queryResult([["UTC", "ISO, YMD", "iso_8601", "3", "hex", "UTF8", "off"]]);
      }
      if (sql.includes("pg_current_snapshot()")) {
        return queryResult([
          ["100", "100:100:", null, "2026-09-10T00:00:00.000000Z", "2026-09-10T00:00:00.000000Z", "42"],
        ]);
      }
      if (sql.includes("a.attnum::text")) return queryResult([["1", "id", "bigint", "r"]]);
      throw new Error(`unscripted statement: ${sql}`);
    },

    async copyOut(sql: string, sink: CopySink): Promise<QueryResult> {
      log.push(sql);
      sink.write(COPY_PAYLOAD);
      return { fields: [], rows: [], commandTag: "COPY 3" };
    },
  } as unknown as WireConnection;

  const openRelationOutput = async (): Promise<RelationOutput> => {
    counters.opened += 1;
    return {
      sink: { write: () => true, whenDrained: async () => {} },
      finish: async () => {},
      abort: async () => {},
    };
  };

  return { connection, openRelationOutput };
}

async function run(script: ServerScript, log: string[] = [], counters = { opened: 0 }) {
  const { connection, openRelationOutput } = scriptedConnection(script, log, counters);
  const result = await streamSnapshot(connection, {
    plan: PLAN,
    statementTimeoutMs: 1000,
    openRelationOutput,
  });
  return { result, log, counters };
}

test("an existing Supabase read-only membership is activated transaction-locally before visibility checks", async () => {
  const log: string[] = [];
  const { connection, openRelationOutput } = scriptedConnection({ rowSecurity: () => "off", rolbypassrls: "true" }, log, {
    opened: 0,
  });
  const result = await streamSnapshot(connection, {
    plan: PLAN,
    statementTimeoutMs: 1000,
    activateRole: "supabase_read_only_user",
    expectedSessionUser: "temporary_login",
    openRelationOutput,
  });

  const begin = log.findIndex((sql) => sql.startsWith("BEGIN"));
  const activation = log.findIndex((sql) => sql === 'SET LOCAL ROLE "supabase_read_only_user"');
  const rowSecurity = log.findIndex((sql) => sql === `SET LOCAL "row_security" = 'off'`);
  assert.ok(begin >= 0 && activation > begin && rowSecurity > activation, log.join(" | "));
  assert.equal(result.effectiveUser, "supabase_read_only_user");
  assert.equal(result.sessionUser, "temporary_login");
  assert.equal(result.rowSecurity.roleIsSuperuser, false);
  assert.equal(result.rowSecurity.roleBypassesRowSecurity, true);
});

test("the transaction pins row_security = off, transaction-locally, before it reads anything", async () => {
  const log: string[] = [];
  const { result } = await run({ rowSecurity: () => "off" }, log);

  const begin = log.findIndex((sql) => sql.startsWith("BEGIN"));
  assert.ok(begin >= 0, log.join(" | "));

  // `SET LOCAL`, not `SET`: a session left with row_security off would make
  // ordinary filtered application queries fail long after the export ended.
  assert.equal(log[begin + 1], `SET LOCAL "row_security" = 'off'`);
  assert.deepEqual([...REQUIRED_TRANSACTION_LOCAL_SETTINGS], [["row_security", "off"]]);

  // Nothing that reads the source may appear before the guard is read back. A
  // guard applied after a read says nothing about that read.
  const verified = log.findIndex((sql) => sql.includes("r.rolsuper::text"));
  assert.ok(verified > begin, log.join(" | "));
  for (const sql of log.slice(0, verified + 1)) {
    assert.ok(!sql.startsWith("COPY"), `a relation was read before the guard: ${sql}`);
    assert.ok(!sql.includes("pg_current_snapshot"), `the watermark was taken before the guard: ${sql}`);
    assert.ok(!sql.includes("a.attnum::text"), `the schema was read before the guard: ${sql}`);
  }

  assert.equal(result.rowSecurity.setting, "off");
  assert.equal(result.rowSecurity.settingAtClose, "off");
  assert.equal(result.rowSecurity.roleIsSuperuser, false);
  assert.equal(result.rowSecurity.roleBypassesRowSecurity, false);
});

test("a server that does not honour the setting stops the run before a relation is opened", async () => {
  const log: string[] = [];
  const counters = { opened: 0 };
  await assert.rejects(
    () => run({ rowSecurity: () => "on" }, log, counters),
    (error: unknown) => {
      assert.ok(error instanceof ExportError, String(error));
      assert.equal(error.code, "row_security_not_disabled");
      assert.match(error.message, /silently return a subset/);
      assert.equal(error.details.setting, "on");
      return true;
    },
  );

  assert.equal(counters.opened, 0, "an output file was opened for a refused run");
  assert.ok(!log.some((sql) => sql.startsWith("COPY")), "a relation was copied after the guard failed");
  assert.ok(!log.some((sql) => sql.includes("pg_current_snapshot")), "the run continued past the guard");
  assert.ok(log.includes("ROLLBACK"), log.join(" | "));
});

test("an unexpected row_security answer is refused rather than defaulted", async () => {
  // Including the shapes a careless parser would accept: a different case, a
  // boolean-looking literal, and nothing at all.
  for (const answer of ["", "ON", "Off", "0", "false", "unknown"]) {
    await assert.rejects(
      () => run({ rowSecurity: () => answer }),
      (error: unknown) => error instanceof ExportError && error.code === "row_security_not_disabled",
      `row_security=${JSON.stringify(answer)} was accepted`,
    );
  }
});

test("an unreadable role catalog still has to prove the setting some other way", async () => {
  // No pg_roles row for current_user: the role attributes are unknown, so the
  // setting itself is re-read directly rather than assumed from a missing row.
  const log: string[] = [];
  const { result } = await run({ rowSecurity: () => "off", roleRowMissing: true }, log);
  assert.equal(result.rowSecurity.setting, "off");
  assert.equal(result.rowSecurity.roleIsSuperuser, null);
  assert.equal(result.rowSecurity.roleBypassesRowSecurity, null);
  assert.ok(log.includes("SELECT current_setting('row_security')"), log.join(" | "));

  await assert.rejects(
    () => run({ rowSecurity: () => "on", roleRowMissing: true }),
    (error: unknown) => error instanceof ExportError && error.code === "row_security_not_disabled",
  );
});

test("the setting is re-read after the last relation, and a change invalidates the run", async () => {
  const log: string[] = [];
  await assert.rejects(
    // Off when the guard was applied, on by the closing read: every relation
    // read after the change could have been quietly filtered.
    () => run({ rowSecurity: (call) => (call === 1 ? "off" : "on") }, log),
    (error: unknown) => {
      assert.ok(error instanceof ExportError, String(error));
      assert.equal(error.code, "row_security_changed_mid_export");
      assert.equal(error.details.opening, "off");
      assert.equal(error.details.closing, "on");
      return true;
    },
  );

  // It got as far as copying the relation - and still produced no result.
  assert.ok(log.some((sql) => sql.startsWith("COPY")), log.join(" | "));
  assert.ok(!log.includes("COMMIT"), "a run with a changed guard was committed");
  assert.ok(log.includes("ROLLBACK"), log.join(" | "));
});

test("a role that bypasses policies entirely is recorded rather than hidden", async () => {
  // row_security = off has nothing to catch for such a role. The export is
  // still complete, but it is complete because of a granted privilege and not
  // because this run verified anything, and the manifest has to say so.
  const { result } = await run({ rowSecurity: () => "off", rolsuper: "true", rolbypassrls: "true" });
  assert.equal(result.rowSecurity.roleIsSuperuser, true);
  assert.equal(result.rowSecurity.roleBypassesRowSecurity, true);

  const unknown = await run({ rowSecurity: () => "off", rolsuper: null, rolbypassrls: "maybe" });
  assert.equal(unknown.result.rowSecurity.roleIsSuperuser, null, "unreadable must not become false");
  assert.equal(unknown.result.rowSecurity.roleBypassesRowSecurity, null);
});

test("the manifest carries the effective setting and the version that introduced it", () => {
  const rowSecurity: RowSecurityEvidence = {
    setting: "off",
    settingAtClose: "off",
    roleIsSuperuser: false,
    roleBypassesRowSecurity: false,
  };
  const manifest = buildManifest({
    runId: "run",
    codeRevision: null,
    profile: { label: "l", transport: "unix-socket", host: "/tmp/s", port: 1, database: "d", user: "u" },
    tlsProtocol: null,
    identity: {
      currentDatabase: "d",
      currentUser: "u",
      sessionUser: "u",
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
      currentSnapshot: "1:1:",
      walLsn: null,
      statementStartUtc: "2026-09-10T00:00:00.000000Z",
      transactionStartUtc: "2026-09-10T00:00:00.000000Z",
      backendPid: "1",
    },
    closingSnapshot: "1:1:",
    sessionSettings: { TimeZone: "UTC" },
    rowSecurity,
    walLsnAvailable: false,
    relations: [],
    runDirectoryMode: "0700",
    fileMode: "0600",
    insideGitWorktree: null,
    startedUtc: "2026-09-10T00:00:00.000Z",
    finishedUtc: "2026-09-10T00:00:01.000Z",
    durationMs: 1000,
  });

  assert.equal(MANIFEST_VERSION, 2, "the manifest shape changed; the version must move with it");
  assert.equal(manifest.manifest_version, 2);
  assert.deepEqual(manifest.snapshot.row_security, {
    setting: "off",
    setting_at_close: "off",
    role_is_superuser: false,
    role_bypasses_row_security: false,
  });
});
