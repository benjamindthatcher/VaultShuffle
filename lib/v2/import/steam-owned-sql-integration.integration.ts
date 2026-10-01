import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claimOneM2OwnedSnapshot,
  createPsqlM2SqlInvoker,
  runClaimedSteamOwnedSnapshotAgainstM2Sql,
  runSteamOwned10kFixtureAgainstM2Sql,
  resumeM2SqlPreparedPublish,
  type M2OwnedPublishRow,
  type M2SqlCall,
  type M2SqlInvoker,
} from "./steam-owned-sql-harness.ts";
import {
  createSteamOwned10kFixture,
  type SteamOwned10kFixture,
} from "./steam-owned-10k-fixture.ts";
import {
  STEAM_COMPLETE_OWNED_SCOPE,
  type SteamOwnedFetchComplete,
  type SteamOwnedFetchResult,
} from "./steam-owned-fetch.ts";
import {
  normalizeSteamOwnedSnapshot,
  type SteamOwnedSnapshotResult,
} from "./steam-owned-snapshot.ts";

/**
 * This file is deliberately opt-in. It mutates only the explicitly supplied
 * disposable database and never creates, drops, or recreates a database.
 * Keep the ordinary zero-network test suite independent of local PostgreSQL.
 */
const INTEGRATION_ENABLED = process.env.VAULTSHUFFLE_M2_IMPORT_INTEGRATION === "1";

const M2_MIGRATION_SHA256 =
  "f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba";
const FIXTURE_STEAM_ID = "76561197960265729";
const MAX_ADMIN_OUTPUT_BYTES = 8 * 1024 * 1024;

type IntegrationConfig = {
  psqlPath: string;
  host: string;
  port: number;
  workerUser: string;
  adminUser: string;
  database: string;
  workerRole: "vault_worker";
};

type JobSummary = {
  id: string;
  status: string;
  attempt: number;
  messageId: string | null;
  queueAcknowledged: boolean;
  queueRows: number;
  hash: string | null;
  observedCount: number | null;
  libraryChanged: number;
  activityChanged: number;
  retiredCount: number;
  sweepDeferred: number;
  enrichmentEnqueued: number;
  generation: string | null;
  providerRetryAt: string | null;
};

type AccountFingerprint = {
  libraryRows: number;
  libraryFingerprint: string;
  activityRows: number;
  activityFingerprint: string;
  outboxRows: number;
};

type CapabilitySummary = {
  libraryVisibility: string;
  playtimeVisibility: string;
  lastPlayedVisibility: string;
  status: string;
};

function requireConfig(): IntegrationConfig {
  const psqlPath = process.env.VAULTSHUFFLE_M2_PSQL_PATH;
  const host = process.env.VAULTSHUFFLE_M2_PSQL_HOST;
  const portText = process.env.VAULTSHUFFLE_M2_PSQL_PORT;
  const workerUser = process.env.VAULTSHUFFLE_M2_PSQL_USER;
  const adminUser = process.env.VAULTSHUFFLE_M2_ADMIN_USER;
  const database = process.env.VAULTSHUFFLE_M2_PSQL_DATABASE;
  const workerRole = process.env.VAULTSHUFFLE_M2_WORKER_ROLE;
  if (process.env.VAULTSHUFFLE_M2_IMPORT_ALLOW_MUTATION !== "1"
    || !psqlPath || !host || !portText || !workerUser || !adminUser || !database
    || workerRole !== "vault_worker") {
    throw new Error(
      "M2 SQL integration requires explicit psql/host/port/worker/admin/database/role "
      + "arguments and VAULTSHUFFLE_M2_IMPORT_ALLOW_MUTATION=1"
    );
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("M2 SQL integration port is invalid");
  }
  return { psqlPath, host, port, workerUser, adminUser, database, workerRole };
}

