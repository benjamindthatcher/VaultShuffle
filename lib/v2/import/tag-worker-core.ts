import type {DatabaseClient} from '../db/client.ts';
import {readStorePageTags,sanitizeSteamTags} from '../../steam-tag-model.ts';
import {endlessVerdict,endlessPromotionBlocker} from '../../game-classification.ts';
import {labels,tags as tagWeights} from '../repositories/store-core.ts';
import type {CatalogueClaim} from './catalogue-worker-core.ts';
export type TagProvider='steam_store'|'steamspy';
export type TagClaim=CatalogueClaim&{facts:{genres:unknown;categories:unknown;mainStoryMinutes:number|null;completionistMinutes:number|null;
  durationKind:string|null;durationSource:string|null;durationManualOverride:boolean;gameType:string}};
export type TagResult={appId:string;provider:TagProvider;status:'complete';state:'ok'|'no_tags'|'age_gated'|'unavailable';
  tags:{tag:string;weight:number}[];promoteEndless:boolean}|{appId:string;provider:TagProvider;status:'retryable'|'invalid';rateLimited?:boolean};

export async function fetchCatalogueTags(claim:TagClaim,provider:TagProvider,transport:typeof fetch,signal:AbortSignal):Promise<TagResult> {
  const appId=claim.steam_app_id;
  const base={appId,provider};
  try {
    const url=provider==='steamspy'?`https://steamspy.com/api.php?${new URLSearchParams({request:'appdetails',appid:appId})}`
      :`https://store.steampowered.com/app/${appId}/?cc=us&l=english`;
    const response=await transport(url,{cache:'no-store',redirect:provider==='steamspy'?'error':'follow',signal,
      headers:{'User-Agent':'VaultShuffle metadata worker/1.0',...(provider==='steam_store'
        ?{Accept:'text/html',Cookie:'birthtime=283996801; mature_content=1; lastagecheckage=1-January-1980; Steam_Language=english'}:{Accept:'application/json'})}});
    if(response.status===429)return {...base,status:'retryable',rateLimited:true};
    if(response.status!==200)return {...base,status:'retryable'};
    const reader=response.body?.getReader();if(!reader)return {...base,status:'invalid'};
    const decoder=new TextDecoder();let text='',bytes=0;
    try {while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
      if(bytes>(provider==='steamspy'?65536:2*1024*1024)){await reader.cancel();return {...base,status:'invalid'};}
      text+=decoder.decode(chunk.value,{stream:true});}}finally{reader.releaseLock();}
    text+=decoder.decode();
    let state:'ok'|'no_tags'|'age_gated'|'unavailable',tags:Record<string,number>;
    if(provider==='steamspy') {
      const body=JSON.parse(text);if(String(body?.appid)!==appId)return {...base,status:'invalid'};
      tags=sanitizeSteamTags(body.tags);state=Object.keys(tags).length?'ok':'no_tags';
    }else {
      const verdict=readStorePageTags(Number(appId),text);state=verdict.state;tags=verdict.state==='ok'?verdict.tags:{};
    }
    tags=Object.fromEntries(Object.entries(tags).slice(0,100));
    const f=claim.facts;
    const promoteEndless=state==='ok'&&f.gameType==='game'&&!endlessPromotionBlocker(f)&&endlessVerdict({tags,
      genres:labels(f.genres),categories:labels(f.categories),mainStoryMinutes:f.mainStoryMinutes,completionistMinutes:f.completionistMinutes}).endless;
    return {...base,status:'complete',state,tags:Object.entries(tags).map(([tag,weight])=>({tag,weight})),promoteEndless};
  }catch{return {...base,status:signal.aborted?'retryable':'invalid'};}
}
export class TagWorkerRepository {
  private readonly database:DatabaseClient;private readonly deadlineAt:number;
  constructor(database:DatabaseClient,deadlineAt:number){this.database=database;this.deadlineAt=deadlineAt;}
  private async run<T>(operation:(sql:DatabaseClient['sql'])=>Promise<T>) {
    const remaining=this.deadlineAt-Date.now();if(remaining<=0)throw new Error('Worker deadline reached');
    return this.database.sql.begin(async tx=>{const timeout=Math.min(20000,remaining);
      await tx`select set_config('statement_timeout',${String(timeout)},true),set_config('lock_timeout',${String(Math.min(5000,timeout))},true)`;
      return operation(tx as unknown as DatabaseClient['sql']);}) as Promise<T>;
  }
  queue(provider:TagProvider,limit:number){return this.run(async sql=>Number((await sql`select ops.queue_catalogue_tags(${provider},${limit}) n`)[0].n));}
  claim(provider:TagProvider){return this.run(async sql=>(await sql<TagClaim[]>`select outbox_id::text,lease_token,steam_app_id::text,provider_mode,facts
    from ops.claim_catalogue_tags(${provider})`)[0]??null);}
  finish(claim:TagClaim,result:TagResult){return this.run(async sql=>String((await sql`select ops.finish_catalogue_tags(
    ${claim.outbox_id}::bigint,${claim.lease_token}::uuid,${sql.json(result)}) outcome`)[0].outcome));}
  endlessCandidates(after:number){return this.run(sql=>sql<{game_id:number;feature_revision:number;facts:TagClaim['facts'];weighted_tags:unknown}[]>`
    select * from ops.endless_sweep_candidates(${after},250)`);}
  promoteEndless(games:readonly {game_id:number;feature_revision:number}[]){return this.run(async sql=>Number((await sql`
    select ops.promote_endless_batch(${sql.json([...games])}) n`)[0].n));}

}
export async function runTagWorker(repository:Pick<TagWorkerRepository,'queue'|'claim'|'finish'>,
  provider:TagProvider,options:{fetch:typeof fetch;deadlineAt:number;maxJobs:number}) {
  if(!Number.isInteger(options.maxJobs)||options.maxJobs<1||options.maxJobs>200)throw new Error('Invalid tag batch');
  const totals={queued:await repository.queue(provider,options.maxJobs),claimed:0,published:0,failed:0,stale:0,rateLimited:false};
  let failures=0;
  for(let index=0;index<options.maxJobs&&Date.now()+17000<options.deadlineAt&&failures<3;index++) {
    const claim=await repository.claim(provider);if(!claim||claim.provider_mode!=='live')break;
    totals.claimed++;
    const result=await fetchCatalogueTags(claim,provider,options.fetch,AbortSignal.timeout(15000));
    let outcome:string;
    try{outcome=await repository.finish(claim,result);}catch{outcome=await repository.finish(claim,result);}
    if(outcome==='published'||outcome==='replayed'){totals.published++;failures=0;}
    else if(outcome==='stale')totals.stale++;else{totals.failed++;failures++;}
    if(result.status!=='complete'&&result.rateLimited){totals.rateLimited=true;break;}
    await new Promise(resolve=>setTimeout(resolve,provider==='steamspy'?1100:650));
  }
  return totals;
}

export async function runEndlessSweep(repository:Pick<TagWorkerRepository,'endlessCandidates'|'promoteEndless'>,deadlineAt:number) {
  let after=0,examined=0,promoted=0;
  while(examined<10000&&Date.now()+10000<deadlineAt) {
    const rows=await repository.endlessCandidates(after);if(!rows.length)break;
    const eligible=rows.filter(row=>!endlessPromotionBlocker(row.facts)&&endlessVerdict({tags:tagWeights(row.weighted_tags),
      genres:labels(row.facts.genres),categories:labels(row.facts.categories),mainStoryMinutes:row.facts.mainStoryMinutes,
      completionistMinutes:row.facts.completionistMinutes}).endless).map(row=>({game_id:row.game_id,feature_revision:row.feature_revision}));
    if(eligible.length)promoted+=await repository.promoteEndless(eligible);
    examined+=rows.length;after=rows[rows.length-1].game_id;
    if(rows.length<250)break;
  }
  return {examined,promoted,limitReached:examined===10000};
}
