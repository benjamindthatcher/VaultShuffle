import assert from "node:assert/strict";
import test from "node:test";
import {
  assertM2PublishRowForFixture,
  buildM2PsqlQuery,
  claimOneM2OwnedSnapshot,
  runClaimedSteamOwnedSnapshotAgainstM2Sql,
  runSteamOwned10kFixtureAgainstM2Sql,
  resumeM2SqlPreparedPublish,
  type M2SqlCall,
  type M2SqlInvoker
} from "./steam-owned-sql-harness.ts";
import {
  createSteamOwned10kFixture,
  STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS
} from "./steam-owned-10k-fixture.ts";
import {
  type SteamOwnedFetchResult
} from "./steam-owned-fetch.ts";
import type { SteamOwnedJobClaim } from "./steam-owned-job-orchestrator.ts";

const OBSERVATION_TIME = STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS;
const SQL_RECEIPT_TIME = OBSERVATION_TIME + 30;
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const LEASE_TOKEN = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";
const ATTEMPT_TOKEN = "00000000-0000-4000-8000-000000000004";
const STEAM_ID = "76561197960265728";

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString();
}

function claimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimed: true,
    block_code: null,
    retry_at: null,
    job_id: JOB_ID,
    message_id: "42",
    job_kind: "owned_snapshot",
    account_id: 7,
    game_id: null,
    provider: "steam",
    provider_subject: STEAM_ID,
    provider_mode: "fixture",
    generation: "3",
    catalog_revision: null,
    lease_token: LEASE_TOKEN,
    attempt: 1,
    attempt_id: ATTEMPT_ID,
    attempt_token: ATTEMPT_TOKEN,
    charged_at: iso(OBSERVATION_TIME - 120),
    fetch_started_at: iso(OBSERVATION_TIME - 60),
    lease_expires_at: iso(OBSERVATION_TIME + 120),
    ...overrides
  };
}

function publishRow(
  fixture: ReturnType<typeof createSteamOwned10kFixture>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    result: "applied",
    job_id: JOB_ID,
    account_id: 7,
    generation: "3",
    applied_generation: "3",
    snapshot_hash: `\\x${fixture.snapshot.contentHash}`,
    observed_count: fixture.snapshot.gameCount,
    library_changed: 10_000,
    activity_changed: 7_500,
    retired_count: 0,
    sweep_deferred_count: 0,
    enrichment_enqueued: 10_000,
    acknowledged: true,
    ...overrides
  };
}

function retryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "deferred",
    retry_at: null,
    attempt: 1,
    acknowledged: true,
    ...overrides
  };
}

function directClaim(overrides: Partial<SteamOwnedJobClaim> = {}): SteamOwnedJobClaim {
  return {
    claimed: true,
    jobId: JOB_ID,
    messageId: "42",
    jobKind: "owned_snapshot",
    accountId: 7,
    gameId: null,
    provider: "steam",
    steamId: STEAM_ID,
    providerMode: "fixture",
    generation: "3",
    catalogRevision: null,
    leaseToken: LEASE_TOKEN,
    attempt: 1,
    attemptId: ATTEMPT_ID,
    attemptToken: ATTEMPT_TOKEN,
    chargedAt: iso(OBSERVATION_TIME - 120),
    fetchStartedAt: iso(OBSERVATION_TIME - 60),
    leaseExpiresAt: iso(OBSERVATION_TIME + 120),
    ...overrides
  };
}

