import type {DatabaseClient} from '../db/client.ts';
import {claimOneM2OwnedSnapshot,createM2SqlDatabase,type M2SqlInvoker} from './steam-owned-sql-harness.ts';
import {runSteamOwnedSnapshotJob,resumeSteamOwnedSnapshotPublish} from './steam-owned-job-orchestrator.ts';
import {fetchSteamOwnedSnapshot,type SteamOwnedGamesFetch} from './steam-owned-fetch.ts';

/** Fixed parameterized calls to the existing engine; no generic SQL/RPC endpoint. */
export function createOwnedWorkerInvoker(database:DatabaseClient,options:{deadlineAt?:number}={}):M2SqlInvoker {
  return async call=>{
    const remaining=options.deadlineAt===undefined?20000:Math.floor(options.deadlineAt-Date.now());
    if(remaining<=0)throw new Error('Worker deadline reached');
    return database.sql.begin(async sql=>{
      const timeout=Math.min(20000,remaining);
      await sql`select set_config('statement_timeout',${String(timeout)},true),set_config('lock_timeout',${String(Math.min(5000,timeout))},true)`;
      const a=call.args;
      if(call.functionName==='ops.claim_job')return sql`select * from ops.claim_job(${a[0] as string},${a[1] as number})`;
      if(call.functionName==='ops.publish_owned_snapshot')return sql`select * from ops.publish_owned_snapshot(
        ${a[0] as string}::uuid,${a[1] as string}::uuid,${sql.json(a[2] as never)},${a[3] as string|null},
        ${a[4]===null?null:Buffer.from(a[4] as Uint8Array)},${a[5] as string|null}::text::timestamptz,${a[6] as string|null}::bigint)`;
      if(call.functionName==='ops.retry_job')return sql`select * from ops.retry_job(
        ${a[0] as string}::uuid,${a[1] as string}::uuid,${a[2] as string},${a[3] as string},${a[4] as string|null}::text::timestamptz,${a[5] as string},${a[6] as string|null}::bigint)`;
      throw new Error('Unsupported worker operation');
    });
  };
}

export async function runOwnedWorkerBatch(options:{sql:M2SqlInvoker;apiKey:string;fetch:SteamOwnedGamesFetch;nowEpochSeconds:()=>number;
  lane:'interactive'|'background';maxJobs:number;signal?:AbortSignal}) {
  if(!options.apiKey.trim()||!Number.isInteger(options.maxJobs)||options.maxJobs<1||options.maxJobs>3)throw new Error('Invalid worker configuration');
  const db=createM2SqlDatabase(options.sql),summary={claimed:0,published:0,retryScheduled:0,stale:0,failed:0};
  for(let index=0;index<options.maxJobs&&!options.signal?.aborted;index++) {
    const selected=await claimOneM2OwnedSnapshot(options.sql,{lane:options.lane,visibilitySeconds:120});
    if(selected.status==='not_claimed')break;
    if(selected.status!=='claimed'){summary.failed++;break;}
    summary.claimed++;
    let result=await runSteamOwnedSnapshotJob(selected.claim,{db,nowEpochSeconds:options.nowEpochSeconds,signal:options.signal,
      transports:{live:(claim,signal)=>fetchSteamOwnedSnapshot(claim.steamId,options.apiKey,{fetch:options.fetch,nowEpochSeconds:options.nowEpochSeconds,signal})}});
    // One bounded response-loss replay, without spending quota or fetching again.
    if(result.status==='db_error'&&result.preparedPublish)result=await resumeSteamOwnedSnapshotPublish(result.preparedPublish,{db});
    if(result.status==='published')summary.published++;
    else if(result.status==='retry_scheduled')summary.retryScheduled++;
    else if(result.status==='stale')summary.stale++;
    else {summary.failed++;break;}
  }
  return summary;
}