function sqlLiteral(value: string): string {
  if (value.includes("\u0000")) throw new Error("SQL test literal contains NUL");
  return `'${value.replaceAll("'", "''")}'`;
}

function uuidLiteral(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("SQL test UUID is invalid");
  }
  return `${sqlLiteral(value)}::uuid`;
}

function integerLiteral(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("SQL test account ID is invalid");
  }
  return String(value);
}

function runAdminPsql(config: IntegrationConfig, query: string): string {
  const result = spawnSync(config.psqlPath, [
    "-X",
    "-q",
    "-A",
    "-t",
    "-w",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    config.host,
    "-p",
    String(config.port),
    "-U",
    config.adminUser,
    "-d",
    config.database,
    "-c",
    query
  ], {
    encoding: "utf8",
    maxBuffer: MAX_ADMIN_OUTPUT_BYTES,
    env: {
      LC_ALL: "C",
      PAGER: "cat",
      PSQL_PAGER: "off"
    } as unknown as NodeJS.ProcessEnv
  });
  if (result.status !== 0 || result.error) throw new Error("M2 integration admin SQL failed");
  return result.stdout.trim();
}

function runAdminJson<T>(config: IntegrationConfig, query: string): T {
  const output = runAdminPsql(config, query);
  if (!output) throw new Error("M2 integration admin SQL returned no row");
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error("M2 integration admin SQL returned invalid JSON");
  }
}

function createFixtureAccount(config: IntegrationConfig): number {
  const publicId = randomUUID();
  const raw = runAdminJson<{ accountId: string }>(config, [
    "begin;",
    "set local timezone = 'UTC';",
    "set local app.m2_fixture = 'on';",
    "update ops.provider_controls",
    "set mode = 'fixture', reason = 'opt-in SQL integration fixture', updated_at = clock_timestamp()",
    "where provider = 'steam';",
    "with created as (",
    "  insert into app.accounts(public_id, account_kind, lifecycle_status, display_name)",
    `  values (${uuidLiteral(publicId)}, 'manual', 'active', 'M2 SQL integration fixture')`,
    "  returning id",
    "), profile as (",
    "  insert into app.steam_profiles(account_id, steam_id, verified, display_name)",
    `  select id, ${FIXTURE_STEAM_ID}::bigint, false, 'M2 SQL integration fixture' from created`,
    "  returning account_id",
    ")",
    "select json_build_object('accountId', created.id::text)::text",
    "from created join profile on profile.account_id = created.id;",
    "commit;"
  ].join("\n"));
  if (!/^[1-9][0-9]*$/.test(raw.accountId)) throw new Error("fixture account ID is invalid");
  const accountId = Number(raw.accountId);
  if (!Number.isSafeInteger(accountId) || accountId < 1 || accountId > 2_147_483_647) {
    throw new Error("fixture account ID is out of range");
  }
  return accountId;
}

function deleteFixtureAccount(config: IntegrationConfig, accountId: number): void {
  const id = integerLiteral(accountId);
  runAdminPsql(config, [
    "begin;",
    "set local timezone = 'UTC';",
    "set local app.m2_fixture = 'on';",
    "do $$",
    "declare v_row record;",
    "begin",
    `  for v_row in select distinct queue_name, message_id from ops.jobs where account_id = ${id}`,
    "    and queue_name is not null and message_id is not null loop",
    "    perform pgmq.delete(v_row.queue_name, v_row.message_id);",
    "  end loop;",
    "end $$;",
    `delete from app.accounts where id = ${id};`,
    "update ops.provider_controls",
    "set mode = 'disabled', reason = 'preview provider calls are disabled', updated_at = clock_timestamp()",
    "where provider = 'steam';",
    "commit;"
  ].join("\n"));
}

