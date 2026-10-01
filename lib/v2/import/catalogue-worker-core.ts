import type {DatabaseClient} from '../db/client.ts';
import {steamDetailPayload} from '../../steam-store-details.ts';
import {classifyCatalogueEntry} from '../../catalogue-classification.ts';
import {setTimeout as delay} from 'node:timers/promises';

export type CatalogueClaim={outbox_id:string;lease_token:string;steam_app_id:string;provider_mode:'fixture'|'live';known_deck?:number|null};
export type CatalogueResult={appId:string;status:'complete';details:ReturnType<typeof normalizeDetails>}|
  {appId:string;status:'unavailable'|'retryable'|'invalid';rateLimited?:boolean};

function normalizeDetails(appId:string,data:Record<string,unknown>) {
  const detail=steamDetailPayload(appId,data);
  const title=(detail.title??'').trim().slice(0,500);
  if(typeof data.name!=='string'||typeof data.is_free!=='boolean')throw new Error('invalid_details');
  const platforms=data.platforms as Record<string,unknown>|undefined;
  const platform=(key:string)=>typeof platforms?.[key]==='boolean'?(platforms[key]?'supported':'unsupported'):'unknown';
  const price=(value:number|undefined)=>Number.isInteger(value)&&value!>=0&&value!<=2147483647?value!:null;
  if(!title)throw new Error('missing_title');
  const labels=(value:string[]|undefined)=>(value??[]).slice(0,100).map(label=>label.slice(0,200));
  const genres=labels(detail.genres),categories=labels(detail.categories);
  const verdict=classifyCatalogueEntry({title,steamType:detail.steam_type,fullGameAppId:detail.full_game_appid,
    genres:[...genres,...categories],isFree:detail.is_free,priceFinal:detail.price_final});
  return {title,sortTitle:title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()||title.toLowerCase(),
    shortDescription:detail.short_description?.slice(0,10000)??null,headerUrl:detail.header_url?.slice(0,2048)??null,
    capsuleUrl:detail.capsule_url?.slice(0,2048)??null,genres,categories,developer:detail.developers?.join(', ').slice(0,1000)??null,
    publisher:detail.publishers?.join(', ').slice(0,1000)??null,releaseDate:detail.release_date??null,
    windows:platform('windows'),mac:platform('mac'),linux:platform('linux'),steamType:detail.steam_type??'unknown',
    decision:verdict.excluded?'excluded':verdict.reviewRequired?'pending':'allowed',
    matchedRule:verdict.matchedRule,reason:verdict.reason,isFree:Boolean(detail.is_free),currency:detail.price_currency??null,
    priceInitial:price(detail.price_initial),priceFinal:price(detail.price_final),discountPercent:detail.discount_percent??0,
    reviewTotal:null as number|null,reviewPositive:null as number|null,deckCategory:null as number|null};
}

/** Exactly one Store details call; no API key, personal data or duration provider. */
export async function fetchCatalogueMetadata(appId:string,transport:typeof fetch,signal:AbortSignal):Promise<CatalogueResult> {
  if(!/^[1-9][0-9]*$/.test(appId)||Number(appId)>4294967295)throw new Error('invalid_appid');
  try {
    const response=await transport(`https://store.steampowered.com/api/appdetails?${new URLSearchParams({appids:appId,cc:'US',l:'en'})}`,
      {cache:'no-store',redirect:'error',headers:{'User-Agent':'VaultShuffle metadata worker/1.0'},signal});
    if(response.status===429)return {appId,status:'retryable',rateLimited:true};
    if(response.status!==200)return {appId,status:'retryable'};
    const reader=response.body?.getReader();if(!reader)return {appId,status:'invalid'};
    const decoder=new TextDecoder();let text='',bytes=0;
    try {
      while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
        if(bytes>1024*1024){await reader.cancel();return {appId,status:'invalid'};}
        text+=decoder.decode(chunk.value,{stream:true});}
    }finally{reader.releaseLock();}
    const payload=JSON.parse(text+decoder.decode());
    const record=payload?.[appId];
    if(record?.success===false)return {appId,status:'unavailable'};
    if(record?.success!==true||!record.data||typeof record.data!=='object'||Array.isArray(record.data))return {appId,status:'invalid'};
    // A replacement product response must not overwrite the requested identity.
    if(String(record.data.steam_appid)!==appId)return {appId,status:'invalid'};
    return {appId,status:'complete',details:normalizeDetails(appId,record.data)};
  }catch{return {appId,status:signal.aborted?'retryable':'invalid'};}
}

