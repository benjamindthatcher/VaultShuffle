import type {DatabaseClient} from '../db/client.ts';
import {foldGenreLearning,EVENT_SIGNALS,LIBRARY_SIGNALS,withOverrides,addGameTally,
  type LearningDraw,type LearningEvent,type LearningDecision,type LearningPin,type Signal} from '../../genre-learning-model.ts';
import {preferenceGenresFor,canonicalPreferenceGenre,parseAlgorithmWeight} from '../../genre-preferences.ts';
import {steamTagGenreLabels} from '../../genres.ts';
import {labels,tags} from '../repositories/store-core.ts';

type CatalogueFacts={genres:unknown;tags:unknown;title:string};
type DrawInput=LearningDraw&CatalogueFacts&{events:LearningEvent[]};
type DecisionInput=LearningDecision&CatalogueFacts;
type PinInput=LearningPin&CatalogueFacts;
type Input={startedAt:string;draws:LearningDraw[];events:LearningEvent[];decisions:LearningDecision[];pins:LearningPin[];
  genres:Map<number,string[]>;weights:Map<string,Signal>;playtime:{steam_app_id:string;endorsements:string;launched:string;unplayed:string;total_hours:string;owners:string}[]};

/** Whole finite evidence via small keyset pages in a consistent read snapshot. */
export async function readLearningInputs(database:DatabaseClient,deadlineAt:number):Promise<Input> {
  const input:Input={startedAt:'',draws:[],events:[],decisions:[],pins:[],genres:new Map(),weights:new Map(),playtime:[]};
  await database.sql.begin('isolation level repeatable read read only',async sql=>{
    const bound=async()=>{const remaining=deadlineAt-Date.now();if(remaining<5000)throw Error('Learning deadline reached');
      await sql`select set_config('statement_timeout',${String(Math.min(20000,remaining))},true),set_config('lock_timeout','5000',true)`;};
    await bound();
    input.startedAt=String((await sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') started`)[0].started);
    for(const row of await sql<{key:string;positive:string;total:string}[]>`select * from ops.learning_weights()`) {
      const weight=parseAlgorithmWeight(row.positive,row.total);if(weight)input.weights.set(row.key,weight);
    }
    // Existing operator spelling still tunes the same standing negative.
    if(!input.weights.has('decision:blacklist')&&input.weights.has('decision:sleep'))
      input.weights.set('decision:blacklist',input.weights.get('decision:sleep')!);
    function catalogue(appId:number,facts:CatalogueFacts) {
      const genres=preferenceGenresFor([...labels(facts.genres),...steamTagGenreLabels(tags(facts.tags),8)],facts.title).map(canonicalPreferenceGenre);
      if(genres.length)input.genres.set(appId,genres);
    }
    async function pages<T>(kind:'draws'|'outcomes'|'pins',consume:(row:T)=>void) {
      let after='0',seen=0;
      while(true){await bound();
        const rows=kind==='draws'?await sql<{cursor:string;entry:T}[]>`select cursor::text,entry from ops.learning_draws(${after}::bigint,200)`
          :kind==='outcomes'?await sql<{cursor:string;entry:T}[]>`select cursor::text,entry from ops.learning_outcomes(${after}::bigint,200)`
          :await sql<{cursor:string;entry:T}[]>`select cursor::text,entry from ops.learning_pins(${after}::bigint,200)`;
        seen+=rows.length;if(seen>200000)throw Error('Learning evidence exceeds the supported batch');
        for(const row of rows)consume(row.entry);
        if(rows.length<200)break;after=rows[rows.length-1].cursor;
      }
    }
    await pages<DrawInput>('draws',row=>{
      input.draws.push({id:row.id,user_id:row.user_id,steam_appid:row.steam_appid,mood:row.mood});
      input.events.push(...row.events);if(input.events.length>500000)throw Error('Learning events exceed the supported batch');
      catalogue(Number(row.steam_appid),row);
    });
    await pages<DecisionInput>('outcomes',row=>{input.decisions.push({userId:row.userId,steamAppId:row.steamAppId,action:row.action,reviewedAt:row.reviewedAt});catalogue(row.steamAppId,row);});
    await pages<PinInput>('pins',row=>{input.pins.push({userId:row.userId,steamAppId:row.steamAppId,pinnedAt:row.pinnedAt});catalogue(row.steamAppId,row);});
    let after=0;
    while(true){await bound();
      const rows=await sql<(Input['playtime'][number]&{game_id:number})[]>`select * from ops.learning_playtime(${after},1000)`;
      input.playtime.push(...rows);if(input.playtime.length>100000)throw Error('Learning games exceed the supported batch');
      if(rows.length<1000)break;after=rows[rows.length-1].game_id;
    }
  });
  return input;
}

export async function rebuildV2Learning(database:DatabaseClient,deadlineAt:number) {
  const input=await readLearningInputs(database,deadlineAt);
  // Standing Blacklist has no date to rank. Cap its current facts deterministically,
  // followed by newest completion outcomes, without inventing a decision instant.
  const counts=new Map<string,number>();
  const decisions=[...input.decisions].sort((a,b)=>Number(b.reviewedAt===null)-Number(a.reviewedAt===null)
    ||(b.reviewedAt??'').localeCompare(a.reviewedAt??'')||a.steamAppId-b.steamAppId).filter(row=>{
      const seen=counts.get(row.userId)??0;counts.set(row.userId,seen+1);return seen<50;});
  const eventSignals=withOverrides(EVENT_SIGNALS as Record<string,Signal>,'event',input.weights);
  const decisionSignals=withOverrides(LIBRARY_SIGNALS,'decision',input.weights);
  const folded=foldGenreLearning({draws:input.draws,events:input.events,libraryDecisions:decisions,
    playingNextCommitments:input.pins,genresByAppId:input.genres,eventSignals,decisionSignals});
  const playedWeight=input.weights.get('playtime:per_owner')?.total??0.5,unplayedWeight=input.weights.get('playtime:per_unplayed_owner')?.total??0.25;
  const hours=new Map<number,number>();let playtimeRows=0;
  for(const row of input.playtime) {
    const id=Number(row.steam_app_id);hours.set(id,Number(row.total_hours));playtimeRows+=Number(row.owners);
    addGameTally(folded.gameTallies,id,Number(row.endorsements)*playedWeight,Number(row.launched)*playedWeight+Number(row.unplayed)*unplayedWeight);
  }
  const games=[...folded.gameTallies].map(([steam_app_id,tally])=>({steam_app_id,positive:tally.positive,total:tally.total,total_hours:hours.get(steam_app_id)??0}));
  const remaining=deadlineAt-Date.now();if(remaining<5000)throw Error('Learning deadline reached');
  const snapshotId=await database.sql.begin(async sql=>{
    await sql`select set_config('statement_timeout',${String(Math.min(20000,remaining))},true),set_config('lock_timeout','5000',true)`;
    return (await sql`select ops.publish_live_learning(${input.startedAt}::text::timestamptz,${sql.json(folded.rows)},${sql.json(games)}) id`)[0].id;
  });
  return {draws:input.draws.length,events:input.events.length,libraryDecisions:decisions.length,playingNextCommitments:input.pins.length,
    users:folded.summary.users,scoredEvents:folded.summary.scoredEvents,rows:folded.rows.length,gameRows:games.length,playtimeRows,stale:snapshotId===null};
}
