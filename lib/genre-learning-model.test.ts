import assert from 'node:assert/strict';
import test from 'node:test';
import {foldGenreLearning,EVENT_SIGNALS,LIBRARY_SIGNALS,withOverrides,type Signal} from './genre-learning-model.ts';
import {ANY_MOOD_CONTEXT,BASELINE_GENRE} from './genre-preferences.ts';
const now=()=>new Date().toISOString();
const base=()=>({draws:[] as {id:string;user_id:string;steam_appid:number;mood:'chill'|null}[],
  events:[] as {draw_id:string;event_type:string;created_at:string}[],libraryDecisions:[] as {userId:string;steamAppId:number;action:string;reviewedAt:string|null}[],
  playingNextCommitments:[] as {userId:string;steamAppId:number;pinnedAt:string}[],genresByAppId:new Map([[1,['strategy']]]),
  eventSignals:EVENT_SIGNALS as Record<string,Signal>,decisionSignals:LIBRARY_SIGNALS});
test('one explicit commitment supersedes weaker reactions and duplicate pin state',()=>{
  const input=base(),date=now();input.draws=[{id:'d',user_id:'u',steam_appid:1,mood:'chill'}];
  input.events=['liked','pinned','opened_on_steam','drew_again','opened_on_steam'].map(event_type=>({draw_id:'d',event_type,created_at:date}));
  input.playingNextCommitments=[{userId:'u',steamAppId:1,pinnedAt:date}];
  const folded=foldGenreLearning(input);assert.equal(folded.summary.scoredEvents,1);
  assert.ok(Math.abs(folded.gameTallies.get(1)!.positive-3)<0.001);
  assert.ok(folded.rows.some(row=>row.context_mood===ANY_MOOD_CONTEXT&&row.genre===BASELINE_GENRE));
});
test('wrong mood teaches only that context and never a game-wide negative',()=>{
  const input=base();input.draws=[{id:'d',user_id:'u',steam_appid:1,mood:'chill'}];
  input.events=[{draw_id:'d',event_type:'reroll_wrong_mood',created_at:now()},{draw_id:'d',event_type:'drew_again',created_at:now()}];
  const folded=foldGenreLearning(input);assert.equal(folded.gameTallies.size,0);
  assert.ok(folded.rows.every(row=>row.context_mood==='chill'));assert.equal(folded.summary.scoredEvents,1);
});
test('standing Blacklist requires no date or history; manual reactivation removes its negative',()=>{
  const input=base();input.libraryDecisions=[{userId:'u',steamAppId:1,action:'blacklist',reviewedAt:null}];
  const blocked=foldGenreLearning(input);assert.deepEqual(blocked.gameTallies.get(1),{positive:0,total:4});
  assert.equal(blocked.rows.find(row=>row.genre==='strategy')?.total,4);
  input.libraryDecisions=[];assert.equal(foldGenreLearning(input).rows.length,0);
});
test('existing completion and pin facts decay with 60-day half-life',()=>{
  const input=base(),past=new Date(Date.now()-60*86400000).toISOString();
  input.libraryDecisions=[{userId:'u',steamAppId:1,action:'complete',reviewedAt:past}];
  input.playingNextCommitments=[{userId:'u',steamAppId:1,pinnedAt:past}];
  const tally=foldGenreLearning(input).gameTallies.get(1)!;assert.ok(Math.abs(tally.positive-1.5)<0.001);assert.ok(Math.abs(tally.total-1.5)<0.001);
});
test('operator overrides tune strengths without changing mood-only semantics',()=>{
  const weights=withOverrides(EVENT_SIGNALS as Record<string,Signal>,'event',new Map([['event:reroll_wrong_mood',{positive:0,total:5}]]));
  assert.equal(weights.reroll_wrong_mood.moodOnly,true);assert.equal(weights.reroll_wrong_mood.total,5);
  assert.equal(EVENT_SIGNALS.reroll_wrong_mood?.total,1,'default is never mutated');
});
