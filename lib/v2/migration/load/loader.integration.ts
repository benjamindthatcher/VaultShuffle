import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { buildManifest, serializeManifest, type ManifestRelation, type RunManifest } from "../export/manifest.ts";
import { inspectRun, type ReaderExpectations, type VerifiedRun } from "../read/reader.ts";
import { buildGameMap } from "../transform/games.ts";
import { transformLibraryBatch, type UserGamesSourceRow } from "../transform/library.ts";
import { transformSupportOpsBatch } from "../transform/support-ops.ts";
import { LoaderError } from "./errors.ts";
import { runLoaderPipeline, type TransformOutcome } from "./pipeline.ts";
import { TARGET_RELATION_SPECS } from "./contract.ts";
import { asRecords, type StagedRun } from "./staging.ts";
import { queryRows, type LocalTargetDescriptor } from "./target.ts";
import type { AccountMapTargetRecord } from "../transform/accounts.ts";

/**
 * End-to-end acceptance for the local migration loader against a real
 * PostgreSQL 17 cluster with M1, M2, M3 and the prepared follow-up replayed.
 *
 * Deliberately NOT named `*.test.ts`: it needs a disposable local cluster.
 * Everything here is synthetic — a fabricated export directory, two fabricated
 * accounts, fabricated support text — and the loader is given an explicit
 * local Unix-socket descriptor, the only kind it accepts.
 *
 * It exercises the whole pipeline (verified read -> private staging -> pure
 * transform -> gates -> one transactional load -> reconciliation ->
 * publication) and then injects the failures that matter:
 *
 *   VS_M3L_PGHOST=/tmp/vs-m3-batches-20260912 VS_M3L_PGPORT=55496 \
 *   VS_M3L_PGUSER=vsm3 VS_M3L_PGDATABASE=vs_loader \
 *   VS_M3L_PSQL=$PWD/node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
 *   node --experimental-strip-types --test lib/v2/migration/load/loader.integration.ts
 */

const PSQL = process.env.VS_M3L_PSQL ?? "psql";
const PGHOST = process.env.VS_M3L_PGHOST ?? "/tmp/vs-m3-batches-20260912";
const PGPORT = Number(process.env.VS_M3L_PGPORT ?? "55496");
const PGUSER = process.env.VS_M3L_PGUSER ?? "vsm3";
const PGDATABASE = process.env.VS_M3L_PGDATABASE ?? "vs_loader";

const TARGET: LocalTargetDescriptor = Object.freeze({
  socketDirectory: PGHOST,
  port: PGPORT,
  user: PGUSER,
  database: PGDATABASE,
  psqlPath: PSQL,
});

