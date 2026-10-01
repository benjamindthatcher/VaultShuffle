import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchCatalogueMetadata,fetchCatalogueSignals,runCatalogueWorker,type CatalogueClaim} from './catalogue-worker-core.ts';
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
test('Optional 429 stops the Store batch and optional oversized bodies stay bounded',async()=>{
  let calls=0;
  const result=await fetchCatalogueSignals(appId,async input=>{calls++;return String(input).includes('appdetails')?
    Response.json(complete()):new Response('',{status:429});},signal());
  assert.deepEqual(result,{appId,status:'retryable',rateLimited:true});assert.equal(calls,2);
  const large=await fetchCatalogueSignals(appId,async input=>String(input).includes('appdetails')?
    Response.json(complete()):new Response('x'.repeat(65537)),signal());
  assert.equal(large.status,'complete');if(large.status!=='complete')throw Error('fixture');assert.equal(large.details.reviewTotal,null);
});
test('fixture mode and insufficient deadline never send a live Store call',async()=>{
  let calls=0;const repository={queue:async()=>0,claim:async()=>({outbox_id:'1',lease_token:'x',steam_app_id:appId,provider_mode:'fixture' as const}),finish:async()=>{throw Error('unexpected');}};
  const fetch=async()=>{calls++;return Response.json({});};
  await runCatalogueWorker(repository,{fetch,deadlineAt:Date.now()+30000,maxJobs:1});
  await runCatalogueWorker(repository,{fetch,deadlineAt:Date.now()+100,maxJobs:1});assert.equal(calls,0);
});
