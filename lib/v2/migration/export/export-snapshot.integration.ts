import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { ExportError } from "../shared/redaction.ts";
import { parseConnectionProfile, type ConnectionProfile } from "./profile.ts";
import { describePlanFromServer } from "./plan.ts";
import { runExport, removeRunDirectoryForTest } from "./run.ts";
import { WireConnection } from "./wire.ts";
import {
  FAILURE_FILENAME,
  INCOMPLETE_FILENAME,
  MANIFEST_DIGEST_FILENAME,
  MANIFEST_FILENAME,
  type RunManifest,
} from "./manifest.ts";

/**
 * Opt-in. Runs against a disposable local PostgreSQL database that this file
 * never creates, drops or recreates, and that holds only synthetic rows. It
 * touches no VaultShuffle data, no remote service and no M1/M2 evidence
 * database.
 *
 *   VAULTSHUFFLE_M3_EXPORT_INTEGRATION=1 \
 *     node --experimental-strip-types --test \
 *     lib/v2/migration/export/export-snapshot.integration.ts
 */
const ENABLED = process.env.VAULTSHUFFLE_M3_EXPORT_INTEGRATION === "1";

/**
 * Every coordinate of the disposable fixture is overridable.
 *
 * The cluster this suite ran against originally no longer exists, and the local
 * PostgreSQL install has since lost `initdb`, so the fixture has to be stood up
 * at whatever path and port are free. Hard-coding them is what made the previous
 * evidence unrepeatable; the defaults are kept only so an unchanged environment
 * still works.
 */
function fromEnvironment(name: string, fallback: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const SOCKET_DIRECTORY = fromEnvironment("VAULTSHUFFLE_M3_EXPORT_PGHOST", "/tmp/vaultshuffle-pg17-socket");
const PORT = Number.parseInt(fromEnvironment("VAULTSHUFFLE_M3_EXPORT_PGPORT", "55432"), 10);
const ADMIN_USER = fromEnvironment("VAULTSHUFFLE_M3_EXPORT_PGUSER", "vault_local_admin");
const SOURCE_DATABASE = fromEnvironment("VAULTSHUFFLE_M3_EXPORT_SOURCE_DB", "vaultshuffle_m3_export_a");
const TARGET_DATABASE = fromEnvironment("VAULTSHUFFLE_M3_EXPORT_TARGET_DB", "vaultshuffle_m3_export_target");
const PSQL = fromEnvironment("VAULTSHUFFLE_M3_EXPORT_PSQL", "/tmp/vaultshuffle-pg17/bin/psql");

/**
 * A database this suite must never be pointed at.
 *
 * The overrides above make it possible to aim the fixture at any local
 * database, and this suite writes to the source it is given. M1/M2 evidence
 * databases are immutable, so an override naming one stops the run before the
 * first statement rather than mutating somebody else's evidence.
 */
function assertDisposableDatabase(name: string): void {
  if (/^vaultshuffle_m[12](_|$)/.test(name)) {
    throw new Error(
      `Refusing to run the export integration against ${name}: M1/M2 evidence databases are immutable.`,
    );
  }
}
assertDisposableDatabase(SOURCE_DATABASE);
assertDisposableDatabase(TARGET_DATABASE);

const FIXTURE_RELATIONS = ["exp_bulk", "exp_concurrent", "exp_scalars", "exp_view"] as const;

let scratch = "";
let outputRoot = "";

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "vs-m3-export-"));
  outputRoot = join(scratch, "exports");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(outputRoot, { mode: 0o700 }));
});

after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** Run a statement against the fixture with the local client. No credentials exist here. */
function sql(statement: string, database = SOURCE_DATABASE): string {
  const result = spawnSync(PSQL, ["-Atq", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", statement], {
    // Deliberately minimal: nothing from the ambient environment reaches psql except
    // PATH, so a stray PGPASSWORD or service key cannot ride along. NODE_ENV is
    // present only because the project's augmented ProcessEnv requires it.
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: process.env.NODE_ENV ?? "test",
      PGHOST: SOCKET_DIRECTORY,
      PGPORT: String(PORT),
      PGUSER: ADMIN_USER,
    },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `psql failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * Put the mutable part of the fixture back to its documented state.
 *
 * Two tests below deliberately write to the source while a snapshot is open, and
 * both restore what they changed. That is not enough on its own: a run killed
 * part-way through leaves the fixture dirty, and every later run then fails on a
 * row count that has nothing to do with the code under test. Resetting on the
 * way in makes the suite re-runnable after any interruption.
 *
 * Only `exp_concurrent` is ever mutated. The value-fidelity relations are read
 * only, so they are left alone and stay byte-identical between runs.
 */
function resetMutableFixture(): void {
  sql(
    "DELETE FROM public.exp_concurrent; " +
      "INSERT INTO public.exp_concurrent (id, note) " +
      "SELECT g, 'before-export-' || g FROM generate_series(1, 100) AS g;",
  );
  sql("DROP TABLE IF EXISTS public.exp_drift");
}

async function writeProfile(overrides: Record<string, unknown> = {}): Promise<ConnectionProfile> {
  const document = {
    profile_version: 1,
    role: "source-read-only",
    label: "m3-a synthetic fixture",
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
    ...overrides,
  };
  const path = join(scratch, `profile-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  return parseConnectionProfile(await readFile(path, "utf8"));
}

async function connectFixture(database = SOURCE_DATABASE, user = ADMIN_USER): Promise<WireConnection> {
  return WireConnection.connect({
    host: SOCKET_DIRECTORY,
    port: PORT,
    user,
    database,
    password: null,
    tls: { kind: "unix-socket" },
    applicationName: "vaultshuffle-v2-export-test",
    connectTimeoutMs: 10_000,
  });
}

async function fixturePlan(relations: readonly string[] = FIXTURE_RELATIONS) {
  const connection = await connectFixture();
  try {
    return await describePlanFromServer(connection, { schema: "public", relations });
  } finally {
    await connection.close();
  }
}

async function readManifest(runDirectory: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(runDirectory, MANIFEST_FILENAME), "utf8")) as RunManifest;
}