function seedOwnedJob(config: IntegrationConfig, accountId: number, requestKey: string): string {
  const id = integerLiteral(accountId);
  const raw = runAdminJson<{ jobId: string; status: string }>(config, [
    "begin;",
    "set local timezone = 'UTC';",
    "set local app.m2_fixture = 'on';",
    "select json_build_object(",
    "'jobId', request_result.job_id::text,",
    "'status', request_result.status)::text",
    `from ops.request_owned_snapshot_for_account(${id}, ${uuidLiteral(requestKey)}) as request_result;`,
    "commit;"
  ].join("\n"));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.jobId)) {
    throw new Error("seeded owned job ID is invalid");
  }
  if (raw.status !== "enqueued") throw new Error(`owned job was not enqueued: ${raw.status}`);
  return raw.jobId;
}

function jobSummary(config: IntegrationConfig, jobId: string): JobSummary {
  const raw = runAdminJson<JobSummary>(config, [
    "select json_build_object(",
    "'id', j.id::text,",
    "'status', j.status,",
    "'attempt', j.attempt,",
    "'messageId', j.message_id::text,",
    "'queueAcknowledged', j.queue_acknowledged,",
    "'queueRows', (select count(*) from pgmq.q_vault_background q where q.msg_id = j.message_id),",
    "'hash', case when j.result_hash is null then null else encode(j.result_hash, 'hex') end,",
    "'observedCount', j.observed_count,",
    "'libraryChanged', j.library_changed_count,",
    "'activityChanged', j.activity_changed_count,",
    "'retiredCount', j.retired_count,",
    "'sweepDeferred', j.sweep_deferred_count,",
    "'enrichmentEnqueued', j.enrichment_enqueued_count,",
    "'generation', j.applied_generation::text,",
    "'providerRetryAt', j.provider_retry_at)::text",
    `from ops.jobs j where j.id = ${uuidLiteral(jobId)};`
  ].join("\n"));
  if (raw.id !== jobId) throw new Error("job summary returned the wrong job");
  return raw;
}

function accountFingerprint(config: IntegrationConfig, accountId: number): AccountFingerprint {
  const id = integerLiteral(accountId);
  return runAdminJson<AccountFingerprint>(config, [
    "select json_build_object(",
    "'libraryRows', (select count(*) from app.library_games where account_id = ", id, "),",
    "'libraryFingerprint', coalesce((select md5(string_agg(",
    "format('%s:%s:%s', game_id, coalesce(playtime_minutes::text, 'null'), xmin::text), ',' order by game_id))",
    "from app.library_games where account_id = ", id, "), md5('')),",
    "'activityRows', (select count(*) from app.game_activity where account_id = ", id, "),",
    "'activityFingerprint', coalesce((select md5(string_agg(",
    "format('%s:%s:%s:%s', game_id, coalesce(last_observed_minutes::text, 'null'),",
    "coalesce(last_played_at::text, 'null'), xmin::text), ',' order by game_id))",
    "from app.game_activity where account_id = ", id, "), md5('')),",
    "'outboxRows', (select count(*) from ops.enrichment_outbox) ",
    ")::text;"
  ].join("\n"));
}

function capabilitySummary(config: IntegrationConfig, accountId: number): CapabilitySummary {
  return runAdminJson<CapabilitySummary>(config, [
    "select json_build_object(",
    "'libraryVisibility', library_visibility,",
    "'playtimeVisibility', playtime_visibility,",
    "'lastPlayedVisibility', last_played_visibility,",
    "'status', status)::text",
    `from app.account_capabilities where account_id = ${integerLiteral(accountId)};`
  ].join("\n"));
}

function makeSnapshot(
  games: Array<{
    appid: number;
    playtime_forever?: number | null;
    name?: string;
    rtime_last_played?: number | null;
  }>,
  observationTimeEpochSeconds: number
): SteamOwnedFetchComplete {
  const body = { response: { game_count: games.length, games } };
  const normalized: SteamOwnedSnapshotResult = normalizeSteamOwnedSnapshot(body, {
    observationTimeEpochSeconds
  });
  if (normalized.status !== "complete") throw new Error(`custom fixture failed: ${normalized.status}`);
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  return {
    ...normalized,
    provenance: {
      ...STEAM_COMPLETE_OWNED_SCOPE,
      httpStatus: 200,
      bodyBytes,
      observationTimeEpochSeconds
    }
  };
}