test("binds the actual 10k canonical fixture and replays a response-lost publish without refetching", async () => {
  const fixture = createSteamOwned10kFixture();
  const calls: M2SqlCall[] = [];
  const publishRows: Record<string, unknown>[] = [];
  let publishCalls = 0;
  const sql: M2SqlInvoker = async (call) => {
    calls.push(call);
    if (call.functionName === "ops.claim_job") return [claimRow()];
    if (call.functionName === "ops.publish_owned_snapshot") {
      publishCalls += 1;
      if (publishCalls === 1) {
        // Models a commit followed by a lost response. The runner must retain
        // prepared publish material and never invoke the fixture transport a
        // second time when the caller resumes it.
        publishRows.push(publishRow(fixture));
        throw new Error("response lost after commit");
      }
      // A replay must return the exact stored summary from the first commit,
      // including its changed counts; zero counts are reserved for a distinct
      // new job whose input was already present.
      const row = publishRow(fixture, { result: "already_applied" });
      publishRows.push(row);
      return [row];
    }
    throw new Error("unexpected retry RPC");
  };

  const first = await runSteamOwned10kFixtureAgainstM2Sql({
    sql,
    nowEpochSeconds: () => SQL_RECEIPT_TIME,
    lane: "background",
    visibilitySeconds: 120
  });
  assert.equal(first.status, "ran");
  if (first.status !== "ran") return;
  assert.equal(first.fetchCount, 1);
  assert.deepEqual(first.result, { status: "db_error", phase: "publish", code: "publish_failed" });
  assert.equal(Object.keys(first.result).includes("preparedPublish"), false);

  const prepared = first.result.preparedPublish;
  assert.ok(prepared);
  if (!prepared) return;
  const replay = await resumeM2SqlPreparedPublish(prepared, sql);
  assert.deepEqual(replay, { status: "published", result: "already_applied", acknowledged: true });
  assert.equal(first.fetchCount, 1);
  assert.equal(calls.filter((call) => call.functionName === "ops.claim_job").length, 1);
  assert.equal(calls.filter((call) => call.functionName === "ops.publish_owned_snapshot").length, 2);

  const firstPublish = calls.find((call) => call.functionName === "ops.publish_owned_snapshot");
  assert.ok(firstPublish);
  if (!firstPublish) return;
  assert.equal(firstPublish.args[0], JOB_ID);
  assert.equal(firstPublish.args[1], LEASE_TOKEN);
  assert.deepEqual(firstPublish.args[2], {
    status: "complete",
    provider: "steam",
    protocolVersion: 1,
    gameCount: 10_000,
    scope: "complete_owned",
    includeAppInfo: true,
    includePlayedFreeGames: true,
    skipUnvettedApps: false,
    httpStatus: 200,
    bodyBytes: fixture.providerBodyBytes
  });
  assert.equal(firstPublish.args[3], fixture.snapshot.canonicalJson);
  assert.ok(firstPublish.args[4] instanceof Uint8Array);
  assert.equal(firstPublish.args[5], iso(SQL_RECEIPT_TIME));
  assert.equal(firstPublish.args[6], "42");

  assert.equal(publishRows.length, 2);
  assertM2PublishRowForFixture(publishRows[0], {
    gameCount: 10_000,
    contentHash: fixture.snapshot.contentHash,
    changed: {
      libraryChanged: 10_000,
      activityChanged: 7_500,
      retiredCount: 0,
      sweepDeferredCount: 0,
      enrichmentEnqueued: 10_000
    }
  });
  assertM2PublishRowForFixture(publishRows[1], {
    gameCount: 10_000,
    contentHash: fixture.snapshot.contentHash,
    changed: {
      libraryChanged: 10_000,
      activityChanged: 7_500,
      retiredCount: 0,
      sweepDeferredCount: 0,
      enrichmentEnqueued: 10_000
    }
  });
});

test("routes private, invalid, and deferred outcomes through the frozen SQL calls", async () => {
  const outcomes: Array<{
    fetched: SteamOwnedFetchResult;
    expectedRpc: "ops.publish_owned_snapshot" | "ops.retry_job";
    expectedPolicy?: string;
  }> = [
    {
      fetched: { status: "unavailable", provider: "steam", reason: "private" },
      expectedRpc: "ops.publish_owned_snapshot"
    },
    {
      fetched: { status: "invalid", provider: "steam", reason: "malformed_response", detail: "safe" },
      expectedRpc: "ops.publish_owned_snapshot"
    },
    {
      fetched: {
        status: "unavailable",
        provider: "steam",
        reason: "http_error",
        httpStatus: 429,
        retryAfterSeconds: 90,
        retryDisposition: "deferred"
      },
      expectedRpc: "ops.retry_job",
      expectedPolicy: "deferred"
    }
  ];
  for (const outcome of outcomes) {
    const calls: M2SqlCall[] = [];
    const sql: M2SqlInvoker = async (call) => {
      calls.push(call);
      if (call.functionName === "ops.publish_owned_snapshot") {
        return [
          {
            result: "applied",
            job_id: JOB_ID,
            account_id: 7,
            generation: "3",
            applied_generation: null,
            snapshot_hash: null,
            observed_count: null,
            library_changed: 0,
            activity_changed: 0,
            retired_count: 0,
            sweep_deferred_count: 0,
            enrichment_enqueued: 0,
            acknowledged: true
          }
        ];
      }
      if (call.functionName === "ops.retry_job") return [retryRow()];
      throw new Error("claim is not part of this direct one-claim test");
    };
    const result = await runClaimedSteamOwnedSnapshotAgainstM2Sql(directClaim(), {
      sql,
      nowEpochSeconds: () => OBSERVATION_TIME,
      transport: async () => outcome.fetched
    });
    assert.equal(result.status === "published" || result.status === "retry_scheduled", true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.functionName, outcome.expectedRpc);
    if (outcome.expectedPolicy) {
      assert.equal(calls[0]?.args[5], outcome.expectedPolicy);
      assert.equal(calls[0]?.args[6], "42");
    }
  }
});

test("rejects draft or malformed SQL result statuses instead of converting them to success", async () => {
  const fixture = createSteamOwned10kFixture();
  const sql: M2SqlInvoker = async (call) => {
    if (call.functionName === "ops.publish_owned_snapshot") {
      return [publishRow(fixture, { result: "invalid" })];
    }
    throw new Error("unexpected retry RPC");
  };
  const result = await runClaimedSteamOwnedSnapshotAgainstM2Sql(directClaim(), {
    sql,
    nowEpochSeconds: () => OBSERVATION_TIME,
    transport: async () => fixture.snapshot
  });
  assert.deepEqual(result, { status: "db_error", phase: "publish", code: "publish_failed" });
});