async function modeBits(path: string): Promise<string> {
  return `0${((await stat(path)).mode & 0o7777).toString(8)}`;
}

/** Split a COPY text-format file into rows and fields, decoding the escapes. */
function parseCopyText(text: string): Array<Array<string | null>> {
  if (text.length === 0) return [];
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) =>
      line.split("\t").map((field) => {
        if (field === "\\N") return null;
        return field.replace(/\\(.)/g, (_match, char: string) => {
          if (char === "n") return "\n";
          if (char === "t") return "\t";
          if (char === "r") return "\r";
          if (char === "b") return "\b";
          if (char === "f") return "\f";
          if (char === "v") return "\v";
          return char;
        });
      }),
    );
}

test("streaming snapshot export", { skip: ENABLED ? false : "set VAULTSHUFFLE_M3_EXPORT_INTEGRATION=1" }, async (t) => {
  resetMutableFixture();
  const plan = await fixturePlan();

  /**
   * Guard the guards.
   *
   * Every value-fidelity assertion below only means something because the source
   * database renders these values *wrongly* by default: `fixture.sql` sets
   * hostile per-database defaults so that the exporter's session pinning is what
   * produces the expected output, not the server's own disposition. Without this
   * check the whole block could quietly become vacuous - a friendly default
   * would make the assertions pass while proving nothing - and nobody would
   * notice, because the tests would still be green.
   *
   * If this fails, the fixture was not built by the current `fixture.sql`.
   * Rebuild it; do not relax the assertions it protects.
   */
  await t.test("the fixture renders these values wrongly by default", async () => {
    const observed = sql(
      "SELECT current_setting('TimeZone') || '|' || current_setting('DateStyle') || '|' || " +
        "current_setting('IntervalStyle') || '|' || current_setting('bytea_output') || '|' || " +
        "current_setting('extra_float_digits')",
    ).trim();
    assert.equal(
      observed,
      "America/New_York|SQL, DMY|postgres_verbose|escape|-3",
      "the fixture's hostile database defaults are missing, so the fidelity tests below prove nothing. Rebuild with lib/v2/migration/export/fixture.sql.",
    );

    // Not just configured differently - actually rendering differently. These
    // are the exact values the tests below require the exporter to correct.
    // Each label populates exactly one of these columns, so they are read
    // separately rather than concatenated: one null would blank the whole row.
    const rendered = sql(
      "SELECT coalesce(civil_date::text, '') || coalesce(instant::text, '') || " +
        "coalesce(approx_double::text, '') || coalesce(span::text, '') || coalesce(raw::text, '') " +
        "FROM exp_scalars WHERE label IN ('uk-dst-start', 'sub-second', 'float-precise', 'zero-vs-null') ORDER BY id",
    );
    assert.match(rendered, /29\/03\/2026/, "dates already render ISO, so the civil-date test is vacuous");
    assert.match(rendered, /EDT/, "instants already render UTC, so the DST test is vacuous");
    assert.match(rendered, /1\.23456789012(?!\d)/, "doubles already round-trip, so the float test is vacuous");
    assert.match(rendered, /@ 0/, "intervals already render ISO 8601, so the interval test is vacuous");
    assert.match(rendered, /\\000/, "bytea already renders hex, so the bytea test is vacuous");
  });

  await t.test("a completed run is renamed, sealed and internally consistent", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot, codeRevision: "test" });

    assert.ok(!result.runDirectory.endsWith(".partial"), result.runDirectory);
    const entries = await readdir(result.runDirectory);
    assert.ok(!entries.includes(INCOMPLETE_FILENAME), entries.join(","));
    assert.ok(!entries.includes(FAILURE_FILENAME), entries.join(","));
    assert.ok(entries.includes(MANIFEST_FILENAME));

    // The recorded digest must match the manifest bytes actually on disk.
    const manifestText = await readFile(join(result.runDirectory, MANIFEST_FILENAME), "utf8");
    assert.equal(createHash("sha256").update(manifestText, "utf8").digest("hex"), result.manifestSha256);
    const digestFile = await readFile(join(result.runDirectory, MANIFEST_DIGEST_FILENAME), "utf8");
    assert.equal(digestFile.trim(), `${result.manifestSha256}  ${MANIFEST_FILENAME}`);

    const manifest = await readManifest(result.runDirectory);
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.snapshot.isolation, "repeatable read");
    assert.equal(manifest.snapshot.read_only, true);
    assert.equal(manifest.snapshot.session_settings.TimeZone, "UTC");
    assert.equal(manifest.snapshot.session_settings.DateStyle, "ISO, YMD");
    assert.equal(manifest.snapshot.session_settings.synchronize_seqscans, "off");
    assert.match(manifest.snapshot.snapshot_xmin, /^\d+$/);
    assert.equal(manifest.snapshot.current_snapshot, manifest.snapshot.closing_snapshot);
    assert.match(manifest.snapshot.statement_start_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.equal(manifest.source.identity.currentDatabase, SOURCE_DATABASE);
    assert.equal(manifest.totals.relations, FIXTURE_RELATIONS.length);

    const expectedRows: Record<string, number> = {
      exp_bulk: 60_000,
      exp_concurrent: 100,
      exp_scalars: 30,
      exp_view: 29,
    };
    for (const relation of manifest.relations) {
      assert.equal(
        relation.rowsCountedOnWire,
        relation.rowsReportedByServer,
        `${relation.name}: wire count and server tag disagree`,
      );
      assert.equal(relation.rowsReportedByServer, expectedRows[relation.name], relation.name);
      assert.match(relation.sha256, /^[0-9a-f]{64}$/);

      // The digest is over the bytes on disk, not over a re-encoding.
      const bytes = await readFile(join(result.runDirectory, relation.file));
      assert.equal(bytes.length, relation.bytes, relation.name);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), relation.sha256, relation.name);
    }
  });

  await t.test("output permissions are owner-only throughout", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot });
    assert.equal(await modeBits(result.runDirectory), "0700");
    assert.equal(await modeBits(join(result.runDirectory, "relations")), "0700");
    assert.equal(await modeBits(join(result.runDirectory, MANIFEST_FILENAME)), "0600");
    for (const relation of result.manifest.relations) {
      assert.equal(await modeBits(join(result.runDirectory, relation.file)), "0600");
    }
  });

  await t.test("concurrent writes during the export are not in the export", async () => {
    const before = sql("SELECT count(*)::text FROM public.exp_concurrent").trim();
    assert.equal(before, "100");

    let wroteDuringExport = false;
    const result = await runExport({
      profile: await writeProfile(),
      plan,
      outputRoot,
      // exp_bulk sorts first, so this fires inside the open snapshot and before
      // exp_concurrent is streamed.
      onRelationComplete: async (relation) => {
        if (relation.name !== "exp_bulk" || wroteDuringExport) return;
        wroteDuringExport = true;
        sql(
          "INSERT INTO public.exp_concurrent (id, note) " +
            "SELECT g, 'DURING-EXPORT-' || g FROM generate_series(1001, 1050) AS g; " +
            "DELETE FROM public.exp_concurrent WHERE id <= 10; " +
            "UPDATE public.exp_concurrent SET note = 'MUTATED-DURING-EXPORT' WHERE id BETWEEN 11 AND 20;",
        );
      },
    });

    assert.ok(wroteDuringExport, "the concurrent write never ran");

    // The writes really did land, so this is a genuine race and not a no-op.
    assert.equal(sql("SELECT count(*)::text FROM public.exp_concurrent").trim(), "140");
    assert.equal(
      sql("SELECT count(*)::text FROM public.exp_concurrent WHERE note LIKE 'DURING-EXPORT-%'").trim(),
      "50",
    );

    const exported = await readFile(
      join(result.runDirectory, "relations", "public.exp_concurrent.copy"),
      "utf8",
    );
    const rows = parseCopyText(exported);
    assert.equal(rows.length, 100, "the export saw the pre-write row count");
    assert.ok(!exported.includes("DURING-EXPORT-"), "an inserted row leaked into the snapshot");
    assert.ok(!exported.includes("MUTATED-DURING-EXPORT"), "an updated row leaked into the snapshot");
    // The deleted rows are still present, because they existed in the snapshot.
    const ids = new Set(rows.map((row) => row[0]));
    for (let id = 1; id <= 10; id += 1) assert.ok(ids.has(String(id)), `deleted row ${id} vanished`);

    const manifest = await readManifest(result.runDirectory);
    const relation = manifest.relations.find((entry) => entry.name === "exp_concurrent");
    assert.equal(relation?.rowsReportedByServer, 100);

    // Put the fixture back so later subtests see the documented counts.
    resetMutableFixture();
  });

  await t.test("an aborted run stays unmistakably incomplete and is never renamed", async () => {
    const before = await readdir(outputRoot);
    await assert.rejects(
      async () =>
        runExport({
          profile: await writeProfile(),
          plan,
          outputRoot,
          onRelationComplete: (relation) => {
            if (relation.name === "exp_bulk") throw new Error("simulated operator abort");
          },
        }),
      /simulated operator abort/,
    );

    const after = await readdir(outputRoot);
    const created = after.filter((entry) => !before.includes(entry));
    assert.equal(created.length, 1, created.join(","));
    const partial = created[0];
    assert.ok(partial.endsWith(".partial"), partial);
    assert.ok(!after.includes(partial.replace(/\.partial$/, "")), "a partial run was also renamed");

    const runDirectory = join(outputRoot, partial);
    const entries = await readdir(runDirectory);
    assert.ok(entries.includes(INCOMPLETE_FILENAME), entries.join(","));
    assert.ok(entries.includes(FAILURE_FILENAME), entries.join(","));
    assert.ok(!entries.includes(MANIFEST_FILENAME), "a failed run must not carry a manifest");

    const failure = JSON.parse(await readFile(join(runDirectory, FAILURE_FILENAME), "utf8")) as {
      status: string;
      code: string;
      message: string;
    };
    assert.equal(failure.status, "failed");
    assert.equal(failure.code, "unexpected_error");
    assert.equal(failure.message, "simulated operator abort");

    // The partial bytes are still there. They are evidence, not a resumable export.
    const relations = await readdir(join(runDirectory, "relations"));
    assert.ok(relations.includes("public.exp_bulk.copy"));
    await removeRunDirectoryForTest(runDirectory);
  });

  await t.test("a mid-COPY failure closes the output and stays incomplete", async () => {
    const before = await readdir(outputRoot);
    const profile = await writeProfile();
    const plan = await fixturePlan(["exp_bulk"]);
    let streamedBytes = 0;
    await assert.rejects(
      () =>
        runExport({
          profile,
          plan,
          outputRoot,
          onCopyChunk: (relation, chunk) => {
            if (relation.name !== "exp_bulk") return;
            streamedBytes += chunk.length;
            if (streamedBytes > 100_000) throw new Error("simulated mid-copy abort");
          },
        }),
      /simulated mid-copy abort/,
    );

    assert.ok(streamedBytes > 100_000, `COPY never crossed the abort threshold: ${streamedBytes}`);
    const created = (await readdir(outputRoot)).filter((entry) => !before.includes(entry));
    assert.equal(created.length, 1, created.join(","));
    assert.ok(created[0].endsWith(".partial"), created[0]);
    const runDirectory = join(outputRoot, created[0]);
    const entries = await readdir(runDirectory);
    assert.ok(entries.includes(INCOMPLETE_FILENAME), entries.join(","));
    assert.ok(entries.includes(FAILURE_FILENAME), entries.join(","));
    assert.ok(!entries.includes(MANIFEST_FILENAME), "a mid-copy failure must not carry a manifest");

    const partial = await readFile(join(runDirectory, "relations", "public.exp_bulk.copy"));
    assert.ok(partial.length > 0, "the failure should retain partial relation evidence");
    assert.ok(partial.length < 13_000_000, "the failure unexpectedly wrote the complete fixture");

    // This also proves the stream/descriptor was closed: the failed tree can be
    // removed immediately, and no retry reuses any of its files.
    await removeRunDirectoryForTest(runDirectory);
  });

  await t.test("a restart takes a new snapshot and never reuses a directory", async () => {
    const first = await runExport({ profile: await writeProfile(), plan, outputRoot });
    sql("INSERT INTO public.exp_concurrent (id, note) VALUES (2001, 'between-runs')");
    const second = await runExport({ profile: await writeProfile(), plan, outputRoot });

    assert.notEqual(first.runId, second.runId);
    assert.notEqual(first.runDirectory, second.runDirectory);
    assert.notEqual(
      first.manifest.snapshot.current_snapshot,
      second.manifest.snapshot.current_snapshot,
      "the second run reused the first run's snapshot",
    );

    const firstCount = first.manifest.relations.find((r) => r.name === "exp_concurrent")?.rowsReportedByServer;
    const secondCount = second.manifest.relations.find((r) => r.name === "exp_concurrent")?.rowsReportedByServer;
    assert.equal(firstCount, 100);
    assert.equal(secondCount, 101);

    sql("DELETE FROM public.exp_concurrent WHERE id = 2001");
  });

  await t.test("two runs over unchanged data produce identical wire digests", async () => {
    const first = await runExport({ profile: await writeProfile(), plan, outputRoot });
    const second = await runExport({ profile: await writeProfile(), plan, outputRoot });
    for (const relation of first.manifest.relations) {
      const other = second.manifest.relations.find((entry) => entry.name === relation.name);
      assert.equal(other?.sha256, relation.sha256, `${relation.name} digest is not reproducible`);
      assert.equal(other?.bytes, relation.bytes, relation.name);
    }
  });

  await t.test("null, empty string and zero survive as three different things", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot });
    const raw = await readFile(join(result.runDirectory, "relations", "public.exp_scalars.copy"), "utf8");
    const rows = parseCopyText(raw);
    const byId = new Map(rows.map((row) => [row[0], row] as const));

    const nulls = byId.get("1");
    assert.ok(nulls);
    assert.equal(nulls[1], null, "a NULL text column must stay null");
    assert.equal(nulls[2], null, "a NULL numeric must stay null");
    // On the wire that null is the two characters \N, not an empty field.
    assert.ok(raw.split("\n")[0].includes("\\N"));

    const empties = byId.get("2");
    assert.ok(empties);
    assert.equal(empties[1], "", "an empty string must stay an empty string");
    assert.equal(empties[2], "0.0000000000", "numeric zero must stay zero at its declared scale");
    assert.notEqual(empties[1], empties[2]);
    assert.notEqual(empties[1], null);
  });

  await t.test("signed bigint bounds survive without precision loss", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot });
    const raw = await readFile(join(result.runDirectory, "relations", "public.exp_scalars.copy"), "utf8");
    const rows = parseCopyText(raw);
    const ids = rows.map((row) => row[0]);

    assert.ok(ids.includes("-9223372036854775808"), "bigint minimum was not exported exactly");
    assert.ok(ids.includes("9223372036854775807"), "bigint maximum was not exported exactly");
    // The values above are not representable as JavaScript numbers, which is
    // exactly why the exporter must never parse them.
    assert.notEqual(String(Number("9223372036854775807")), "9223372036854775807");

    const wide = rows.find((row) => row[1] === "numeric-wide");
    assert.equal(wide?.[2], "1234567890123456789012345678.0123456789");
    const min = rows.find((row) => row[1] === "bigint-min");
    assert.equal(min?.[2], "9007199254740993.0000000000");
  });

  await t.test("doubles round-trip and civil dates stay civil", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot });
    const rows = parseCopyText(
      await readFile(join(result.runDirectory, "relations", "public.exp_scalars.copy"), "utf8"),
    );
    const byLabel = new Map(rows.map((row) => [row[1], row] as const));

    assert.equal(byLabel.get("float-roundtrip")?.[4], "0.1");
    assert.equal(byLabel.get("float-precise")?.[4], "1.2345678901234567");
    assert.equal(Number(byLabel.get("float-precise")?.[4]), 1.2345678901234567);

    // A date has no zone, so it must not shift and must not gain a time.
    assert.equal(byLabel.get("leap-day")?.[6], "2024-02-29");
    assert.equal(byLabel.get("uk-dst-start")?.[6], "2026-03-29");
    assert.equal(byLabel.get("uk-dst-end")?.[6], "2026-10-25");
    assert.equal(byLabel.get("us-dst-start")?.[6], "2026-03-08");
    assert.equal(byLabel.get("year-boundary")?.[6], "2025-12-31");
    for (const label of ["leap-day", "uk-dst-start", "uk-dst-end"]) {
      assert.match(byLabel.get(label)?.[6] ?? "", /^\d{4}-\d{2}-\d{2}$/, label);
    }
  });

  await t.test("instants export as UTC across both DST boundaries", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot });
    const rows = parseCopyText(
      await readFile(join(result.runDirectory, "relations", "public.exp_scalars.copy"), "utf8"),
    );
    const instantOf = (label: string) => rows.find((row) => row[1] === label)?.[7];

    assert.equal(instantOf("uk-dst-spring-forward"), "2026-03-29 00:59:59+00");
    assert.equal(instantOf("uk-dst-after"), "2026-03-29 01:00:00+00");
    assert.equal(instantOf("uk-dst-fall-back"), "2026-10-25 01:59:59+00");
    // Stored from a local wall clock in America/New_York, on the day the clocks
    // move. Both must come back as the correct UTC instant.
    assert.equal(instantOf("us-eastern-local"), "2026-03-08 06:59:59+00");
    assert.equal(instantOf("us-eastern-after"), "2026-03-08 07:00:00+00");
    assert.equal(instantOf("sub-second"), "2026-07-04 12:34:56.789012+00");
    assert.equal(instantOf("far-future"), "2999-12-31 23:59:59+00");
    assert.equal(instantOf("pre-epoch"), "1969-07-20 20:17:40+00");

    for (const row of rows) {
      if (row[7] !== null) assert.match(row[7], /\+00$/, `${row[1]} did not render as UTC`);
    }
  });

  await t.test("interval, bytea, naive timestamp, jsonb and uuid are pinned too", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot });
    const raw = await readFile(join(result.runDirectory, "relations", "public.exp_scalars.copy"), "utf8");
    const rows = parseCopyText(raw);
    const row = rows.find((entry) => entry[0] === "3");
    assert.ok(row, "the zero-vs-null row is missing from the fixture");

    // The server would render this "@ 0" under the fixture's IntervalStyle.
    // iso_8601 is the only rendering a non-PostgreSQL loader can be expected to
    // parse, which is why the exporter pins it.
    assert.equal(row[9], "PT0S", "interval did not export in ISO 8601 form");

    // Hex, not the fixture's `escape` default, which would render this \000 and
    // is ambiguous with a text backslash sequence.
    assert.equal(row[11], "\\x00", "bytea did not export in hex form");

    // A timestamp *without* time zone must not acquire one, and must not shift.
    assert.equal(row[8], "2026-01-01 00:00:00", "naive timestamp gained a zone or shifted");

    assert.equal(row[12], '{"a": null}', "jsonb did not round-trip");
    assert.equal(row[13], "11111111-1111-1111-1111-111111111111", "uuid did not round-trip");
    assert.equal(row[10], "f", "boolean did not round-trip");

    // The empty-bytea row is a distinct thing from a null one.
    const empty = rows.find((entry) => entry[0] === "2");
    assert.equal(empty?.[11], "\\x", "empty bytea did not stay an empty bytea");
    assert.notEqual(empty?.[11], null);
  });

  await t.test("text escapes round-trip, including a field that looks like a null", async () => {
    const result = await runExport({ profile: await writeProfile(), plan, outputRoot });
    const rows = parseCopyText(
      await readFile(join(result.runDirectory, "relations", "public.exp_scalars.copy"), "utf8"),
    );
    const labels = rows.map((row) => row[1]);
    assert.ok(labels.includes("tab\there"));
    assert.ok(labels.includes("newline\nhere"));
    assert.ok(labels.includes("backslash\\here"));
    assert.ok(labels.includes("unicode: café 🎮 ждать"));
    // The literal two-character sequence \N is escaped on the wire, so it does
    // not decode back to a null.
    assert.ok(labels.includes("\\N literal-looking"));
    assert.ok(labels.includes("   leading and trailing   "));
  });

  await t.test("pointing the exporter at the migration destination fails closed", async () => {
    const profile = await writeProfile({
      connection: {
        transport: "unix-socket",
        host: SOCKET_DIRECTORY,
        port: PORT,
        database: TARGET_DATABASE,
        user: ADMIN_USER,
      },
      identity: {
        expected_database: TARGET_DATABASE,
        expected_current_user: ADMIN_USER,
        expect_schemas_present: ["public"],
        expect_schemas_absent: ["app", "ops", "migration"],
      },
    });

    const before = await readdir(outputRoot);
    await assert.rejects(
      () => runExport({ profile, plan, outputRoot }),
      (error: unknown) => {
        assert.ok(error instanceof ExportError, String(error));
        assert.equal(error.code, "identity_destination_detected");
        assert.match(error.message, /migration destination/);
        return true;
      },
    );

    // It failed before any relation was read.
    const created = (await readdir(outputRoot)).filter((entry) => !before.includes(entry));
    assert.equal(created.length, 1);
    const relations = await readdir(join(outputRoot, created[0], "relations"));
    assert.deepEqual(relations, []);
    await removeRunDirectoryForTest(join(outputRoot, created[0]));
  });

  await t.test("a wrong expected database fails closed", async () => {
    const profile = await writeProfile({
      identity: {
        expected_database: "vaultshuffle_m1_final",
        expected_current_user: ADMIN_USER,
        expect_schemas_present: ["public"],
        expect_schemas_absent: ["app"],
      },
    });
    await assert.rejects(
      () => runExport({ profile, plan, outputRoot }),
      (error: unknown) => {
        assert.ok(error instanceof ExportError);
        assert.equal(error.code, "identity_mismatch");
        return true;
      },
    );
  });

  await t.test("schema drift since the plan was captured fails closed", async () => {
    sql("DROP TABLE IF EXISTS public.exp_drift; CREATE TABLE public.exp_drift (id bigint, note text)");
    const driftPlan = await fixturePlan(["exp_drift"]);
    sql("ALTER TABLE public.exp_drift ADD COLUMN added_later text");

    await assert.rejects(
      async () => runExport({ profile: await writeProfile(), plan: driftPlan, outputRoot }),
      (error: unknown) => {
        assert.ok(error instanceof ExportError, String(error));
        assert.equal(error.code, "schema_drift");
        return true;
      },
    );

    sql("ALTER TABLE public.exp_drift DROP COLUMN added_later; ALTER TABLE public.exp_drift ALTER COLUMN note TYPE varchar(50)");
    await assert.rejects(
      async () => runExport({ profile: await writeProfile(), plan: driftPlan, outputRoot }),
      (error: unknown) => {
        assert.ok(error instanceof ExportError, String(error));
        assert.equal(error.code, "schema_drift");
        assert.match(error.message, /character varying\(50\)/);
        return true;
      },
    );

    sql("DROP TABLE public.exp_drift");
    await assert.rejects(
      async () => runExport({ profile: await writeProfile(), plan: driftPlan, outputRoot }),
      (error: unknown) => {
        assert.ok(error instanceof ExportError, String(error));
        assert.equal(error.code, "relation_missing");
        return true;
      },
    );
  });

  await t.test("server error fields cannot enter FAILED.json", async () => {
    const sentinel = "private-row-sentinel-in-error-fields-4e9c";
    sql(
      "CREATE OR REPLACE FUNCTION public.exp_private_error() RETURNS text " +
        "LANGUAGE plpgsql AS $fn$ BEGIN " +
        `RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = '${sentinel}', ` +
        `DETAIL = 'detail-${sentinel}', HINT = 'hint-${sentinel}'; END $fn$; ` +
        "CREATE OR REPLACE VIEW public.exp_server_error AS " +
        "SELECT public.exp_private_error() AS secret;",
    );
    try {
      const plan = await fixturePlan(["exp_server_error"]);
      const before = await readdir(outputRoot);
      let thrown: unknown;
      await assert.rejects(
        async () => runExport({ profile: await writeProfile(), plan, outputRoot }),
        (error: unknown) => {
          thrown = error;
          return error instanceof ExportError && error.code === "pg.unknown";
        },
      );

      assert.ok(thrown instanceof ExportError);
      assert.equal(thrown.message, "PostgreSQL refused the statement.");
      assert.ok(!String(thrown).includes(sentinel));
      assert.ok(!JSON.stringify(thrown).includes(sentinel));

      const created = (await readdir(outputRoot)).filter((entry) => !before.includes(entry));
      assert.equal(created.length, 1, created.join(","));
      assert.ok(created[0].endsWith(".partial"), created[0]);
      const runDirectory = join(outputRoot, created[0]);
      const failureText = await readFile(join(runDirectory, FAILURE_FILENAME), "utf8");
      const failure = JSON.parse(failureText) as { code: string; message: string };
      assert.equal(failure.code, "pg.unknown");
      assert.equal(failure.message, "PostgreSQL refused the statement.");
      assert.ok(!failureText.includes(sentinel), "server M/D/H/context leaked into FAILED.json");
      await removeRunDirectoryForTest(runDirectory);
    } finally {
      sql("DROP VIEW IF EXISTS public.exp_server_error; DROP FUNCTION IF EXISTS public.exp_private_error();");
    }
  });

  await t.test("the exporter never writes to the source", async () => {
    const connection = await connectFixture();
    try {
      await connection.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await assert.rejects(
        () => connection.query("CREATE TABLE public.exp_should_not_exist (id int)"),
        (error: unknown) => {
          assert.ok(error instanceof ExportError, String(error));
          assert.equal(error.code, "pg.25006");
          return true;
        },
      );
      await connection.query("ROLLBACK");
    } finally {
      await connection.close();
    }
    assert.equal(
      sql("SELECT count(*)::text FROM pg_class WHERE relname = 'exp_should_not_exist'").trim(),
      "0",
    );
  });

  await t.test("row-level security cannot silently shrink an export", async (rls) => {
    /**
     * The hole this closes.
     *
     * Every other check in this suite is satisfied by a policy-filtered read.
     * The COPY completes, the wire row count matches the server's `COPY n` tag,
     * the digest is internally consistent, the snapshot is stable, the schema
     * matched - and the manifest says "complete" about a fraction of a
     * relation. Nothing on the wire distinguishes 40 rows admitted by a policy
     * from a relation that only has 40 rows.
     *
     * So this block does not test the exporter's opinion of RLS. It builds real
     * policies, connects as a real `NOSUPERUSER NOBYPASSRLS` role that really
     * does see a subset, measures that subset first, and then requires the
     * exporter to fail rather than to publish it.
     */
    const READER = "exp_rls_reader";
    const OWNER = "exp_rls_owner";

    /**
     * Torn down in the `finally` below, so the source fixture goes back to
     * exactly what `fixture.sql` builds. The roles are cluster-wide, so they
     * are dropped by name and only ever created here.
     */
    function buildRlsFixture(): void {
      dropRlsFixture();
      sql(
        `CREATE ROLE ${READER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT; ` +
          `CREATE ROLE ${OWNER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;`,
      );

      // 1. A selective policy: the reader is admitted to 40 of 100 rows.
      sql(
        "CREATE TABLE public.exp_rls_selective (id bigint PRIMARY KEY, visibility text NOT NULL, note text NOT NULL); " +
          "INSERT INTO public.exp_rls_selective (id, visibility, note) " +
          "SELECT g, CASE WHEN g <= 40 THEN 'visible' ELSE 'hidden' END, 'note-' || g " +
          "FROM generate_series(1, 100) AS g; " +
          "ALTER TABLE public.exp_rls_selective ENABLE ROW LEVEL SECURITY; " +
          `CREATE POLICY exp_rls_selective_read ON public.exp_rls_selective FOR SELECT TO ${READER} ` +
          "USING (visibility = 'visible'); " +
          `GRANT SELECT ON public.exp_rls_selective TO ${READER};`,
      );

      // 2. Default deny: row security on, no policy at all. The reader holds
      //    SELECT and still sees nothing, with no error and no warning.
      sql(
        "CREATE TABLE public.exp_rls_denied (id bigint PRIMARY KEY, note text NOT NULL); " +
          "INSERT INTO public.exp_rls_denied (id, note) SELECT g, 'denied-' || g FROM generate_series(1, 25) AS g; " +
          "ALTER TABLE public.exp_rls_denied ENABLE ROW LEVEL SECURITY; " +
          `GRANT SELECT ON public.exp_rls_denied TO ${READER};`,
      );

      // 3. FORCE: the relation's own owner is subject to its policies. An
      //    exporter that assumed "connect as the owner" means "see everything"
      //    is wrong here, and wrong silently.
      sql(
        "CREATE TABLE public.exp_rls_forced (id bigint PRIMARY KEY, visibility text NOT NULL); " +
          "INSERT INTO public.exp_rls_forced (id, visibility) " +
          "SELECT g, CASE WHEN g <= 12 THEN 'visible' ELSE 'hidden' END FROM generate_series(1, 30) AS g; " +
          `ALTER TABLE public.exp_rls_forced OWNER TO ${OWNER}; ` +
          "ALTER TABLE public.exp_rls_forced ENABLE ROW LEVEL SECURITY; " +
          "ALTER TABLE public.exp_rls_forced FORCE ROW LEVEL SECURITY; " +
          "CREATE POLICY exp_rls_forced_read ON public.exp_rls_forced FOR SELECT TO PUBLIC " +
          "USING (visibility = 'visible');",
      );

      // 4. The control: no row security anywhere near it. The same restricted
      //    reader must export this in full, or the guard is just a refusal.
      sql(
        "CREATE TABLE public.exp_rls_open (id bigint PRIMARY KEY, note text NOT NULL); " +
          "INSERT INTO public.exp_rls_open (id, note) SELECT g, 'open-' || g FROM generate_series(1, 64) AS g; " +
          `GRANT SELECT ON public.exp_rls_open TO ${READER};`,
      );
    }

    function dropRlsFixture(): void {
      sql(
        "DROP TABLE IF EXISTS public.exp_rls_selective, public.exp_rls_denied, " +
          "public.exp_rls_forced, public.exp_rls_open CASCADE;",
      );
      sql(
        "DO $do$ DECLARE r text; BEGIN " +
          `FOREACH r IN ARRAY ARRAY['${READER}', '${OWNER}'] LOOP ` +
          "IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN " +
          "EXECUTE format('DROP OWNED BY %I', r); EXECUTE format('DROP ROLE %I', r); " +
          "END IF; END LOOP; END $do$;",
      );
    }

    /** What this role actually sees with row security left on, over the exporter's own client. */
    async function visibleRowCount(user: string, relation: string): Promise<number> {
      const connection = await connectFixture(SOURCE_DATABASE, user);
      try {
        await connection.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        await connection.query("SET LOCAL row_security = 'on'");
        const result = await connection.query(`SELECT count(*)::text FROM public.${relation}`);
        await connection.query("ROLLBACK");
        return Number.parseInt(result.rows[0]?.[0] ?? "-1", 10);
      } finally {
        await connection.close();
      }
    }

    async function profileFor(user: string): Promise<ConnectionProfile> {
      return writeProfile({
        connection: {
          transport: "unix-socket",
          host: SOCKET_DIRECTORY,
          port: PORT,
          database: SOURCE_DATABASE,
          user,
        },
        identity: {
          expected_database: SOURCE_DATABASE,
          expected_current_user: user,
          expect_schemas_present: ["public"],
          expect_schemas_absent: ["app", "ops", "migration"],
        },
      });
    }

    /** Run an export that must fail, and return the partial run it left behind. */
    async function refusedRun(user: string, relations: readonly string[]): Promise<string> {
      const plan = await fixturePlan(relations);
      const before = await readdir(outputRoot);
      await assert.rejects(
        async () => runExport({ profile: await profileFor(user), plan, outputRoot }),
        (error: unknown) => {
          assert.ok(error instanceof ExportError, String(error));
          // 42501 insufficient_privilege: "query would be affected by
          // row-level security policy for table ...". The server's own text is
          // dropped by the redaction layer, so the SQLSTATE is what identifies it.
          assert.equal(error.code, "pg.42501", error.message);
          assert.equal(error.details.sqlstate, "42501");
          return true;
        },
      );

      const created = (await readdir(outputRoot)).filter((entry) => !before.includes(entry));
      assert.equal(created.length, 1, created.join(","));
      assert.ok(created[0].endsWith(".partial"), created[0]);
      const runDirectory = join(outputRoot, created[0]);
      const entries = await readdir(runDirectory);
      assert.ok(!entries.includes(MANIFEST_FILENAME), "a policy-filtered run published a manifest");
      assert.ok(!entries.includes(MANIFEST_DIGEST_FILENAME), entries.join(","));
      assert.ok(entries.includes(INCOMPLETE_FILENAME), entries.join(","));
      assert.ok(entries.includes(FAILURE_FILENAME), entries.join(","));
      return runDirectory;
    }

    buildRlsFixture();
    try {
      await rls.test("the fixture really does hand this role a subset", async () => {
        // Without this, every assertion below could be passing because the
        // policies do nothing. These are the exact numbers the exporter must
        // refuse to publish.
        assert.equal(sql("SELECT count(*)::text FROM public.exp_rls_selective").trim(), "100");
        assert.equal(await visibleRowCount(READER, "exp_rls_selective"), 40, "the selective policy admits everything");

        assert.equal(sql("SELECT count(*)::text FROM public.exp_rls_denied").trim(), "25");
        assert.equal(await visibleRowCount(READER, "exp_rls_denied"), 0, "default-deny is not denying");

        assert.equal(sql("SELECT count(*)::text FROM public.exp_rls_forced").trim(), "30");
        assert.equal(await visibleRowCount(OWNER, "exp_rls_forced"), 12, "FORCE is not binding the owner");

        // And the roles really are restricted: no superuser, no BYPASSRLS.
        const attributes = sql(
          "SELECT rolname || '=' || rolsuper::text || ',' || rolbypassrls::text FROM pg_roles " +
            `WHERE rolname IN ('${READER}', '${OWNER}') ORDER BY rolname`,
        ).trim();
        assert.equal(attributes, `${OWNER}=false,false\n${READER}=false,false`);
      });

      await rls.test("a selective policy makes the export fail instead of shrink", async () => {
        const runDirectory = await refusedRun(READER, ["exp_rls_selective"]);

        // Not one row of the 40 the policy would have admitted was written.
        const partial = await stat(join(runDirectory, "relations", "public.exp_rls_selective.copy"));
        assert.equal(partial.size, 0, "a policy-filtered subset reached the output file");

        const failure = JSON.parse(await readFile(join(runDirectory, FAILURE_FILENAME), "utf8")) as {
          code: string;
        };
        assert.equal(failure.code, "pg.42501");
        await removeRunDirectoryForTest(runDirectory);
      });

      await rls.test("default-deny row security cannot finalize as an empty export", async () => {
        // The dangerous shape: 0 rows is a perfectly valid COPY stream, so
        // without the guard this would have produced a sealed, checksummed,
        // internally consistent manifest describing an empty relation.
        const runDirectory = await refusedRun(READER, ["exp_rls_denied"]);
        assert.equal((await stat(join(runDirectory, "relations", "public.exp_rls_denied.copy"))).size, 0);
        await removeRunDirectoryForTest(runDirectory);
      });

      await rls.test("FORCE row security binds the relation's own owner too", async () => {
        const runDirectory = await refusedRun(OWNER, ["exp_rls_forced"]);
        assert.equal((await stat(join(runDirectory, "relations", "public.exp_rls_forced.copy"))).size, 0);
        await removeRunDirectoryForTest(runDirectory);
      });

      await rls.test("one filtered relation invalidates the whole run, not just its file", async () => {
        // exp_rls_open sorts first and streams completely; exp_rls_selective
        // then fails. A run that sealed what it had would be the worst outcome
        // of all: a manifest that is correct about one relation and silently
        // wrong about the export.
        const runDirectory = await refusedRun(READER, ["exp_rls_open", "exp_rls_selective"]);
        const complete = await stat(join(runDirectory, "relations", "public.exp_rls_open.copy"));
        assert.ok(complete.size > 0, "the unfiltered relation never streamed, so this proves nothing");
        assert.equal((await stat(join(runDirectory, "relations", "public.exp_rls_selective.copy"))).size, 0);
        assert.ok(!runDirectory.replace(/\.partial$/, "").endsWith(".partial"));
        await removeRunDirectoryForTest(runDirectory);
      });

      await rls.test("the same restricted role exports an unfiltered relation in full", async () => {
        const plan = await fixturePlan(["exp_rls_open"]);
        const result = await runExport({ profile: await profileFor(READER), plan, outputRoot });

        assert.ok(!result.runDirectory.endsWith(".partial"), result.runDirectory);
        const manifest = await readManifest(result.runDirectory);
        assert.equal(manifest.status, "complete");
        assert.equal(manifest.manifest_version, 2);
        assert.equal(manifest.source.identity.currentUser, READER);

        // Every row, exported by a role that a policy elsewhere restricts.
        const relation = manifest.relations[0];
        assert.equal(relation.rowsReportedByServer, 64);
        assert.equal(relation.rowsCountedOnWire, 64);
        assert.equal(
          parseCopyText(await readFile(join(result.runDirectory, relation.file), "utf8")).length,
          64,
        );

        // And the manifest records why it may claim that.
        assert.deepEqual(manifest.snapshot.row_security, {
          setting: "off",
          setting_at_close: "off",
          role_is_superuser: false,
          role_bypasses_row_security: false,
        });
      });

      await rls.test("the guard does not outlive the transaction it guards", async () => {
        // `SET LOCAL`, so a connection handed on afterwards is not left in a
        // state where ordinary filtered queries raise instead of filtering.
        const connection = await connectFixture(SOURCE_DATABASE, READER);
        try {
          await connection.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
          await connection.query("SET LOCAL row_security = 'off'");
          assert.equal((await connection.query("SELECT current_setting('row_security')")).rows[0]?.[0], "off");
          await connection.query("COMMIT");
          assert.equal((await connection.query("SELECT current_setting('row_security')")).rows[0]?.[0], "on");

          // Which is to say: the very read the exporter refuses is available
          // again, filtered, to whatever uses this session next.
          assert.equal(
            (await connection.query("SELECT count(*)::text FROM public.exp_rls_selective")).rows[0]?.[0],
            "40",
          );
        } finally {
          await connection.close();
        }
      });
    } finally {
      dropRlsFixture();
    }

    // The source fixture is back to what fixture.sql builds.
    assert.equal(
      sql(
        "SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
          "WHERE n.nspname = 'public' AND c.relname LIKE 'exp\\_rls\\_%'",
      ).trim(),
      "0",
    );
    assert.equal(
      sql(`SELECT count(*)::text FROM pg_roles WHERE rolname IN ('${READER}', '${OWNER}')`).trim(),
      "0",
    );
  });

  await t.test("a large relation streams without buffering itself in memory", async () => {
    const bulkOnly = await fixturePlan(["exp_bulk"]);
    if (typeof global.gc === "function") global.gc();
    const before = process.memoryUsage().heapUsed;
    const result = await runExport({ profile: await writeProfile(), plan: bulkOnly, outputRoot });
    const after = process.memoryUsage().heapUsed;

    const relation = result.manifest.relations[0];
    assert.equal(relation.rowsReportedByServer, 60_000);
    assert.ok(relation.bytes > 12_000_000, `expected a multi-megabyte relation, got ${relation.bytes}`);
    // Heap growth is compared against the size of the relation, not against a
    // fixed budget: the point is that the file is not held, not that the run is
    // allocation-free.
    assert.ok(
      after - before < relation.bytes / 2,
      `heap grew by ${after - before} bytes streaming ${relation.bytes} bytes`,
    );
  });
});
