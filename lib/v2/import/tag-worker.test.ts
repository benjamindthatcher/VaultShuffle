import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchCatalogueTags,runTagWorker,type TagClaim} from './tag-worker-core.ts';
const claim:TagClaim={outbox_id:'1',lease_token:'synthetic',steam_app_id:'100',provider_mode:'live',facts:{genres:[],categories:[],
  mainStoryMinutes:600,completionistMinutes:900,durationKind:'finite',durationSource:'hltb',durationManualOverride:false,gameType:'game'}};
test('tag provider identity, HTTP status, size and rate limits are checked before publication',async()=>{
  const read=(transport:typeof fetch)=>fetchCatalogueTags(claim,'steamspy',transport,AbortSignal.timeout(3000));
  assert.equal((await read(async()=>Response.json({appid:101,tags:{Action:10}}))).status,'invalid');
  assert.equal((await read(async()=>new Response('x'.repeat(65537)))).status,'invalid');
  assert.deepEqual(await read(async()=>new Response('',{status:429})),{appId:'100',provider:'steamspy',status:'retryable',rateLimited:true});
  assert.equal((await read(async()=>new Response('{}',{status:206}))).status,'retryable');
});
test('tag publication response-loss replay reuses its one fetched record',async()=>{
  let reads=0,finishes=0;const bodies:unknown[]=[];
  const summary=await runTagWorker({queue:async()=>1,claim:async()=>claim,finish:async(_claim,body)=>{
    bodies.push(body);if(++finishes===1)throw Error('lost_reply');return 'replayed';}},'steamspy',
    {fetch:async()=>{reads++;return Response.json({appid:100,tags:{MMORPG:100}});},deadlineAt:Date.now()+30000,maxJobs:1});
  assert.equal(reads,1);assert.equal(summary.published,1);assert.equal(bodies[0],bodies[1]);
});
test('fixture-mode tags never contact a live source and 429 ends a batch',async()=>{
  let reads=0;
  const repository={queue:async()=>1,claim:async()=>({...claim,provider_mode:'fixture' as const}),finish:async()=>{throw Error('unexpected');}};
  await runTagWorker(repository,'steam_store',{fetch:async()=>{reads++;return Response.json({});},deadlineAt:Date.now()+30000,maxJobs:1});
  assert.equal(reads,0);
  const rate=await runTagWorker({...repository,claim:async()=>claim,finish:async()=> 'retryable'},'steamspy',
    {fetch:async()=>new Response('',{status:429}),deadlineAt:Date.now()+30000,maxJobs:2});
  assert.equal(rate.claimed,1);assert.equal(rate.rateLimited,true);
});
