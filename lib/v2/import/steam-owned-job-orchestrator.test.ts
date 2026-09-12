import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  normalizeSteamOwnedSnapshot,
  type SteamOwnedSnapshot
} from "./steam-owned-snapshot.ts";
import {
  runSteamOwnedSnapshotJob,
  resumeSteamOwnedSnapshotPublish,
  type SteamOwnedJobClaim,
  type SteamOwnedJobDatabase,
  type SteamOwnedJobOrchestratorOptions,
  type SteamOwnedSnapshotPublishCall,
  type SteamOwnedSnapshotPublishResult,
  type SteamOwnedSnapshotRetryCall,
  type SteamOwnedSnapshotRetryResult,
  type SteamOwnedSnapshotTransport
} from "./steam-owned-job-orchestrator.ts";
import { STEAM_COMPLETE_OWNED_SCOPE } from "./steam-owned-fetch.ts";

const OBSERVATION_TIME = 1_800_000_000;
const STEAM_ID = "76561197960265728";

function claim(overrides: Partial<SteamOwnedJobClaim> = {}): SteamOwnedJobClaim {
  return {
    claimed: true,
    jobId: "job-1",
    messageId: "42",
    jobKind: "owned_snapshot",
    accountId: 7,
    gameId: null,
    provider: "steam",
    steamId: STEAM_ID,
    providerMode: "fixture",
    generation: "3",
    catalogRevision: null,
    leaseToken: "lease-1",
    attempt: 1,
    attemptId: "attempt-1",
    attemptToken: "attempt-token-1",
    chargedAt: new Date((OBSERVATION_TIME - 120) * 1_000).toISOString(),
    fetchStartedAt: new Date((OBSERVATION_TIME - 60) * 1_000).toISOString(),
    leaseExpiresAt: new Date((OBSERVATION_TIME + 120) * 1_000).toISOString(),
    ...overrides
  };
}

function completeSnapshot(): SteamOwnedSnapshot & { provenance: typeof STEAM_COMPLETE_OWNED_SCOPE & {
  httpStatus: number;
  bodyBytes: number;
  observationTimeEpochSeconds: number;
} } {
  const providerBody = {
    response: {
      game_count: 1,
      games: [{ appid: 42, name: "A game", playtime_forever: 0 }]
    }
  };
  const normalized = normalizeSteamOwnedSnapshot(providerBody, {
    observationTimeEpochSeconds: OBSERVATION_TIME
  });
  assert.equal(normalized.status, "complete");
  if (normalized.status !== "complete") throw new Error("fixture did not normalize");
  return {
    ...normalized,
    provenance: {
      ...STEAM_COMPLETE_OWNED_SCOPE,
      httpStatus: 200,
      bodyBytes: new TextEncoder().encode(JSON.stringify(providerBody)).byteLength,
      observationTimeEpochSeconds: OBSERVATION_TIME
    }
  };
}

function database(
  calls: {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  },
  overrides: {
    publish?: (call: SteamOwnedSnapshotPublishCall) => Promise<SteamOwnedSnapshotPublishResult>;
    retry?: (call: SteamOwnedSnapshotRetryCall) => Promise<SteamOwnedSnapshotRetryResult>;
  } = {}
): SteamOwnedJobDatabase {
  return {
    publishOwnedSnapshot: async (call) => {
      calls.events.push("publish");
      calls.publish.push(call);
      return overrides.publish?.(call) ?? { result: "applied", acknowledged: true };
    },
    retryJob: async (call) => {
      calls.events.push("retry");
      calls.retry.push(call);
      return overrides.retry?.(call) ?? {
        status: call.retryPolicy,
        retryAt: call.providerRetryAt,
        attempt: 1,
        acknowledged: call.messageId !== null
      };
    }
  };
}

function options(
  db: SteamOwnedJobDatabase,
  transport?: SteamOwnedSnapshotTransport,
  overrides: Partial<SteamOwnedJobOrchestratorOptions> = {}
): SteamOwnedJobOrchestratorOptions {
  return {
    db,
    transports: transport ? { fixture: transport } : undefined,
    nowEpochSeconds: () => OBSERVATION_TIME,
    ...overrides
  };
}

