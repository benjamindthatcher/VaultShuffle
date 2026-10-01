import type {DatabaseClient} from '../db/client.ts';
import type {PinnedAttempt} from '../repositories/pinned-core.ts';
import {fetchV2PinnedObservations} from '../pinned-playtime.ts';
import {SteamApiError} from '../../steam-api-error.ts';

export class BackgroundWorkerRepository {
  private readonly database:DatabaseClient;private readonly deadlineAt:number;
  constructor(database:DatabaseClient,deadlineAt:number){this.database=database;this.deadlineAt=deadlineAt;}
  private async run<T>(operation:(sql:DatabaseClient['sql'])=>Promise<T>) {
    const remaining=this.deadlineAt-Date.now();if(remaining<=0)throw new Error('Worker deadline reached');
    return this.database.sql.begin(async tx=>{
      const timeout=Math.min(20000,remaining);
      await tx`select set_config('statement_timeout',${String(timeout)},true),set_config('lock_timeout',${String(Math.min(5000,timeout))},true)`;
      return operation(tx as unknown as DatabaseClient['sql']);
    }) as Promise<T>;
  }
  scheduleOwned(limit:number){return this.run(async sql=>Number((await sql`select ops.schedule_owned_refresh(${limit}) n`)[0].n));}
  pinTargets(limit:number){return this.run(sql=>sql<{account_id:number;game_id:number;steam_app_id:string}[]>`select * from ops.scheduled_pin_targets(${limit})`);}
  reservePin(accountId:number,gameId:number){return this.run(async sql=>{
    const row=(await sql<{game_id:number;steam_app_id:string;steam_id:string;attempt_id:string;attempt_token:string}[]>`
      select * from ops.reserve_scheduled_pin(${accountId},${gameId})`)[0];
    return row?{gameId:row.game_id,appId:row.steam_app_id,steamId:row.steam_id,attemptId:row.attempt_id,attemptToken:row.attempt_token}:null;
  });}
  publishPin(attempt:PinnedAttempt,minutes:number,lastPlayedAt:string|null){return this.run(async sql=>Boolean((await sql`
    select ops.publish_scheduled_pin(${attempt.attemptId}::uuid,${attempt.attemptToken}::uuid,${sql.json({status:'complete',provider:'steam',appId:attempt.appId,
      playtimeMinutes:minutes,lastPlayedAtEpochSeconds:lastPlayedAt?Math.floor(Date.parse(lastPlayedAt)/1000):null,
      lastPlayedSource:lastPlayedAt?'steam.rtime_last_played':'not_provided'})}) accepted`)[0].accepted));}
  refreshFamily(limit=25){return this.run(async sql=>Number((await sql`select ops.refresh_family_metadata(${limit}) n`)[0].n));}
}

/** Bounded owned pins only; no Library fetch, catalogue write or ownership sweep. */
export async function runScheduledPins(repository:Pick<BackgroundWorkerRepository,'pinTargets'|'reservePin'|'publishPin'>,
  options:{apiKey:string;fetch:typeof fetch;deadlineAt:number}) {
  if(!options.apiKey.trim())throw new Error('Missing Steam worker key');
  const targets=await repository.pinTargets(150);
  const totals={candidates:targets.length,pinsChecked:0,pinsUpdated:0,pinsMissing:0,failed:0,rateLimited:false,deferred:0};
  let failedBatches=0;
  for(let index=0;index<targets.length&&Date.now()+17000<options.deadlineAt&&!totals.rateLimited&&failedBatches<3;index+=3) {
    const attempts=[];
    for(const target of targets.slice(index,index+3)) {
      const attempt=await repository.reservePin(target.account_id,target.game_id);
      if(attempt)attempts.push(attempt);
    }
    const outcomes=await Promise.allSettled(attempts.map(async attempt=>{
      const observation=(await fetchV2PinnedObservations([attempt],options))[0];
      if(!observation)return 'missing';
      try{return await repository.publishPin(attempt,observation.minutes,observation.lastPlayedAt)?'updated':'missing';}
      catch{return await repository.publishPin(attempt,observation.minutes,observation.lastPlayedAt)?'updated':'missing';}
    }));
    let batchFailures=0;
    for(const outcome of outcomes){totals.pinsChecked++;
      if(outcome.status==='fulfilled'){if(outcome.value==='updated')totals.pinsUpdated++;else totals.pinsMissing++;}
      else{totals.failed++;batchFailures++;totals.rateLimited||=outcome.reason instanceof SteamApiError&&outcome.reason.upstreamStatus===429;}}
    failedBatches=batchFailures===attempts.length&&attempts.length>0?failedBatches+1:0;
  }
  totals.deferred=targets.length-totals.pinsChecked;
  return totals;
}