/** Keep optional Store signals separate from the authoritative app-details body. */
export async function fetchCatalogueSignals(appId:string,transport:typeof fetch,signal:AbortSignal):Promise<CatalogueResult> {
  const result=await fetchCatalogueMetadata(appId,transport,signal);
  if(result.status!=='complete')return result;
  async function optionalJson(url:string):Promise<{payload:unknown;rateLimited:boolean}> {
    try {
      await delay(650,undefined,{signal});
      const response=await transport(url,{cache:'no-store',redirect:'error',headers:{'User-Agent':'VaultShuffle metadata worker/1.0'},signal});
      if(response.status===429)return {payload:null,rateLimited:true};
      if(response.status!==200)return {payload:null,rateLimited:false};
      const reader=response.body?.getReader();if(!reader)return {payload:null,rateLimited:false};
      const decoder=new TextDecoder();let text='',bytes=0;
      try {
        while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
          if(bytes>65536){await reader.cancel();return {payload:null,rateLimited:false};}
          text+=decoder.decode(chunk.value,{stream:true});}
      }finally{reader.releaseLock();}
      return {payload:JSON.parse(text+decoder.decode()),rateLimited:false};
    }catch{return {payload:null,rateLimited:false};}
  }
  const reviews=await optionalJson(`https://store.steampowered.com/appreviews/${appId}?${new URLSearchParams({json:'1',language:'all',purchase_type:'all',num_per_page:'0'})}`);
  if(reviews.rateLimited)return {appId,status:'retryable',rateLimited:true};
  const reviewPayload=reviews.payload as {success?:number;query_summary?:{total_reviews?:number;total_positive?:number}}|null;
  const summary=reviewPayload?.success===1?reviewPayload.query_summary:null;
  if(summary&&Number.isInteger(summary.total_reviews)&&Number.isInteger(summary.total_positive)&&
    summary.total_reviews!>=0&&summary.total_reviews!<=2147483647&&summary.total_positive!>=0&&summary.total_positive!<=summary.total_reviews!) {
    result.details.reviewTotal=summary.total_reviews!;result.details.reviewPositive=summary.total_positive!;
  }
  // Jobs are queued when metadata is at least 30 days old. Recheck known
  // ratings too: Valve may upgrade or downgrade compatibility. A failed lookup
  // stays null here so finish_catalogue_metadata preserves the stored rating.
  if(!signal.aborted) {
    const deck=await optionalJson(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appId}&l=english`);
    if(deck.rateLimited)return {appId,status:'retryable',rateLimited:true};
    const payload=deck.payload as {success?:number;results?:{resolved_category?:number}}|null;
    const category=payload?.success===1?payload.results?.resolved_category:null;
    if(Number.isInteger(category)&&category!>=0&&category!<=3)result.details.deckCategory=category!;
  }
  return result;
}

export class CatalogueWorkerRepository {
  private readonly database:DatabaseClient;
  private readonly deadlineAt:number;
  constructor(database:DatabaseClient,deadlineAt:number){this.database=database;this.deadlineAt=deadlineAt;}
  private async run<T>(operation:(sql:DatabaseClient['sql'])=>Promise<T>) {
    const remaining=this.deadlineAt-Date.now();if(remaining<=0)throw new Error('Worker deadline reached');
    return this.database.sql.begin(async sql=>{
      const timeout=Math.min(20000,remaining);
      await sql`select set_config('statement_timeout',${String(timeout)},true),set_config('lock_timeout',${String(Math.min(5000,timeout))},true)`;
      return operation(sql as unknown as DatabaseClient['sql']);
    }) as Promise<T>;
  }
  queue(limit=40){return this.run(async sql=>Number((await sql`select ops.queue_catalogue_metadata(${limit}) n`)[0].n));}
  claim(){return this.run(async sql=>(await sql<CatalogueClaim[]>`select outbox_id::text,lease_token,steam_app_id::text,provider_mode,known_deck from ops.claim_catalogue_metadata()`)[0]??null);}
  finish(claim:CatalogueClaim,result:CatalogueResult){return this.run(async sql=>String((await sql`select ops.finish_catalogue_metadata(
    ${claim.outbox_id}::bigint,${claim.lease_token}::uuid,${sql.json(result)}) outcome`)[0].outcome));}
}

export async function runCatalogueWorker(repository:Pick<CatalogueWorkerRepository,'queue'|'claim'|'finish'>,
  options:{fetch:typeof fetch;deadlineAt:number;maxJobs:number}) {
  if(!Number.isInteger(options.maxJobs)||options.maxJobs<1||options.maxJobs>100)throw new Error('Invalid catalogue batch');
  const totals={queued:await repository.queue(40),claimed:0,published:0,failed:0,stale:0,rateLimited:false};
  for(let index=0;index<options.maxJobs&&Date.now()+17000<options.deadlineAt;index++) {
    const claim=await repository.claim();if(!claim)break;
    // Fixtures may be tested through the core but are never sent to live Steam.
    if(claim.provider_mode!=='live')break;
    totals.claimed++;
    const result=await fetchCatalogueSignals(claim.steam_app_id,options.fetch,AbortSignal.timeout(Math.min(15000,options.deadlineAt-Date.now()-2000)));
    let outcome:string;
    try {outcome=await repository.finish(claim,result);}
    catch {outcome=await repository.finish(claim,result);} // response-loss replay of the same record
    if(outcome==='published'||outcome==='replayed')totals.published++;
    else if(outcome==='stale')totals.stale++;else totals.failed++;
    if(result.status!=='complete'&&result.rateLimited){totals.rateLimited=true;break;}
    // One leased request at a time, using the existing Store interval.
    await new Promise(resolve=>setTimeout(resolve,650));
  }
  return totals;
}