test("accepts nullable summary fields on private or stale SQL terminal rows", async () => {
  const fixture = createSteamOwned10kFixture();
  const staleSql: M2SqlInvoker = async (call) => {
    if (call.functionName !== "ops.publish_owned_snapshot") throw new Error("unexpected retry RPC");
    return [{
      result: "stale",
      job_id: JOB_ID,
      account_id: null,
      generation: null,
      applied_generation: null,
      snapshot_hash: null,
      observed_count: null,
      library_changed: 0,
      activity_changed: 0,
      retired_count: 0,
      sweep_deferred_count: 0,
      enrichment_enqueued: 0,
      acknowledged: false
    }];
  };
  const result = await runClaimedSteamOwnedSnapshotAgainstM2Sql(directClaim(), {
    sql: staleSql,
    nowEpochSeconds: () => OBSERVATION_TIME,
    transport: async () => fixture.snapshot
  });
  assert.deepEqual(result, { status: "stale", phase: "publish" });
});

test("distinguishes a new unchanged job from an already-applied replay", () => {
  const fixture = createSteamOwned10kFixture();
  const row = publishRow(fixture, {
    result: "applied",
    job_id: "00000000-0000-4000-8000-000000000099",
    generation: "4",
    applied_generation: "4",
    library_changed: 0,
    activity_changed: 0,
    retired_count: 0,
    sweep_deferred_count: 0,
    enrichment_enqueued: 0
  });
  const parsed = assertM2PublishRowForFixture(row, {
    gameCount: 10_000,
    contentHash: fixture.snapshot.contentHash,
    changed: {
      libraryChanged: 0,
      activityChanged: 0,
      retiredCount: 0,
      sweepDeferredCount: 0,
      enrichmentEnqueued: 0
    }
  });
  assert.equal(parsed.result, "applied");
  assert.equal(parsed.generation, "4");
});

test("maps only one owned claim and preserves queue block metadata", async () => {
  const blocked = await claimOneM2OwnedSnapshot(async () => [{
    claimed: false,
    block_code: "quota_exhausted",
    retry_at: iso(OBSERVATION_TIME + 90)
  }], { lane: "interactive", visibilitySeconds: 15 });
  assert.deepEqual(blocked, {
    status: "not_claimed",
    blockCode: "quota_exhausted",
    retryAt: iso(OBSERVATION_TIME + 90)
  });

  const unrelated = await claimOneM2OwnedSnapshot(async () => [claimRow({ job_kind: "catalog_enrichment" })]);
  assert.deepEqual(unrelated, { status: "invalid_claim_row" });
  const unsafeSteamId = await claimOneM2OwnedSnapshot(async () => [
    claimRow({ provider_subject: "9223372036854775808" })
  ]);
  assert.deepEqual(unsafeSteamId, { status: "invalid_claim_row" });
});

test("renders psql arguments as quoted structured literals without interpolating SQL", () => {
  const query = buildM2PsqlQuery({
    functionName: "ops.publish_owned_snapshot",
    args: [
      JOB_ID,
      LEASE_TOKEN,
      { status: "invalid", provider: "steam", reason: "malformed_response" },
      "canonical'); select pg_sleep(999); --",
      null,
      null,
      "42"
    ]
  }, 60_000, { workerRole: "vault_worker", fixtureMode: true });
  assert.match(query, /ops\.publish_owned_snapshot/);
  assert.match(query, /::jsonb/);
  assert.match(query, /'canonical''\); select pg_sleep\(999\); --'/);
  assert.match(query, /NULL::bytea/);
  assert.match(query, /NULL::timestamptz/);
  assert.match(query, /'42'::bigint/);
  assert.match(query, /begin;/);
  assert.match(query, /set local timezone = 'UTC'/);
  assert.match(query, /set local standard_conforming_strings = on/);
  assert.match(query, /set local role "vault_worker"/);
  assert.match(query, /set local app\.m2_fixture = 'on'/);
  assert.match(query, /commit;/);

  const claimQuery = buildM2PsqlQuery({
    functionName: "ops.claim_job",
    args: ["background", 120]
  }, 60_000, { workerRole: "vault_worker", fixtureMode: true });
  assert.match(claimQuery, /result_row\.message_id::text/);
  assert.match(claimQuery, /result_row\.provider_subject::text/);
  assert.match(claimQuery, /result_row\.generation::text/);
  assert.match(claimQuery, /result_row\.catalog_revision::text/);
});

test("rejects invalid psql call shapes before starting a process", () => {
  assert.throws(() => buildM2PsqlQuery({
    functionName: "ops.claim_job",
    args: ["background", 14]
  }));
  assert.throws(() => buildM2PsqlQuery({
    functionName: "ops.retry_job",
    args: [JOB_ID, LEASE_TOKEN, "code", "detail", null, "retryable", "0"]
  }));
  assert.throws(() => buildM2PsqlQuery({
    functionName: "ops.claim_job",
    args: ["background", 120]
  }, 60_000, { fixtureMode: true }));
  assert.throws(() => buildM2PsqlQuery({
    functionName: "ops.claim_job",
    args: ["background", 120]
  }, 60_000, { workerRole: "vault_worker;drop", fixtureMode: true }));
});