test("runs one claimed fixture attempt, publishes canonical text/hash, and relies on atomic acknowledgement", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const snapshot = completeSnapshot();
  const seenClaims: SteamOwnedJobClaim[] = [];
  const transport: SteamOwnedSnapshotTransport = async (receivedClaim, signal) => {
    calls.events.push("fetch");
    seenClaims.push(receivedClaim);
    assert.equal(signal.aborted, false);
    return snapshot;
  };

  const result = await runSteamOwnedSnapshotJob(claim(), options(database(calls), transport));

  assert.deepEqual(result, { status: "published", result: "applied", acknowledged: true });
  assert.equal(seenClaims.length, 1);
  assert.equal(seenClaims[0]?.steamId, STEAM_ID);
  assert.deepEqual(calls.events, ["fetch", "publish"]);
  assert.equal(calls.retry.length, 0);
  assert.equal(calls.publish.length, 1);
  const publish = calls.publish[0];
  assert.equal(publish.jobId, "job-1");
  assert.equal(publish.leaseToken, "lease-1");
  assert.equal(publish.messageId, "42");
  assert.equal(publish.canonicalJson, snapshot.canonicalJson);
  const expectedHash = new Uint8Array(32);
  for (let index = 0; index < expectedHash.length; index += 1) {
    expectedHash[index] = Number.parseInt(snapshot.contentHash.slice(index * 2, index * 2 + 2), 16);
  }
  assert.deepEqual([...((publish.contentHash ?? new Uint8Array()) as Uint8Array)], [...expectedHash]);
  assert.equal(publish.bodyObservedAt, new Date(OBSERVATION_TIME * 1_000).toISOString());
  assert.deepEqual(publish.result, {
    status: "complete",
    provider: "steam",
    protocolVersion: 1,
    gameCount: 1,
    scope: "complete_owned",
    includeAppInfo: true,
    includePlayedFreeGames: true,
    skipUnvettedApps: false,
    httpStatus: 200,
    bodyBytes: snapshot.provenance.bodyBytes
  });
  assert.equal("games" in publish.result, false);
});

test("does not poll a shared lane or invoke a live/default network transport", async () => {
  let fetchCalls = 0;
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const db = database(calls);
  const result = await runSteamOwnedSnapshotJob(claim({ providerMode: "live" }), options(db));
  assert.deepEqual(result, { status: "refused", reason: "live_transport_required" });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls.events, []);

  const disabled = await runSteamOwnedSnapshotJob(claim({ providerMode: "disabled" }), options(db, async () => {
    fetchCalls += 1;
    return completeSnapshot();
  }));
  assert.deepEqual(disabled, { status: "refused", reason: "provider_disabled" });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls.events, []);
});

test("refuses an expired or malformed claim before invoking the transport", async () => {
  let transportCalls = 0;
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const transport: SteamOwnedSnapshotTransport = async () => {
    transportCalls += 1;
    return completeSnapshot();
  };
  const expired = await runSteamOwnedSnapshotJob(claim({
    leaseExpiresAt: new Date((OBSERVATION_TIME - 1) * 1_000).toISOString()
  }), options(database(calls), transport));
  assert.deepEqual(expired, { status: "refused", reason: "claim_expired" });

  const malformed = await runSteamOwnedSnapshotJob(claim({
    fetchStartedAt: "2026-09-06 16:00:00+00"
  }), options(database(calls), transport));
  assert.deepEqual(malformed, { status: "refused", reason: "invalid_claim_time" });

  const future = await runSteamOwnedSnapshotJob(claim({
    chargedAt: new Date((OBSERVATION_TIME + 600) * 1_000).toISOString(),
    fetchStartedAt: new Date((OBSERVATION_TIME + 600) * 1_000).toISOString(),
    leaseExpiresAt: new Date((OBSERVATION_TIME + 900) * 1_000).toISOString()
  }), options(database(calls), transport));
  assert.deepEqual(future, { status: "refused", reason: "invalid_claim_time" });
  assert.equal(transportCalls, 0);
  assert.deepEqual(calls.events, []);
});

test("rejects malformed or caller-shaped claims before transport or DB mutation", async () => {
  let transportCalls = 0;
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const transport: SteamOwnedSnapshotTransport = async () => {
    transportCalls += 1;
    return completeSnapshot();
  };
  for (const malformed of [
    claim({ jobKind: "catalog_enrichment" as "owned_snapshot" }),
    claim({ provider: "other" as "steam" }),
    claim({ steamId: "9223372036854775808" }),
    claim({ messageId: "0" }),
    claim({ claimed: false as true })
  ]) {
    const result = await runSteamOwnedSnapshotJob(malformed, options(database(calls), transport));
    assert.deepEqual(result, { status: "refused", reason: "invalid_claim" });
  }
  assert.equal(transportCalls, 0);
  assert.deepEqual(calls.events, []);
});