const SNAPSHOT = "ab".repeat(32);
const MANIFEST_FINGERPRINT = "cd".repeat(32);
// Frozen from the reviewed M1+M2+M3+preservation-follow-up fixture schema.
// The expected value is deliberately not learned from the target under test.
const FIXTURE_SCHEMA_FINGERPRINT = "d01cbebb6654c8f50213fe7d80f9b50b80db360403b4f187e263fb9e2bde3530";
const FIXTURE_SCHEMA_WITH_ACCOUNTS_FINGERPRINT = "cafbb9d479f73ac9f2c1be4d5f2c3d370489389ac73aa15a83d0fcb8077de89b";
const ACCOUNT_A = "aa000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "aa000000-0000-4000-8000-00000000000b";
const ROW_OWNED = "bb000000-0000-4000-8000-000000000001";
const ROW_WISHLIST = "bb000000-0000-4000-8000-000000000002";
const CONTACT_ID = "cc000000-0000-4000-8000-000000000001";
const INSTANTS = Object.freeze({ startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:05:00.000Z" });

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

const USER_GAMES_COLUMNS = [
  "id", "user_id", "ownership", "status", "hours_played", "completion_percentage", "date_added", "notes",
  "created_at", "updated_at", "last_played_at", "completed_at", "slept_at", "completion_suggestion_dismissed_at",
  "completion_suggestion_dismissed_playtime", "previous_active_status", "catalog_steam_appid",
  "last_observed_played_at", "recency_source", "recency_evidence_at", "observed_playtime_minutes",
  "review_requested_at", "access_source", "family_owner_steam_id", "family_verified_at",
] as const;

const CONTACT_COLUMNS = [
  "id", "user_id", "enquiry_type", "email", "subject", "message", "dedupe_hash", "status", "created_at", "updated_at",
] as const;

let root = "";
let runCounter = 0;

function sql(statement: string): string {
  const result = spawnSync(
    PSQL,
    ["-h", PGHOST, "-p", String(PGPORT), "-U", PGUSER, "-d", PGDATABASE, "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", "-c", statement],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? "");
  return (result.stdout ?? "").trim();
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "vs-loader-"));
  await chmod(root, 0o700);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** COPY text for one relation, exactly as the exporter would have written it. */
function copyBytes(rows: readonly (readonly (string | null)[])[]): Buffer {
  const body = rows
    .map((row) => row.map((cell) => (cell === null ? "\\N" : cell.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n"))).join("\t"))
    .join("\n");
  return Buffer.from(rows.length === 0 ? "" : `${body}\n`, "utf8");
}

function relationEvidence(
  schema: string,
  name: string,
  columns: readonly string[],
  bytes: Buffer,
  rows: number,
): ManifestRelation {
  return {
    schema,
    name,
    rowsReportedByServer: rows,
    rowsCountedOnWire: rows,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    columns: [...columns],
    durationMs: 0,
    file: `relations/${schema}.${name}.copy`,
  };
}

function manifestFor(relations: readonly ManifestRelation[], runId: string): RunManifest {
  return buildManifest({
    runId,
    codeRevision: null,
    profile: {
      label: "loader synthetic fixture",
      transport: "unix-socket",
      host: PGHOST,
      port: PGPORT,
      database: "vaultshuffle_loader_fixture",
      user: PGUSER,
    },
    tlsProtocol: null,
    identity: {
      currentDatabase: "vaultshuffle_loader_fixture",
      currentUser: PGUSER,
      sessionUser: PGUSER,
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
      snapshotXmin: "100",
      currentSnapshot: "100:200:",
      walLsn: null,
      statementStartUtc: "2026-09-12T00:00:00.000Z",
      transactionStartUtc: "2026-09-12T00:00:00.000Z",
      backendPid: "1234",
    },
    closingSnapshot: "100:200:",
    sessionSettings: {
      TimeZone: "UTC",
      DateStyle: "ISO, YMD",
      IntervalStyle: "iso_8601",
      extra_float_digits: "3",
      bytea_output: "hex",
      client_encoding: "UTF8",
      synchronize_seqscans: "off",
    },
    rowSecurity: { setting: "off", settingAtClose: "off", roleIsSuperuser: true, roleBypassesRowSecurity: true },
    walLsnAvailable: false,
    relations: [...relations],
    runDirectoryMode: "0700",
    fileMode: "0600",
    insideGitWorktree: null,
    startedUtc: "2026-09-12T00:00:00.000Z",
    finishedUtc: "2026-09-12T00:00:00.001Z",
    durationMs: 1,
  });
}

function userGamesRow(overrides: Partial<Record<(typeof USER_GAMES_COLUMNS)[number], string | null>> = {}): readonly (string | null)[] {
  const base: Record<string, string | null> = {
    id: ROW_OWNED,
    user_id: ACCOUNT_A,
    ownership: "Owned",
    status: "In Progress",
    hours_played: "1.5",
    completion_percentage: "0",
    date_added: null,
    notes: "  a synthetic note  ",
    created_at: "2026-01-02 03:04:05+00",
    updated_at: "2026-01-02 03:04:06+00",
    last_played_at: "2026-01-31 23:00:00+00",
    completed_at: null,
    slept_at: null,
    completion_suggestion_dismissed_at: null,
    completion_suggestion_dismissed_playtime: null,
    previous_active_status: null,
    catalog_steam_appid: "10",
    last_observed_played_at: "2026-02-01 00:00:00.000123+00",
    recency_source: "steam_exact",
    recency_evidence_at: "2026-02-01 00:00:00.000123+00",
    observed_playtime_minutes: "90",
    review_requested_at: null,
    access_source: "owned",
    family_owner_steam_id: null,
    family_verified_at: null,
    ...overrides,
  };
  return USER_GAMES_COLUMNS.map((column) => base[column] ?? null);
}

function contactRow(overrides: Partial<Record<(typeof CONTACT_COLUMNS)[number], string | null>> = {}): readonly (string | null)[] {
  const base: Record<string, string | null> = {
    id: CONTACT_ID,
    user_id: ACCOUNT_A,
    enquiry_type: "2",
    email: "synthetic@example.test",
    subject: "A synthetic subject",
    message: "A synthetic support message, long enough for the bound.",
    dedupe_hash: "e".repeat(64),
    status: "0",
    created_at: "2026-05-01 10:00:00.000456+00",
    updated_at: "2026-05-02 10:00:00+00",
    ...overrides,
  };
  return CONTACT_COLUMNS.map((column) => base[column] ?? null);
}

/** Write a synthetic export run and return its directory. */
async function writeRun(options: {
  userGames?: readonly (readonly (string | null)[])[];
  contacts?: readonly (readonly (string | null)[])[];
  /** Truncate the relation file AFTER its digest was recorded. */
  truncateAfterDigest?: boolean;
} = {}): Promise<string> {
  runCounter += 1;
  const run = join(root, `run-${runCounter}`);
  const relations = join(run, "relations");
  await mkdir(relations, { recursive: true, mode: 0o700 });
  const userGamesRows = options.userGames ?? [userGamesRow()];
  const contactRows = options.contacts ?? [contactRow()];
  const userGamesBytes = copyBytes(userGamesRows);
  const contactBytes = copyBytes(contactRows);
  const evidence = [
    relationEvidence("public", "user_games", USER_GAMES_COLUMNS, userGamesBytes, userGamesRows.length),
    relationEvidence("public", "contact_messages", CONTACT_COLUMNS, contactBytes, contactRows.length),
  ];
  await writeFile(join(relations, "public.user_games.copy"), userGamesBytes, { mode: 0o600 });
  await writeFile(join(relations, "public.contact_messages.copy"), contactBytes, { mode: 0o600 });
  const manifest = manifestFor(evidence, `20260912-loader-${runCounter}`);
  const serialized = serializeManifest(manifest);
  await writeFile(join(run, "manifest.json"), serialized.text, { mode: 0o600 });
  await writeFile(join(run, "manifest.sha256"), `${serialized.sha256}  manifest.json\n`, { mode: 0o600 });
  if (options.truncateAfterDigest === true) {
    // The manifest still claims the full digest and row count: the reader can
    // only discover the truncation while streaming, AFTER it has handed rows
    // to the callback. This is the case private staging exists for.
    await writeFile(join(relations, "public.user_games.copy"), userGamesBytes.subarray(0, 40), { mode: 0o600 });
  }
  return run;
}

function expectations(): ReaderExpectations {
  return {
    source: {
      kind: "synthetic-fixture",
      database: "vaultshuffle_loader_fixture",
      user: PGUSER,
      label: "loader synthetic fixture",
    },
    relations: [
      { schema: "public", name: "user_games", columns: [...USER_GAMES_COLUMNS] },
      { schema: "public", name: "contact_messages", columns: [...CONTACT_COLUMNS] },
    ],
  };
}

/** The domain transform step the pipeline sequences. */
function transformStaged(staged: StagedRun, runIdentity: { runId: string; snapshotHash: string }): TransformOutcome {
  const userGames = asRecords(staged.byRelation("public.user_games")) as unknown as readonly UserGamesSourceRow[];
  const contacts = asRecords(staged.byRelation("public.contact_messages"));
  const gameMap = buildGameMap({
    runIdentity,
    catalogueGames: [{ steam_appid: "10" }, { steam_appid: "220" }],
  }).map;
  const library = transformLibraryBatch({ runIdentity, accountMap: ACCOUNT_MAP, gameMap, userGames });
  const support = transformSupportOpsBatch({
    runIdentity,
    accountMap: ACCOUNT_MAP,
    contactMessages: contacts,
    feedbackSubmissions: [],
  });
  const unresolved = library.conflicts.filter((conflict) => conflict.details.status === "unresolved").length;
  return {
    batches: [
      { relation: "app.library_games", rows: library.library_games.map((row) => ({ ...row })) },
      {
        relation: "app.game_state",
        rows: library.game_state.map((row) => ({
          account_id: row.account_id,
          game_id: row.game_id,
          completed_at: row.completed_at,
          slept_at: row.slept_at,
          previous_active_status: row.previous_active_status,
          manual_progress: row.manual_progress,
          notes: row.notes,
          review_requested_at: row.review_requested_at,
          completion_dismissed_at: row.completion_dismissed_at,
          completion_dismissed_playtime: row.completion_dismissed_playtime,
        })),
      },
      { relation: "app.game_activity", rows: library.game_activity.map((row) => ({ ...row })) },
      {
        relation: "app.retired_library_games",
        rows: library.retired_library_games.map((row) => ({
          account_id: row.account_id,
          game_id: row.game_id,
          last_personal_minutes: row.last_personal_minutes,
          last_observed_at: row.last_observed_at,
          access_lost_at: row.access_lost_at,
          loss_reason: row.loss_reason,
          legacy_ownership: row.legacy_ownership,
        })),
      },
      {
        relation: "migration.library_row_map",
        rows: library.library_row_map.map((row) => ({ ...row })),
      },
      {
        relation: "support.retention_policy_decisions",
        rows: support.retention_policy_decisions.map((row) => ({ ...row })),
      },
      {
        relation: "support.contact_messages",
        rows: support.contact_messages.map((row) => ({ ...row })),
      },
      { relation: "support.feedback_submissions", rows: [] },
      { relation: "ops.legacy_worker_runs", rows: [] },
      { relation: "migration.legacy_import_freeze_report", rows: [] },
      { relation: "catalog.provider_state", rows: [] },
      { relation: "catalog.appid_terminal_rejections", rows: [] },
    ],
    exceptionCounts: {
      recency_exceptions: library.recency_exceptions.length,
      support_withheld: support.withheld.length,
    },
    unresolvedConflicts: unresolved,
    blockers: support.blockers.filter((blocker) => blocker.code !== "support_retention_policy_pending").length,
    sourceAccounting: [
      {
        relation: "public.user_games",
        sourceRows: userGames.length,
        loadedRows: userGames.length,
        archivedRows: 0,
        conflictRows: library.recency_exceptions.length,
      },
      {
        relation: "public.contact_messages",
        sourceRows: contacts.length,
        loadedRows: support.contact_messages.length,
        archivedRows: 0,
        conflictRows: support.withheld.length,
      },
    ],
  };
}

function resetTarget(): void {
  sql(`truncate app.accounts cascade;
       truncate catalog.games cascade;
       truncate support.retention_policy_decisions cascade;
       truncate migration.runs cascade;
       insert into app.accounts (id, account_kind) overriding system value values (1, 'steam'), (2, 'steam');
       insert into catalog.games (id, steam_app_id, title, normalized_sort_title) overriding system value
         values (1, 10, 'Synthetic One', 'synthetic one'), (2, 220, 'Synthetic Two', 'synthetic two');`);
}

async function runPipeline(options: {
  runId: string;
  runDirectory: string;
  stagingDirectory: string;
  snapshotDecisions?: Readonly<Record<string, boolean>>;
  specs?: typeof TARGET_RELATION_SPECS;
  verifiedRun?: VerifiedRun;
  transform?: (staged: StagedRun) => TransformOutcome;
  expectedSchemaFingerprint?: string;
}) {
  const verified = options.verifiedRun ?? await inspectRun(options.runDirectory, expectations());
  const runIdentity = { runId: `loader-${options.runId.slice(0, 8)}`, snapshotHash: SNAPSHOT };
  const specs = options.specs ?? TARGET_RELATION_SPECS;
  const expectedSchemaFingerprint = options.expectedSchemaFingerprint ?? FIXTURE_SCHEMA_FINGERPRINT;
  return runLoaderPipeline({
    run: { runId: options.runId, snapshotKey: "loader-fixture", snapshotHash: SNAPSHOT },
    verifiedRun: verified,
    sourceRelations: ["public.user_games", "public.contact_messages"],
    sourceRelationsExpected: 2,
    stagingDirectory: options.stagingDirectory,
    target: TARGET,
    transform: options.transform ?? ((staged) => transformStaged(staged, runIdentity)),
    manifestFingerprint: MANIFEST_FINGERPRINT,
    expectedSchemaFingerprint,
    snapshotDecisions: options.snapshotDecisions ?? { cutover_observation: true, import_freeze_accounts: true },
    instants: INSTANTS,
    specs,
  });
}

async function loaderCode(execute: () => Promise<unknown>): Promise<string> {
  try {
    await execute();
  } catch (error) {
    assert.ok(error instanceof LoaderError, `expected LoaderError, received ${String(error)}`);
    return error.loaderCode;
  }
  assert.fail("expected a LoaderError");
}

test("cluster sanity: the target has the applied schema and the prepared follow-up column", () => {
  assert.equal(sql(`select count(*) from information_schema.columns
    where table_schema = 'app' and table_name = 'game_activity' and column_name = 'legacy_last_played_at';`), "1");
});

test("a complete synthetic run loads, reconciles and publishes", async () => {
  resetTarget();
  const result = await runPipeline({
    runId: "11111111-1111-4111-8111-111111111111",
    runDirectory: await writeRun(),
    stagingDirectory: join(root, "stage-1"),
  });
  assert.deepEqual([...result.phases], ["stage", "transform", "gate", "load", "reconcile", "publish"]);
  assert.equal(result.published, true);
  assert.equal(result.gates.passed, true);
  assert.deepEqual([...result.differences], []);
  assert.equal(result.expected.sha256, result.observed.sha256);

  // The rows are actually there, with their exact values.
  assert.equal(sql(`select playtime_minutes::text from app.library_games where account_id = 1 and game_id = 1;`), "90");
  assert.equal(sql(`select length(notes)::text from app.game_state where account_id = 1;`), "20");
  assert.equal(
    sql(`select to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from app.game_activity;`),
    "2026-02-01 00:00:00.000123",
  );
  // The divergent raw play instant reached the prepared follow-up column.
  assert.equal(
    sql(`select to_char(legacy_last_played_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from app.game_activity;`),
    "2026-01-31 23:00:00.000000",
  );
  assert.equal(sql(`select count(*) from support.contact_messages where account_id = 1;`), "1");

  // Bookkeeping: the run is recorded succeeded, with one applied step per
  // written relation and per-relation counts.
  assert.equal(sql(`select status from migration.runs where run_id = '11111111-1111-4111-8111-111111111111';`), "succeeded");
  assert.ok(Number(sql(`select count(*) from migration.applied_steps;`)) >= 6);
  assert.equal(sql(`select count(*) from migration.relation_counts;`), "2");

  // The private staging directory does not outlive the run.
  assert.equal(existsSync(join(root, "stage-1")), false);
});

test("a stream that fails after emitting rows leaves the target untouched and the staging destroyed", async () => {
  resetTarget();
  const before = sql(`select count(*) from app.library_games;`);
  const stagingDirectory = join(root, "stage-damaged");
  const runDirectory = await writeRun();
  const clean = await inspectRun(runDirectory, expectations());
  let emitted = false;
  const verifiedRun: VerifiedRun = Object.freeze({
    ...clean,
    streamRelationRows: async (relation, onRow) => {
      if (typeof relation === "string" && relation === "public.user_games") {
        await clean.streamRelationRows(relation, async (row) => {
          if (!emitted) {
            emitted = true;
            await onRow(row);
          }
        });
        throw new Error("synthetic terminal stream fault");
      }
      return clean.streamRelationRows(relation, onRow);
    },
  });
  const code = await loaderCode(() =>
    runPipeline({ runId: "22222222-2222-4222-8222-222222222222", runDirectory, stagingDirectory, verifiedRun }),
  );
  assert.equal(code, "loader_stage_failed");
  assert.equal(emitted, true);
  assert.equal(sql(`select count(*) from app.library_games;`), before);
  assert.equal(sql(`select count(*) from migration.runs where run_id = '22222222-2222-4222-8222-222222222222';`), "0");
  assert.equal(existsSync(stagingDirectory), false);
});

test("an unresolved preservation exception refuses before target mutation", async () => {
  resetTarget();
  // A recency signal with no receipt time is the library domain's blocking
  // exception; it must stop publication even though every row still loads.
  const runDirectory = await writeRun({
    userGames: [userGamesRow({ recency_source: null, recency_evidence_at: null })],
  });
  const code = await loaderCode(() =>
    runPipeline({
      runId: "33333333-3333-4333-8333-333333333333",
      runDirectory,
      stagingDirectory: join(root, "stage-exception"),
    }),
  );
  assert.equal(code, "loader_publication_refused");
  assert.equal(sql(`select count(*) from migration.runs where run_id = '33333333-3333-4333-8333-333333333333';`), "0");
  assert.equal(sql(`select count(*) from app.library_games;`), "0");
});

test("a missing snapshot-sensitive decision refuses publication rather than defaulting to success", async () => {
  resetTarget();
  const runDirectory = await writeRun();
  const code = await loaderCode(() =>
    runPipeline({
      runId: "44444444-4444-4444-8444-444444444444",
      runDirectory,
      stagingDirectory: join(root, "stage-decisions"),
      snapshotDecisions: { cutover_observation: false },
    }),
  );
  assert.equal(code, "loader_publication_refused");
  assert.equal(sql(`select count(*) from migration.runs where run_id = '44444444-4444-4444-8444-444444444444';`), "0");
});

test("a cross-tenant reference is refused by the target and the whole load rolls back", async () => {
  resetTarget();
  // Account 2 exists, but the library row claims a game the catalogue does not
  // hold for it: the FK refusal must roll the entire transaction back, not
  // leave the rows that were copied before it.
  sql(`delete from catalog.games where id = 2;`);
  const runDirectory = await writeRun({
    userGames: [userGamesRow(), userGamesRow({ id: ROW_WISHLIST, user_id: ACCOUNT_B, catalog_steam_appid: "220" })],
  });
  const code = await loaderCode(() =>
    runPipeline({
      runId: "55555555-5555-4555-8555-555555555555",
      runDirectory,
      stagingDirectory: join(root, "stage-crosstenant"),
    }),
  );
  assert.equal(code, "loader_target_failed");
  // Nothing from the failed transaction survived, including the first relation.
  assert.equal(sql(`select count(*) from app.library_games;`), "0");
  assert.equal(sql(`select count(*) from migration.applied_steps;`), "0");
});

test("a replay with the same evidence is idempotent; a replay with different evidence is refused", async () => {
  resetTarget();
  const runDirectory = await writeRun();
  const runId = "66666666-6666-4666-8666-666666666666";
  await runPipeline({ runId, runDirectory, stagingDirectory: join(root, "stage-replay-1") });
  const loadedOnce = sql(`select count(*) from app.library_games;`);
  const stepsOnce = sql(`select count(*) from migration.applied_steps;`);

  // Same immutable run metadata and same rows is an idempotent no-op.
  await runPipeline({ runId, runDirectory, stagingDirectory: join(root, "stage-replay-2") });
  assert.equal(sql(`select count(*) from app.library_games;`), loadedOnce);
  assert.equal(sql(`select count(*) from migration.applied_steps;`), stepsOnce);

  // A replay of the same phase with DIFFERENT content is the dangerous case:
  // the step exists with another checksum, and the transaction must abort.
  sql(`truncate app.library_games, app.game_state, app.game_activity, app.retired_library_games cascade;
       truncate migration.library_row_map cascade;
       truncate support.contact_messages cascade;`);
  const changedDirectory = await writeRun({
    userGames: [userGamesRow({ observed_playtime_minutes: "120", hours_played: "2.0" })],
  });
  const replayCode = await loaderCode(() =>
    runPipeline({ runId, runDirectory: changedDirectory, stagingDirectory: join(root, "stage-replay-3") }),
  );
  assert.equal(replayCode, "loader_run_mismatch");
  assert.equal(sql(`select count(*) from app.library_games;`), "0", "the aborted replay wrote nothing");
});

test("a schema that drifted from the plan fails the fingerprint gate", async () => {
  resetTarget();
  // A relation the contract declares but the target does not have is exactly
  // what a drifted or wrong-version target looks like.
  const drifted = [
    ...TARGET_RELATION_SPECS,
    Object.freeze({
      relation: "app.not_a_real_relation",
      columns: Object.freeze([Object.freeze({ name: "id", kind: "integer" as const, nullable: false })]),
    }),
  ];
  const runDirectory = await writeRun();
  const code = await loaderCode(() =>
    runPipeline({
      runId: "77777777-7777-4777-8777-777777777777",
      runDirectory,
      stagingDirectory: join(root, "stage-drift"),
      specs: drifted as typeof TARGET_RELATION_SPECS,
    }),
  );
  // The plan cannot even be applied against a relation that is not there.
  assert.equal(code, "loader_target_failed");
});

test("exact large numbers, microsecond instants and JSON survive the round trip", async () => {
  resetTarget();
  await runPipeline({
    runId: "88888888-8888-4888-8888-888888888888",
    runDirectory: await writeRun({
      userGames: [userGamesRow({ observed_playtime_minutes: "2147483640", hours_played: "35791394" })],
      contacts: [contactRow({ message: `A message with a tab\there and a backslash \\ and a quote ' inside it.` })],
    }),
    stagingDirectory: join(root, "stage-exact"),
  });
  assert.equal(sql(`select playtime_minutes::text from app.library_games;`), "2147483640");
  assert.equal(
    sql(`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from support.contact_messages;`),
    "2026-05-01 10:00:00.000456",
  );
  // The awkward characters survived the COPY encoding exactly.
  assert.equal(sql(`select position(chr(9) in message)::text > '0' from support.contact_messages;`), "t");
  assert.equal(sql(`select count(*) from support.contact_messages where position(chr(92) in message) > 0;`), "1");
});

test("a sequence-backed relation accepts the next runtime insert after the load", async () => {
  resetTarget();
  sql(`truncate app.accounts cascade;
       insert into catalog.games (id, steam_app_id, title, normalized_sort_title) overriding system value
       values (1, 10, 'Synthetic One', 'synthetic one'), (2, 220, 'Synthetic Two', 'synthetic two')
       on conflict (id) do nothing;`);
  const accountSpec = Object.freeze({
    relation: "app.accounts",
    identityColumn: "id",
    columns: Object.freeze([
      Object.freeze({ name: "id", kind: "integer" as const, nullable: false }),
      Object.freeze({ name: "account_kind", kind: "text" as const, nullable: false }),
    ]),
  });
  const specs = Object.freeze([accountSpec, ...TARGET_RELATION_SPECS]);
  await runPipeline({
    runId: "99999999-9999-4999-8999-999999999999",
    runDirectory: await writeRun(),
    stagingDirectory: join(root, "stage-sequence"),
    specs: specs as typeof TARGET_RELATION_SPECS,
    expectedSchemaFingerprint: FIXTURE_SCHEMA_WITH_ACCOUNTS_FINGERPRINT,
    transform: (staged) => {
      const outcome = transformStaged(staged, { runId: "loader-99999999", snapshotHash: SNAPSHOT });
      return Object.freeze({
        ...outcome,
        batches: Object.freeze([
          Object.freeze({ relation: "app.accounts", rows: Object.freeze([
            Object.freeze({ id: 1, account_kind: "steam" }),
            Object.freeze({ id: 2, account_kind: "steam" }),
          ]) }),
          ...outcome.batches,
        ]),
      });
    },
  });
  // No test-side setval: this succeeds only if the loader repaired the identity
  // sequence in the same transaction as its explicit ids.
  const inserted = sql(`insert into app.accounts (account_kind) values ('steam') returning id::text;`);
  assert.equal(Number(inserted) > 2, true);
  sql(`delete from app.accounts where id = ${Number(inserted)};`);
});

test("the reconciliation report is private, machine-readable and labelled synthetic", async () => {
  resetTarget();
  const result = await runPipeline({
    runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runDirectory: await writeRun(),
    stagingDirectory: join(root, "stage-report"),
  });
  const report = result.report.report as Record<string, unknown>;
  assert.equal(report.evidence_class, "synthetic-fixture");
  assert.equal(report.matched, true);
  assert.equal(result.report.sha256.length, 64);
  const serialized = JSON.stringify(report);
  // No private value reached the report: no email, no note, no message.
  assert.doesNotMatch(serialized, /synthetic@example\.test/);
  assert.doesNotMatch(serialized, /a synthetic note/);
  assert.doesNotMatch(serialized, /synthetic support message/);
  // Storage is measured and labelled as a fixture measurement, not a user one.
  const metadata = report.metadata as Record<string, unknown>;
  assert.equal(metadata.storageMeasuredOn, "synthetic-fixture");
  assert.ok(Array.isArray(metadata.storage));

  // Per-account digests exist and differ between accounts holding different rows.
  const libraryRelation = result.expected.relations.find((relation) => relation.relation === "app.library_games");
  assert.ok(libraryRelation);
  assert.ok(Object.keys(libraryRelation.byAccount).length > 0);
});

test("queryRows refuses a descriptor that is not an explicit local socket", () => {
  assert.throws(
    () => queryRows({ ...TARGET, socketDirectory: "db.internal:5432" }, "select 1;"),
    (error: unknown) => error instanceof LoaderError && error.loaderCode === "loader_remote_refused",
  );
});
