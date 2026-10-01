import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/** Local PostgreSQL regression for the unapplied M3 recommendation precision correction. */
const PSQL = process.env.VS_M3_RECO_PSQL ?? "psql";
const CONNECTION = [
  "-h", process.env.VS_M3_RECO_PGHOST ?? "/tmp/vs-m3-reco",
  "-p", process.env.VS_M3_RECO_PGPORT ?? "55499",
  "-U", process.env.VS_M3_RECO_PGUSER ?? "vsreco",
  "-d", process.env.VS_M3_RECO_PGDATABASE ?? "vaultshuffle_m3_reco",
] as const;

function sql(statement: string): string {
  const result = spawnSync(
    PSQL,
    [...CONNECTION, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: statement, encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("the correction keeps the table boundary while widening only its three measured counters", () => {
  assert.equal(sql(`
    select string_agg(attname || '=' || format_type(atttypid, atttypmod), ',' order by attnum)
    from pg_attribute
    where attrelid = 'reco.game_preference_globals'::regclass
      and attname in ('positive', 'total', 'total_hours') and not attisdropped;
  `), "positive=numeric,total=numeric,total_hours=numeric");
  assert.equal(sql(`
    select relrowsecurity::text || '|' || relforcerowsecurity::text || '|' ||
      (select count(*) from pg_constraint where conrelid = c.oid and contype = 'f') || '|' ||
      (select count(*) from pg_indexes where schemaname = 'reco' and tablename = c.relname) || '|' ||
      (select count(*) from pg_policies where schemaname = 'reco' and tablename = c.relname)
    from pg_class c where c.oid = 'reco.game_preference_globals'::regclass;
  `), "true|true|2|2|1");
});

test("PostgreSQL preserves exact long decimals and rejects nonfinite or invalid ordering", () => {
  assert.equal(sql(`
    begin;
    with snapshot as (
      insert into reco.warm_start_snapshots
        (snapshot_key, snapshot_version, status, frozen_at)
      values ('reco-precision-regression', 1, 'frozen', '2026-09-14 00:00:00+00'::timestamptz)
      returning id
    )
    insert into reco.game_preference_globals
      (snapshot_id, steam_app_id, positive, total, total_hours)
    select id, 440, '0.30000000000000004'::numeric,
      '1.2345678901234567e+20'::numeric, '1.0000000000000003e+20'::numeric
    from snapshot;
    select (positive::text = '0.30000000000000004'
      and total::text = '123456789012345670000'
      and total_hours::text = '100000000000000030000')::text
    from reco.game_preference_globals where steam_app_id = 440;
    rollback;
  `), "true");

  for (const tuple of [
    "'Infinity'::numeric, 'Infinity'::numeric, 0",
    "0, 'NaN'::numeric, 0",
    "0, 0, '-Infinity'::numeric",
    "2, 1, 0",
  ]) {
    const result = spawnSync(
      PSQL,
      [...CONNECTION, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c",
        `with snapshot as (
           insert into reco.warm_start_snapshots (snapshot_key, snapshot_version, status, frozen_at)
           values ('reco-precision-invalid', 1, 'frozen', '2026-09-14 00:00:00+00'::timestamptz)
           on conflict (snapshot_key, snapshot_version) do update set status = excluded.status
           returning id
         )
         insert into reco.game_preference_globals (snapshot_id, steam_app_id, positive, total, total_hours)
         select id, 440, ${tuple} from snapshot`],
      { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } },
    );
    assert.notEqual(result.status, 0, "invalid numeric tuple unexpectedly satisfied the target checks");
  }
});