function atWorkerObservation(
  fetched: SteamOwnedFetchResult,
  observationTimeEpochSeconds: number
): SteamOwnedFetchResult {
  return fetched.status === "complete"
    ? {
        ...fetched,
        provenance: { ...fetched.provenance, observationTimeEpochSeconds }
      }
    : fetched;
}

async function claimOwned(sql: M2SqlInvoker) {
  const result = await claimOneM2OwnedSnapshot(sql, {
    lane: "background",
    visibilitySeconds: 120
  });
  assert.equal(result.status, "claimed");
  if (result.status !== "claimed") throw new Error("owned fixture job was not claimed");
  return result.claim;
}

async function runCompleteJob(
  sql: M2SqlInvoker,
  fixture: SteamOwned10kFixture,
  nowEpochSeconds: () => number
) {
  const result = await runSteamOwned10kFixtureAgainstM2Sql({
    sql,
    nowEpochSeconds,
    lane: "background",
    visibilitySeconds: 120,
    fixture
  });
  assert.equal(result.status, "ran");
  if (result.status !== "ran") throw new Error("owned fixture job was not run");
  return result;
}

async function runFetchedJob(
  sql: M2SqlInvoker,
  fetched: SteamOwnedFetchResult,
  nowEpochSeconds: () => number
) {
  const claim = await claimOwned(sql);
  const result = await runClaimedSteamOwnedSnapshotAgainstM2Sql(claim, {
    sql,
    nowEpochSeconds,
    transport: async () => atWorkerObservation(fetched, nowEpochSeconds())
  });
  return { claim, result };
}

