import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchCatalogueMetadata,fetchCatalogueSignals,runCatalogueWorker,type CatalogueClaim,type CatalogueResult} from './catalogue-worker-core.ts';
const signal=()=>AbortSignal.timeout(3000);
const appId='4294967295';
const complete=(overrides={})=>({[appId]:{success:true,data:{steam_appid:Number(appId),name:'Fixture',type:'game',is_free:false,genres:[],categories:[],...overrides}}});
const transport=(body:unknown)=>async()=>Response.json(body);
test('Store metadata preserves uint32 identities, classification and unknown platform facts',async()=>{
  const result=await fetchCatalogueMetadata(appId,transport(complete({fullgame:{appid:100},price_overview:{currency:'USD',initial:1000,final:750}})),signal());
  assert.equal(result.status,'complete');if(result.status!=='complete')throw Error('fixture');
  assert.equal(result.details.decision,'excluded');assert.equal(result.details.windows,'unknown');assert.equal(result.details.priceFinal,750);
  assert.equal(JSON.stringify(result).includes('duration'),false);
});
test('Store metadata rejects replacement AppIDs and malformed/missing records',async()=>{
  for(const body of [complete({steam_appid:1}),complete({name:null}),complete({is_free:undefined}),{}, {[appId]:{success:true,data:[]}}])
    assert.equal((await fetchCatalogueMetadata(appId,transport(body),signal())).status,'invalid');
  assert.equal((await fetchCatalogueMetadata(appId,transport({[appId]:{success:false}}),signal())).status,'unavailable');
});
test('Store HTTP status and body limits cannot promote partial metadata',async()=>{
  assert.deepEqual(await fetchCatalogueMetadata(appId,async()=>new Response('',{status:429}),signal()),{appId,status:'retryable',rateLimited:true});
  assert.equal((await fetchCatalogueMetadata(appId,async()=>new Response('{}',{status:206}),signal())).status,'retryable');
  assert.equal((await fetchCatalogueMetadata(appId,async()=>new Response('x'.repeat(1024*1024+1)),signal())).status,'invalid');
  await assert.rejects(fetchCatalogueMetadata('4294967296',transport({}),signal()));
});
test('Store response-loss replay uses the same record and makes no second provider call',async()=>{
  const claim:CatalogueClaim={outbox_id:'1',lease_token:'synthetic',steam_app_id:appId,provider_mode:'live',known_deck:0};
  let fetches=0,finishes=0;const results:unknown[]=[];
  const totals=await runCatalogueWorker({queue:async()=>1,claim:async()=>claim,finish:async(_claim,result)=>{
    results.push(result);if(++finishes===1)throw Error('response_lost');return 'replayed';}},
    {fetch:async()=>{fetches++;return Response.json(complete());},deadlineAt:Date.now()+30000,maxJobs:1});
  assert.equal(totals.published,1);assert.equal(fetches,3);assert.equal(finishes,2);assert.equal(results[0],results[1]);
});
test('Store metadata refreshes reviews and rechecks Deck ratings on each scheduled refresh',async()=>{
  const paths:string[]=[];
  let deckCategory=3;
  const fetch=async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));paths.push(url.pathname);
    return Response.json(url.pathname.includes('appdetails')?complete():url.pathname.includes('appreviews')?
      {success:1,query_summary:{total_reviews:100,total_positive:80}}:{success:1,results:{resolved_category:deckCategory}});
  };
  const unknown=await fetchCatalogueSignals(appId,fetch,signal());assert.equal(unknown.status,'complete');
  if(unknown.status!=='complete')throw Error('fixture');
  assert.deepEqual([unknown.details.reviewTotal,unknown.details.reviewPositive,unknown.details.deckCategory],[100,80,3]);
  assert.equal(paths.length,3);paths.length=0;deckCategory=0;
  const known=await fetchCatalogueSignals(appId,fetch,signal());assert.equal(known.status,'complete');
  if(known.status!=='complete')throw Error('fixture');assert.equal(known.details.deckCategory,0);assert.equal(paths.length,3);
});
test('Malformed or failed optional signals preserve good app details without manufacturing zero',async()=>{
  for(const summary of [null,{total_reviews:3,total_positive:4},{total_reviews:'3',total_positive:2}]) {
    const result=await fetchCatalogueSignals(appId,async input=>Response.json(String(input).includes('appdetails')?complete():
      {success:1,query_summary:summary,results:{resolved_category:4}}),signal());
    assert.equal(result.status,'complete');if(result.status!=='complete')throw Error('fixture');
    assert.equal(result.details.reviewTotal,null);assert.equal(result.details.deckCategory,null);
  }
  const zero=await fetchCatalogueSignals(appId,async input=>Response.json(String(input).includes('appdetails')?complete():
    {success:1,query_summary:{total_reviews:0,total_positive:0}}),signal());
  assert.equal(zero.status,'complete');if(zero.status!=='complete')throw Error('fixture');assert.equal(zero.details.reviewTotal,0);
});
test('Review 429 retains authoritative details and skips the Deck request',async()=>{
  let calls=0;
  const result=await fetchCatalogueSignals(appId,async input=>{calls++;return String(input).includes('appdetails')?
    Response.json(complete()):new Response('',{status:429});},signal());
  assert.equal(result.status,'complete');assert.equal(result.rateLimited,true);assert.equal(calls,2);
  if(result.status!=='complete')throw Error('fixture');
  assert.equal(result.details.title,'Fixture');assert.equal(result.details.reviewTotal,null);assert.equal(result.details.deckCategory,null);
});
test('Deck 429 publishes details and successful reviews, stops the batch and replays the same publication',async()=>{
  const claim:CatalogueClaim={outbox_id:'1',lease_token:'synthetic',steam_app_id:appId,provider_mode:'live'};
  let claims=0,fetches=0,finishes=0;const results:CatalogueResult[]=[];
  const totals=await runCatalogueWorker({queue:async()=>2,claim:async()=>{claims++;return claim;},finish:async(_claim,result)=>{
    results.push(result);if(++finishes===1)throw Error('response_lost');return 'replayed';}},
    {fetch:async input=>{fetches++;return String(input).includes('appdetails')?Response.json(complete()):
      String(input).includes('appreviews')?Response.json({success:1,query_summary:{total_reviews:120,total_positive:90}}):new Response('',{status:429});},
    deadlineAt:Date.now()+30000,maxJobs:2});
  assert.deepEqual(totals,{queued:2,claimed:1,published:1,skipped:0,failed:0,stale:0,rateLimited:true});
  assert.equal(claims,1);assert.equal(fetches,3);assert.equal(finishes,2);assert.equal(results[0],results[1]);
  const result=results[0];assert.equal(result.status,'complete');assert.equal(result.rateLimited,true);
  if(result.status!=='complete')throw Error('fixture');
  assert.equal(result.details.title,'Fixture');
  assert.deepEqual([result.details.reviewTotal,result.details.reviewPositive,result.details.deckCategory],[120,90,null]);
});
test('Main details 429 stops the batch without publishing a partial primary response',async()=>{
  let claims=0,fetches=0;const results:unknown[]=[];
  const totals=await runCatalogueWorker({queue:async()=>2,claim:async()=>{claims++;return {outbox_id:'1',lease_token:'x',steam_app_id:appId,provider_mode:'live'};},
    finish:async(_claim,result)=>{results.push(result);return 'retryable';}},
    {fetch:async()=>{fetches++;return new Response('',{status:429});},deadlineAt:Date.now()+30000,maxJobs:2});
  assert.deepEqual(results,[{appId,status:'retryable',rateLimited:true}]);
  assert.equal(claims,1);assert.equal(fetches,1);assert.equal(totals.published,0);assert.equal(totals.rateLimited,true);
});
test('Optional oversized bodies stay bounded',async()=>{
  const large=await fetchCatalogueSignals(appId,async input=>String(input).includes('appdetails')?
    Response.json(complete()):new Response('x'.repeat(65537)),signal());
  assert.equal(large.status,'complete');if(large.status!=='complete')throw Error('fixture');assert.equal(large.details.reviewTotal,null);
});
test('Fresh details do not prevent independent review or Deck refreshes',async()=>{
  for(const plan of [{details:false,reviews:true,deck:false},{details:false,reviews:false,deck:true},{details:true,reviews:false,deck:false}]) {
    const paths:string[]=[];
    const result=await fetchCatalogueSignals(appId,async input=>{
      const path=new URL(String(input)).pathname;paths.push(path);
      return Response.json(path.includes('appdetails')?complete():path.includes('appreviews')?
        {success:1,query_summary:{total_reviews:0,total_positive:0}}:{success:1,results:{resolved_category:0}});
    },signal(),plan);
    assert.equal(paths.length,1);
    assert.equal(paths[0].includes(plan.details?'appdetails':plan.reviews?'appreviews':'ajaxgetdeckappcompatibilityreport'),true);
    assert.equal(result.optionalIncomplete,undefined);
    if(plan.details)assert.equal(result.status,'complete');
    else {assert.equal(result.status,'signals');if(result.status!=='signals')throw Error('fixture');
      assert.deepEqual(result.signals,{reviewTotal:plan.reviews?0:null,reviewPositive:plan.reviews?0:null,deckCategory:plan.deck?0:null});}
  }
});
test('Fully current queued jobs finish without a Store request or spacing delay',async()=>{
  let claims=0,calls=0;const results:CatalogueResult[]=[];
  const totals=await runCatalogueWorker({queue:async()=>2,claim:async()=>++claims<=2?
    {outbox_id:String(claims),lease_token:'synthetic',steam_app_id:appId,provider_mode:'live',needs_details:false,needs_reviews:false,needs_deck:false}:null,
    finish:async(_claim,result)=>{results.push(result);return 'current';}},
    {fetch:async()=>{calls++;throw Error('unexpected Store call');},deadlineAt:Date.now()+30000,maxJobs:2});
  assert.equal(calls,0);assert.deepEqual(results,[{appId,status:'current'},{appId,status:'current'}]);
  assert.deepEqual(totals,{queued:2,claimed:2,published:0,skipped:2,failed:0,stale:0,rateLimited:false});
});
test('Optional-only failures keep a retry and optional-only 429 prevents the next signal',async()=>{
  const unavailable=await fetchCatalogueSignals(appId,async()=>Response.json({success:0}),signal(),{details:false,reviews:true,deck:false});
  assert.deepEqual(unavailable,{appId,status:'signals',signals:{reviewTotal:null,reviewPositive:null,deckCategory:null},optionalIncomplete:true});
  let calls=0;
  const paused=await fetchCatalogueSignals(appId,async()=>{calls++;return new Response('',{status:429});},signal(),{details:false,reviews:true,deck:true});
  assert.equal(calls,1);assert.equal(paused.status,'signals');assert.equal(paused.rateLimited,true);assert.equal(paused.optionalIncomplete,true);
});
test('fixture mode and insufficient deadline never send a live Store call',async()=>{
  let calls=0;const repository={queue:async()=>0,claim:async()=>({outbox_id:'1',lease_token:'x',steam_app_id:appId,provider_mode:'fixture' as const}),finish:async()=>{throw Error('unexpected');}};
  const fetch=async()=>{calls++;return Response.json({});};
  await runCatalogueWorker(repository,{fetch,deadlineAt:Date.now()+30000,maxJobs:1});
  await runCatalogueWorker(repository,{fetch,deadlineAt:Date.now()+100,maxJobs:1});assert.equal(calls,0);
});
