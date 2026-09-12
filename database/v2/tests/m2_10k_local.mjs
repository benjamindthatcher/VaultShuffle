#!/usr/bin/env node

/*
 * Run the real Steam-owned normalizer and its exact M2 SQL adapter against an
 * isolated local PG17 database. This is intentionally an opt-in integration
 * benchmark: it uses an explicitly supplied setup/admin login, switches to
 * each runtime role with transaction-local SET LOCAL ROLE, enables the
 * database fixture provider, and restores only fixture rows/settings. It
 * never changes cluster role memberships, reads credentials, or contacts a
 * provider.
 */

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  createPsqlM2SqlInvoker,
  runSteamOwned10kFixtureAgainstM2Sql
} from "../../../lib/v2/import/steam-owned-sql-harness.ts";
import { createSteamOwned10kFixture } from "../../../lib/v2/import/steam-owned-10k-fixture.ts";

const config = {
  psql: process.env.M2_PSQL ?? "/tmp/vaultshuffle-pg17/bin/psql",
  host: process.env.PGHOST ?? "/tmp/vaultshuffle-pg17-socket",
  port: process.env.PGPORT ?? "55432",
  database: process.env.PGDATABASE ?? "vaultshuffle_m2_capability_rebuild"
};
const adminUser = process.env.M2_ADMIN_USER;
if (typeof adminUser !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(adminUser)) {
  throw new Error("M2_ADMIN_USER must be an explicitly supplied local setup login");
}