function hashFromRow(row: M2OwnedPublishRow): string {
  if (row.snapshotHash === null) return "";
  let hex = "";
  for (const byte of row.snapshotHash) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function assertFrozenM2Migration(): void {
  const migration = new URL(
    "../../../database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql",
    import.meta.url
  );
  const actual = createHash("sha256").update(readFileSync(migration)).digest("hex");
  assert.equal(actual, M2_MIGRATION_SHA256);
}

if (INTEGRATION_ENABLED) {
  test("runs the owned snapshot orchestrator against real frozen M2 SQL", async () => {
    const config = requireConfig();
    assertFrozenM2Migration();
    const sql = createPsqlM2SqlInvoker({
      psqlPath: config.psqlPath,
      host: config.host,
      port: config.port,
      user: config.workerUser,
      database: config.database,
      workerRole: config.workerRole,
      fixtureMode: true,
      timeoutMs: 120_000
    });
    const fixture = createSteamOwned10kFixture();
    const accountId = createFixtureAccount(config);
    const nowEpochSeconds = () => Math.floor(Date.now() / 1000);
    try {
      const initialRequest = seedOwnedJob(config, accountId, randomUUID());
      let loseFirstPublishResponse = true;
      let publishRpcWallMs = 0;
      const responseLossSql: M2SqlInvoker = async (call: M2SqlCall) => {
        if (call.functionName !== "ops.publish_owned_snapshot") return sql(call);
        const startedAt = performance.now();
        try {
          const raw = await sql(call);
          if (loseFirstPublishResponse) {
            loseFirstPublishResponse = false;
            throw new Error("simulated response loss after commit");
          }
          return raw;
        } finally {
          publishRpcWallMs += performance.now() - startedAt;
        }
      };
      const responseLossRun = await runCompleteJob(responseLossSql, fixture, nowEpochSeconds);
      assert.equal(responseLossRun.claim.accountId, accountId);
      assert.equal(responseLossRun.fetchCount, 1);
      assert.equal(responseLossRun.claim.jobId, initialRequest);
      assert.equal(responseLossRun.result.status, "db_error");
      if (responseLossRun.result.status !== "db_error" || !responseLossRun.result.preparedPublish) {
        throw new Error("response-loss run did not retain a prepared publish");
      }
      const replayRows: M2OwnedPublishRow[] = [];
      const replay = await resumeM2SqlPreparedPublish(responseLossRun.result.preparedPublish, sql, {
        onPublishRow: (row) => replayRows.push(row)
      });
      assert.deepEqual(replay, { status: "published", result: "already_applied", acknowledged: true });
      assert.equal(responseLossRun.fetchCount, 1);
      assert.equal(replayRows.length, 1);
      const firstSummary = jobSummary(config, initialRequest);
      assert.deepEqual({
        status: firstSummary.status,
        queueAcknowledged: firstSummary.queueAcknowledged,
        queueRows: firstSummary.queueRows,
        hash: firstSummary.hash,
        observedCount: firstSummary.observedCount,
        libraryChanged: firstSummary.libraryChanged,
        activityChanged: firstSummary.activityChanged,
        enrichmentEnqueued: firstSummary.enrichmentEnqueued
      }, {
        status: "succeeded",
        queueAcknowledged: true,
        queueRows: 0,
        hash: fixture.snapshot.contentHash,
        observedCount: 10_000,
        libraryChanged: 10_000,
        activityChanged: 9_999,
        enrichmentEnqueued: 10_000
      });
      const replayRow = replayRows[0];
      assert.ok(replayRow);
      if (!replayRow) throw new Error("missing replay row");
      assert.equal(replayRow.result, "already_applied");
      assert.equal(hashFromRow(replayRow), fixture.snapshot.contentHash);
      assert.equal(replayRow.observedCount, firstSummary.observedCount);
      assert.equal(replayRow.libraryChanged, firstSummary.libraryChanged);
      assert.equal(replayRow.activityChanged, firstSummary.activityChanged);
      assert.equal(replayRow.retiredCount, firstSummary.retiredCount);
      assert.equal(replayRow.sweepDeferredCount, firstSummary.sweepDeferred);
      assert.equal(replayRow.enrichmentEnqueued, firstSummary.enrichmentEnqueued);
      assert.equal(replayRow.acknowledged, firstSummary.queueAcknowledged);
      assert.equal(Number.isFinite(publishRpcWallMs) && publishRpcWallMs > 0, true);
      assert.equal(publishRpcWallMs < 5_000, true);
      console.log(`M2 import publish RPC wall time: ${publishRpcWallMs.toFixed(3)} ms`);

      const noopRequest = seedOwnedJob(config, accountId, randomUUID());
      const beforeNoop = accountFingerprint(config, accountId);
      assert.equal(beforeNoop.libraryRows, 10_000);
      assert.equal(beforeNoop.activityRows, 9_999);
      assert.equal(beforeNoop.outboxRows, 10_000);
      const noopRun = await runCompleteJob(sql, fixture, nowEpochSeconds);
      assert.deepEqual(noopRun.result, { status: "published", result: "applied", acknowledged: true });
      const afterNoop = accountFingerprint(config, accountId);
      assert.deepEqual(afterNoop, beforeNoop);
      const noopSummary = jobSummary(config, noopRequest);
      assert.deepEqual({
        status: noopSummary.status,
        queueAcknowledged: noopSummary.queueAcknowledged,
        queueRows: noopSummary.queueRows,
        hash: noopSummary.hash,
        observedCount: noopSummary.observedCount,
        libraryChanged: noopSummary.libraryChanged,
        activityChanged: noopSummary.activityChanged,
        retiredCount: noopSummary.retiredCount,
        enrichmentEnqueued: noopSummary.enrichmentEnqueued
      }, {
        status: "succeeded",
        queueAcknowledged: true,
        queueRows: 0,
        hash: fixture.snapshot.contentHash,
        observedCount: 10_000,
        libraryChanged: 0,
        activityChanged: 0,
        retiredCount: 0,
        enrichmentEnqueued: 0
      });

      const retireSnapshot = makeSnapshot([
        { appid: 1, playtime_forever: 0, rtime_last_played: 0 }
      ], 1_700_000_000);
      const retireRequest = seedOwnedJob(config, accountId, randomUUID());
      const retireRun = await runFetchedJob(sql, retireSnapshot, nowEpochSeconds);
      assert.deepEqual(retireRun.result, { status: "published", result: "applied", acknowledged: true });
      const retiredFacts = runAdminJson<{
        app2Minutes: number | null;
        app4Minutes: number | null;
      }>(config, [
        "select json_build_object(",
        "'app2Minutes', (select r.last_personal_minutes from app.retired_library_games r join catalog.games g on g.id = r.game_id",
        ` where r.account_id = ${integerLiteral(accountId)} and g.steam_app_id = 2),`,
        "'app4Minutes', (select r.last_personal_minutes from app.retired_library_games r join catalog.games g on g.id = r.game_id",
        ` where r.account_id = ${integerLiteral(accountId)} and g.steam_app_id = 4))::text;`
      ].join("\n"));
      assert.deepEqual(retiredFacts, { app2Minutes: null, app4Minutes: 51 });
      const retireSummary = jobSummary(config, retireRequest);
      assert.equal(retireSummary.status, "succeeded");
      assert.equal(retireSummary.retiredCount, 9_999);

      const reacquireSnapshot = makeSnapshot([
        { appid: 1, playtime_forever: 0, rtime_last_played: 0 },
        { appid: 2, playtime_forever: null, rtime_last_played: null },
        { appid: 4, playtime_forever: 1, rtime_last_played: null }
      ], 1_700_000_000);
      const reacquireRequest = seedOwnedJob(config, accountId, randomUUID());
      const reacquireRun = await runFetchedJob(sql, reacquireSnapshot, nowEpochSeconds);
      assert.deepEqual(reacquireRun.result, { status: "published", result: "applied", acknowledged: true });
      const reacquiredFacts = runAdminJson<{
        app2ActiveMinutes: number | null;
        app4ActiveMinutes: number | null;
        app2RetiredRows: number;
        app4RetiredRows: number;
      }>(config, [
        "select json_build_object(",
        "'app2ActiveMinutes', (select l.playtime_minutes from app.library_games l join catalog.games g on g.id = l.game_id",
        ` where l.account_id = ${integerLiteral(accountId)} and g.steam_app_id = 2),`,
        "'app4ActiveMinutes', (select l.playtime_minutes from app.library_games l join catalog.games g on g.id = l.game_id",
        ` where l.account_id = ${integerLiteral(accountId)} and g.steam_app_id = 4),`,
        "'app2RetiredRows', (select count(*) from app.retired_library_games r join catalog.games g on g.id = r.game_id",
        ` where r.account_id = ${integerLiteral(accountId)} and g.steam_app_id = 2),`,
        "'app4RetiredRows', (select count(*) from app.retired_library_games r join catalog.games g on g.id = r.game_id",
        ` where r.account_id = ${integerLiteral(accountId)} and g.steam_app_id = 4))::text;`
      ].join("\n"));
      assert.deepEqual(reacquiredFacts, {
        app2ActiveMinutes: null,
        app4ActiveMinutes: 51,
        app2RetiredRows: 0,
        app4RetiredRows: 0
      });
      const reacquireSummary = jobSummary(config, reacquireRequest);
      assert.equal(reacquireSummary.status, "succeeded");

      const privateRequest = seedOwnedJob(config, accountId, randomUUID());
      const privateRun = await runFetchedJob(sql, {
        status: "unavailable",
        provider: "steam",
        reason: "private"
      }, nowEpochSeconds);
      assert.deepEqual(privateRun.result, { status: "published", result: "applied", acknowledged: true });
      const privateSummary = jobSummary(config, privateRequest);
      assert.deepEqual({ status: privateSummary.status, queueAcknowledged: privateSummary.queueAcknowledged }, {
        status: "unavailable",
        queueAcknowledged: true
      });
      assert.deepEqual(capabilitySummary(config, accountId), {
        libraryVisibility: "hidden",
        playtimeVisibility: "unknown",
        lastPlayedVisibility: "unknown",
        status: "private"
      });

      const invalidRequest = seedOwnedJob(config, accountId, randomUUID());
      const invalidRun = await runFetchedJob(sql, {
        status: "invalid",
        provider: "steam",
        reason: "malformed_response",
        detail: "bounded integration fixture"
      }, nowEpochSeconds);
      assert.deepEqual(invalidRun.result, { status: "published", result: "applied", acknowledged: true });
      const invalidSummary = jobSummary(config, invalidRequest);
      assert.deepEqual({ status: invalidSummary.status, queueAcknowledged: invalidSummary.queueAcknowledged }, {
        status: "invalid",
        queueAcknowledged: true
      });
      assert.equal(capabilitySummary(config, accountId).status, "error");

      const staleRequest = seedOwnedJob(config, accountId, randomUUID());
      const staleClaim = await claimOwned(sql);
      assert.equal(staleClaim.accountId, accountId);
      const staleBefore = jobSummary(config, staleRequest);
      const staleRun = await runClaimedSteamOwnedSnapshotAgainstM2Sql(
        { ...staleClaim, leaseToken: randomUUID() },
        {
          sql,
          nowEpochSeconds,
          transport: async () => atWorkerObservation(fixture.snapshot, nowEpochSeconds())
        }
      );
      assert.deepEqual(staleRun, { status: "stale", phase: "publish" });
      const staleAfter = jobSummary(config, staleRequest);
      assert.deepEqual({
        status: staleAfter.status,
        queueAcknowledged: staleAfter.queueAcknowledged,
        queueRows: staleAfter.queueRows,
        attempt: staleAfter.attempt
      }, {
        status: "fetching",
        queueAcknowledged: false,
        queueRows: 1,
        attempt: staleBefore.attempt
      });
      const staleCleanup = await runClaimedSteamOwnedSnapshotAgainstM2Sql(staleClaim, {
        sql,
        nowEpochSeconds,
        transport: async () => ({ status: "unavailable", provider: "steam", reason: "private" })
      });
      assert.deepEqual(staleCleanup, { status: "published", result: "applied", acknowledged: true });

      const deferredRequest = seedOwnedJob(config, accountId, randomUUID());
      const deferredRun = await runFetchedJob(sql, {
        status: "unavailable",
        provider: "steam",
        reason: "http_error",
        httpStatus: 429,
        retryDisposition: "deferred"
      }, nowEpochSeconds);
      assert.equal(deferredRun.result.status, "retry_scheduled");
      if (deferredRun.result.status !== "retry_scheduled") throw new Error("deferred result missing");
      assert.equal(deferredRun.result.retryPolicy, "deferred");
      assert.equal(deferredRun.result.result.acknowledged, true);
      const deferredSummary = jobSummary(config, deferredRequest);
      assert.deepEqual({
        status: deferredSummary.status,
        queueAcknowledged: deferredSummary.queueAcknowledged,
        queueRows: deferredSummary.queueRows,
        providerRetryAtPresent: deferredSummary.providerRetryAt !== null
      }, {
        status: "retryable",
        queueAcknowledged: true,
        queueRows: 0,
        providerRetryAtPresent: false
      });
      assert.equal(M2_MIGRATION_SHA256, "f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba");
    } finally {
      deleteFixtureAccount(config, accountId);
    }
  });
}