test("publishes private/provider errors and invalid results without canonical data or raw details", async () => {
  for (const fetched of [
    { status: "unavailable", provider: "steam", reason: "private" } as const,
    { status: "unavailable", provider: "steam", reason: "provider_error", detail: "secret body" } as const,
    { status: "invalid", provider: "steam", reason: "invalid_name", detail: "secret title" } as const
  ]) {
    const calls = { publish: [], retry: [], events: [] } as {
      publish: SteamOwnedSnapshotPublishCall[];
      retry: SteamOwnedSnapshotRetryCall[];
      events: string[];
    };
    const result = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => fetched));
    assert.equal(result.status, "published");
    assert.equal(calls.publish.length, 1);
    const publish = calls.publish[0];
    assert.equal(publish.canonicalJson, null);
    assert.equal(publish.contentHash, null);
    assert.equal(publish.bodyObservedAt, null);
    assert.equal(JSON.stringify(publish).includes("secret"), false);
    if (fetched.reason === "private" || fetched.reason === "provider_error") {
      assert.deepEqual(publish.result, {
        status: "unavailable",
        provider: "steam",
        reason: fetched.reason
      });
    } else {
      assert.deepEqual(publish.result, {
        status: "invalid",
        provider: "steam",
        reason: "invalid_name"
      });
    }
  }
});

test("schedules transient outcomes and atomically settles deferred queue messages", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const retryable = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => ({
    status: "unavailable",
    provider: "steam",
    reason: "http_error",
    httpStatus: 429,
    retryAfterSeconds: 7_200,
    retryDisposition: "retryable"
  })));
  assert.equal(retryable.status, "retry_scheduled");
  assert.equal(calls.publish.length, 0);
  assert.equal(calls.retry.length, 1);
  assert.equal(calls.retry[0].messageId, null);
  assert.equal(calls.retry[0].retryPolicy, "retryable");
  assert.equal(calls.retry[0].providerRetryAt, new Date((OBSERVATION_TIME + 7_200) * 1_000).toISOString());
  assert.equal(calls.retry[0].errorCode, "steam_http_error");
  assert.equal(JSON.stringify(calls.retry[0]).includes("429"), true);

  calls.events.length = 0;
  const deferred = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => ({
    status: "unavailable",
    provider: "steam",
    reason: "http_error",
    httpStatus: 503,
    retryDisposition: "deferred"
  })));
  assert.equal(deferred.status, "retry_scheduled");
  assert.equal(calls.retry.length, 2);
  assert.equal(calls.retry[1].retryPolicy, "deferred");
  assert.equal(calls.retry[1].providerRetryAt, null);
  assert.equal(calls.retry[1].messageId, "42");
  assert.deepEqual(calls.events, ["retry"]);
});

test("maps cancellation to a non-retryable transition and transport throws to a safe retry", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const cancelled = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => ({
    status: "unavailable",
    provider: "steam",
    reason: "cancelled"
  })));
  assert.equal(cancelled.status, "retry_scheduled");
  assert.equal(calls.retry[0].retryPolicy, "non_retryable");
  assert.equal(calls.retry[0].errorCode, "steam_cancelled");

  const thrown = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => {
    throw new Error("secret database-like transport detail");
  }));
  assert.equal(thrown.status, "retry_scheduled");
  assert.equal(calls.retry[1].errorCode, "steam_transport_error");
  assert.equal(JSON.stringify(calls.retry[1]).includes("secret"), false);
});

test("defers when a supplied provider delay cannot be converted by the injected clock", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  let clockCalls = 0;
  const result = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => ({
    status: "unavailable",
    provider: "steam",
    reason: "http_error",
    httpStatus: 429,
    retryAfterSeconds: 7_200,
    retryDisposition: "retryable"
  }), {
    nowEpochSeconds: () => {
      clockCalls += 1;
      if (clockCalls === 1) return OBSERVATION_TIME;
      throw new Error("clock unavailable");
    }
  }));
  assert.equal(result.status, "retry_scheduled");
  assert.equal(calls.retry.length, 1);
  assert.equal(calls.retry[0].retryPolicy, "deferred");
  assert.equal(calls.retry[0].providerRetryAt, null);
  assert.equal(calls.retry[0].messageId, "42");
  assert.equal(calls.retry[0].errorCode, "steam_retry_deferred");
});