function sqlText(value) {
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw new Error("unsafe SQL text");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function command(args) {
  return [
    "-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1",
    "-h", config.host,
    "-p", config.port,
    "-U", adminUser,
    "-d", config.database,
    ...args
  ];
}

function psql(input, timeout = 120_000) {
  const result = spawnSync(config.psql, command(["-f", "-"]), {
    input,
    encoding: "utf8",
    timeout,
    env: { LC_ALL: "C", PAGER: "cat", PSQL_PAGER: "off" }
  });
  if (result.error || result.status !== 0) {
    throw new Error("local psql setup query failed");
  }
  return result.stdout.trim();
}

function scalar(input) {
  const output = psql(input);
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("local psql query returned no scalar");
  return lines.at(-1);
}

function jsonScalar(input) {
  try {
    return JSON.parse(scalar(input));
  } catch {
    throw new Error("local psql setup query returned invalid JSON");
  }
}

function runSetup(input) {
  psql(input, 120_000);
}

function assertPublishSummary(row, expected) {
  if (!row || row.result !== "applied" || row.observedCount !== 10_000
    || row.snapshotHash === null
    || Buffer.from(row.snapshotHash).toString("hex") !== fixture.snapshot.contentHash) {
    throw new Error("M2 10k publish summary did not preserve the exact fixture hash/count");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (row[field] !== value) {
      throw new Error(`M2 10k publish ${field} expected ${value}, got ${row[field]}`);
    }
  }
}

let accountId = null;
let accountPublicId = null;
let providerControl = null;
let globalBucket = null;
let globalDaily = null;
let fixture = null;
let providerModeChanged = false;

function restore() {
  const cleanup = [];
  if (accountId !== null) {
    // Queue messages outlive an account row, so remove only this fixture's
    // message before the account cascade.  Successful publishes already ACK.
    cleanup.push(`
select pgmq.delete(j.queue_name, j.message_id)
  from ops.jobs as j
 where j.account_id = ${accountId}
   and j.message_id is not null
   and not j.queue_acknowledged;
delete from app.accounts where id = ${accountId};
delete from ops.enrichment_outbox
 where game_id in (
   select id from catalog.games
    where steam_app_id between 1 and 9999 or steam_app_id = 4294967295
 );
delete from catalog.games
 where steam_app_id between 1 and 9999 or steam_app_id = 4294967295;
`);
  }
  if (globalDaily?.exists) {
    cleanup.push(`
update ops.provider_quota_daily
   set daily_limit = ${globalDaily.dailyLimit},
       charged_units = ${globalDaily.chargedUnits},
       updated_at = clock_timestamp()
 where provider = 'steam'
   and usage_date = (clock_timestamp() at time zone 'UTC')::date
   and lane_scope = 'all';
`);
  } else {
    cleanup.push(`
delete from ops.provider_quota_daily
 where provider = 'steam'
   and usage_date = (clock_timestamp() at time zone 'UTC')::date
   and lane_scope = 'all';
`);
  }
  if (globalBucket) {
    cleanup.push(`
update ops.provider_token_buckets
   set capacity = ${sqlText(globalBucket.capacity)},
       refill_per_second = ${sqlText(globalBucket.refillPerSecond)},
       tokens = ${sqlText(globalBucket.tokens)},
       last_refilled_at = ${sqlText(globalBucket.lastRefilledAt)}::timestamptz,
       updated_at = clock_timestamp()
 where provider = 'steam' and bucket_scope = 'global';
`);
  }
  if (providerControl && providerModeChanged) {
    cleanup.push(`
update ops.provider_controls
   set mode = ${sqlText(providerControl.mode)},
       reason = ${sqlText(providerControl.reason)},
       updated_at = clock_timestamp()
 where provider = 'steam';
`);
  }
  if (cleanup.length > 0) {
    try {
      runSetup(cleanup.join("\n"));
    } catch {
      process.stderr.write("M2 benchmark cleanup query failed\n");
    }
  }
}

try {
  // Refuse to run over an existing fixture catalogue.  The benchmark creates
  // the fixed AppID set, and a clean rebuild is the portable repeatable path.
  const existing = Number(scalar(`
select count(*)
  from catalog.games
 where steam_app_id between 1 and 9999 or steam_app_id = 4294967295;
`));
  if (!Number.isInteger(existing) || existing !== 0) {
    throw new Error("benchmark database contains fixed-fixture AppIDs; use a clean M2 rebuild");
  }

  providerControl = jsonScalar(`
select json_build_object('mode', mode, 'reason', reason)
  from ops.provider_controls where provider = 'steam';
`);
  globalBucket = jsonScalar(`
select json_build_object(
  'capacity', capacity::text,
  'refillPerSecond', refill_per_second::text,
  'tokens', tokens::text,
  'lastRefilledAt', last_refilled_at
)
  from ops.provider_token_buckets
 where provider = 'steam' and bucket_scope = 'global';
`);
  globalDaily = jsonScalar(`
select coalesce(
  (
    select json_build_object(
      'exists', true,
      'dailyLimit', daily_limit,
      'chargedUnits', charged_units
    )
      from ops.provider_quota_daily
     where provider = 'steam'
       and usage_date = (clock_timestamp() at time zone 'UTC')::date
       and lane_scope = 'all'
  ),
  json_build_object('exists', false)
);
`);
  if (!globalDaily || globalDaily.exists !== true) globalDaily = { exists: false };

  // SET LOCAL ROLE is transaction-scoped. The setup login must already have
  // permission to assume both runtime roles; this check never changes role
  // memberships and fails before any fixture rows are modified.
  runSetup(`
begin;
set local role vault_app;
reset role;
set local role vault_worker;
rollback;
`);
  runSetup(`
update ops.provider_controls
   set mode = 'fixture', reason = 'M2 local 10k benchmark', updated_at = clock_timestamp()
 where provider = 'steam';
update ops.provider_token_buckets
   set tokens = capacity, last_refilled_at = clock_timestamp(), updated_at = clock_timestamp()
 where provider = 'steam' and bucket_scope = 'global';
update ops.provider_quota_daily
   set charged_units = 0, updated_at = clock_timestamp()
 where provider = 'steam'
   and usage_date = (clock_timestamp() at time zone 'UTC')::date
   and lane_scope = 'all';
`);
  providerModeChanged = true;

  accountPublicId = randomUUID();
  accountId = Number(scalar(`
insert into app.accounts(public_id, account_kind, display_name)
values (${sqlText(accountPublicId)}::uuid, 'manual', 'M2 local 10k benchmark')
returning id;
`));
  if (!Number.isInteger(accountId) || accountId < 1) throw new Error("benchmark account was not created");
  const steamId = String(76561199000000000n + BigInt(accountId));
  runSetup(`
insert into app.steam_profiles(account_id, steam_id, verified, display_name)
values (${accountId}, ${steamId}, false, 'M2 local 10k benchmark');
`);

  function requestJob() {
    return jsonScalar(`
begin;
set local role vault_app;
set local app.m2_fixture = 'on';
set local app.account_id = ${sqlText(String(accountId))};
select row_to_json(r)
  from app.request_owned_snapshot(${sqlText(randomUUID())}::uuid, 'interactive') as r;
commit;
`);
  }

  const firstRequest = requestJob();
  if (firstRequest.status !== "enqueued" || !firstRequest.job_id) {
    throw new Error("benchmark first request did not enqueue");
  }

  fixture = createSteamOwned10kFixture();
  const invoker = createPsqlM2SqlInvoker({
    psqlPath: config.psql,
    host: config.host,
    port: Number(config.port),
    user: adminUser,
    database: config.database,
    workerRole: "vault_worker",
    fixtureMode: true,
    timeoutMs: 120_000
  });
  let phase = "first";
  let publishStartedAt = null;
  const publishMeasurements = [];
  const hooks = {
    onCall(call) {
      if (call.functionName === "ops.publish_owned_snapshot") {
        publishStartedAt = performance.now();
      }
    },
    onPublishRow(row) {
      if (publishStartedAt === null) throw new Error("publish completion lacked a start timestamp");
      publishMeasurements.push({ phase, elapsedMs: performance.now() - publishStartedAt, row });
      publishStartedAt = null;
    }
  };
  const nowEpochSeconds = () => Math.floor(Date.now() / 1_000);

  const first = await runSteamOwned10kFixtureAgainstM2Sql({
    sql: invoker,
    nowEpochSeconds,
    lane: "interactive",
    visibilitySeconds: 120,
    fixture,
    hooks
  });
  if (first.status !== "ran" || first.result.status !== "published") {
    throw new Error("benchmark first SQL run did not publish");
  }
  if (first.result.result !== "applied" || !first.result.acknowledged || first.fetchCount !== 1) {
    throw new Error("benchmark first SQL run returned an unexpected terminal result");
  }
  const firstMeasurement = publishMeasurements.at(-1);
  if (!firstMeasurement) throw new Error("benchmark first publish was not measured");
  assertPublishSummary(firstMeasurement.row, {
    libraryChanged: 10_000,
    retiredCount: 0,
    sweepDeferredCount: 0,
    enrichmentEnqueued: 10_000
  });

  const secondRequest = requestJob();
  if (secondRequest.status !== "enqueued" || !secondRequest.job_id) {
    throw new Error("benchmark second request did not enqueue");
  }
  phase = "second_noop";
  const second = await runSteamOwned10kFixtureAgainstM2Sql({
    sql: invoker,
    nowEpochSeconds,
    lane: "interactive",
    visibilitySeconds: 120,
    fixture,
    hooks
  });
  if (second.status !== "ran" || second.result.status !== "published") {
    throw new Error("benchmark second SQL run did not publish");
  }
  if (second.result.result !== "applied" || !second.result.acknowledged || second.fetchCount !== 1) {
    throw new Error("benchmark second SQL run returned an unexpected terminal result");
  }
  const secondMeasurement = publishMeasurements.at(-1);
  if (!secondMeasurement) throw new Error("benchmark second publish was not measured");
  assertPublishSummary(secondMeasurement.row, {
    libraryChanged: 0,
    activityChanged: 0,
    retiredCount: 0,
    sweepDeferredCount: 0,
    enrichmentEnqueued: 0
  });
  if (firstMeasurement.elapsedMs > 5_000 || secondMeasurement.elapsedMs > 5_000) {
    process.stderr.write(`M2 publish measurements: ${JSON.stringify(publishMeasurements.map(({ phase: itemPhase, elapsedMs, row }) => ({
      phase: itemPhase,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      libraryChanged: row.libraryChanged,
      activityChanged: row.activityChanged,
      enrichmentEnqueued: row.enrichmentEnqueued
    })))}\n`);
    throw new Error("M2 publish transaction exceeded the 5 second local budget");
  }

  const counts = jsonScalar(`
select json_build_object(
  'library', (select count(*) from app.library_games where account_id = ${accountId}),
  'activity', (select count(*) from app.game_activity where account_id = ${accountId}),
  'catalogue', (select count(*) from catalog.games
    where steam_app_id between 1 and 9999 or steam_app_id = 4294967295),
  'successful_jobs', (select count(*) from ops.jobs
    where account_id = ${accountId} and status = 'succeeded')
);
`);
  if (counts.library !== 10_000 || counts.catalogue !== 10_000 || counts.successful_jobs !== 2) {
    throw new Error("benchmark row counts do not match the 10k fixture");
  }

  process.stdout.write(`${JSON.stringify({
    database: config.database,
    fixture: {
      providerBodyBytes: fixture.providerBodyBytes,
      canonicalBytes: new TextEncoder().encode(fixture.snapshot.canonicalJson).byteLength,
      contentHash: fixture.snapshot.contentHash,
      gameCount: fixture.snapshot.gameCount
    },
    first: {
      result: first.result,
      publishElapsedMs: Number(firstMeasurement.elapsedMs.toFixed(2)),
      row: firstMeasurement.row
    },
    secondNoop: {
      result: second.result,
      publishElapsedMs: Number(secondMeasurement.elapsedMs.toFixed(2)),
      row: secondMeasurement.row
    },
    counts
  })}\n`);
} finally {
  restore();
}