test("does not report success for stale, unacknowledged, or failed DB transitions", async () => {
  const snapshot = completeSnapshot();
  const staleCalls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const stale = await runSteamOwnedSnapshotJob(claim(), options(database(staleCalls, {
    publish: async () => ({ result: "stale", acknowledged: false })
  }), async () => snapshot));
  assert.deepEqual(stale, { status: "stale", phase: "publish" });

  const unacknowledgedCalls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const unacknowledged = await runSteamOwnedSnapshotJob(claim(), options(database(unacknowledgedCalls, {
    publish: async () => ({ result: "applied", acknowledged: false })
  }), async () => snapshot));
  assert.equal(unacknowledged.status, "db_error");
  if (unacknowledged.status === "db_error") {
    assert.equal(unacknowledged.phase, "publish");
    assert.equal(unacknowledged.code, "publish_not_acknowledged");
    assert.ok(unacknowledged.preparedPublish);
  }

  const dbFailureCalls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const dbFailure = await runSteamOwnedSnapshotJob(claim(), options(database(dbFailureCalls, {
    publish: async () => {
      throw new Error("secret SQL details");
    }
  }), async () => snapshot));
  assert.equal(dbFailure.status, "db_error");
  if (dbFailure.status === "db_error") {
    assert.equal(dbFailure.phase, "publish");
    assert.equal(dbFailure.code, "publish_failed");
    assert.ok(dbFailure.preparedPublish);
  }
  assert.equal(JSON.stringify(dbFailure).includes("secret"), false);
});

test("resumes a prepared publish after commit-then-throw without a second fetch", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const snapshot = completeSnapshot();
  let fetchCalls = 0;
  let committed = false;
  const db = database(calls, {
    publish: async () => {
      if (!committed) {
        committed = true;
        throw new Error("response lost after commit");
      }
      return { result: "already_applied", acknowledged: true };
    }
  });
  const first = await runSteamOwnedSnapshotJob(claim(), options(db, async () => {
    fetchCalls += 1;
    return snapshot;
  }));
  assert.equal(first.status, "db_error");
  if (first.status !== "db_error") return;
  assert.equal(first.code, "publish_failed");
  assert.ok(first.preparedPublish);
  assert.equal(JSON.stringify(first).includes(snapshot.canonicalJson), false);

  const replay = await resumeSteamOwnedSnapshotPublish(first.preparedPublish, { db });
  assert.deepEqual(replay, { status: "published", result: "already_applied", acknowledged: true });
  assert.equal(fetchCalls, 1);
  assert.equal(calls.publish.length, 2);
  assert.equal(calls.publish[0].canonicalJson, calls.publish[1].canonicalJson);
  assert.deepEqual([...((calls.publish[0].contentHash ?? new Uint8Array()) as Uint8Array)], [
    ...((calls.publish[1].contentHash ?? new Uint8Array()) as Uint8Array)
  ]);
});

test("downgrades a forged complete transport result to bounded invalid publication", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const snapshot = completeSnapshot();
  const forged = {
    ...snapshot,
    contentHash: "0".repeat(64)
  };
  const result = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => forged));
  assert.deepEqual(result, { status: "published", result: "applied", acknowledged: true });
  assert.deepEqual(calls.events, ["publish"]);
  assert.equal(calls.publish.length, 1);
  assert.deepEqual(calls.publish[0].result, {
    status: "invalid",
    provider: "steam",
    reason: "malformed_response"
  });
  assert.equal(calls.publish[0].canonicalJson, null);
  assert.equal(calls.publish[0].contentHash, null);
});

test("rejects malformed canonical game strings even when their forged hash matches", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const snapshot = completeSnapshot();
  const malformedGames = [{ ...snapshot.games[0], name: "\ud800" }];
  const canonicalJson = JSON.stringify({
    provider: "steam",
    protocolVersion: 1,
    gameCount: 1,
    games: malformedGames
  });
  const forged = {
    ...snapshot,
    games: malformedGames,
    canonicalJson,
    contentHash: createHash("sha256").update(canonicalJson, "utf8").digest("hex")
  };
  const result = await runSteamOwnedSnapshotJob(claim(), options(database(calls), async () => forged));
  assert.deepEqual(result, { status: "published", result: "applied", acknowledged: true });
  assert.deepEqual(calls.publish[0].result, {
    status: "invalid",
    provider: "steam",
    reason: "malformed_response"
  });
  assert.equal(calls.publish[0].canonicalJson, null);
});

test("returns stale retry state without treating it as an acknowledgement", async () => {
  const calls = { publish: [], retry: [], events: [] } as {
    publish: SteamOwnedSnapshotPublishCall[];
    retry: SteamOwnedSnapshotRetryCall[];
    events: string[];
  };
  const result = await runSteamOwnedSnapshotJob(claim(), options(database(calls, {
    retry: async () => ({ status: "stale", retryAt: null, attempt: 1, acknowledged: false })
  }), async () => ({
    status: "unavailable",
    provider: "steam",
    reason: "timeout"
  })));
  assert.deepEqual(result, { status: "stale", phase: "retry" });
  assert.equal(calls.retry.length, 1);
});
