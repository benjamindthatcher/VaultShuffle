import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { libraryGlobalFilters, libraryGlobalPredicate } from "./library-global-filters.ts";
import { readLibraryCards, type LibraryCard } from "./library-core.ts";
import { type GlobalFilters } from "../../global-filters.ts";
import { EXCLUSION_CATEGORIES, EXCLUSION_TAG_SHARE } from "../../exclusion-categories.ts";
import { InvalidPageQueryError } from "./page-errors.ts";

export type DashboardGame = Readonly<{ gameId:number; title:string; appId:string|null; playtimeMinutes:number|null; completedAt:string|null; imageUrl:string|null }>;
export type CompletionSuggestion = Readonly<{ game:DashboardGame; estimatedMinutes:number; progressPercent:number; confidence:number }>;
export type DashboardValueGame = Readonly<{game:DashboardGame; cents:number; centsPerHour:number}>;
export type DashboardPayload = Readonly<{
  revision:Readonly<{library:string;state:string}>;
  aggregates:Readonly<{ownedGames:number;familyGames:number;completedGames:number;completedPercent:number;totalMinutes:number;knownPlaytimeGames:number;unplayedGames:number;pricedGames:number;libraryValueCents:number|null;completedValueCents:number|null;unplayedValueCents:number|null}>;
  trend:Readonly<{daysTracked:number;minutesLast7Days:number;minutesLast30Days:number;dailyGains:readonly {day:string;minutes:number}[]}>;
  currency:"USD"; bestValueGames:readonly DashboardValueGame[];
  mostPlayed:readonly DashboardGame[];recentCompletions:readonly DashboardGame[];completionSuggestions:readonly CompletionSuggestion[];
  cards:readonly LibraryCard[]; availableExclusions:readonly string[];
}>;
type GameRow={game_id:number;title:string;steam_app_id:string|number|null;playtime_minutes:number|null;completed_at:string|Date|null;capsule_image_url:string|null;estimated_minutes?:number;progress_percent?:number;confidence?:string|number};

export class DashboardRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient){this.database=database;}
  async read(principal:VerifiedServerPrincipal, filters?:GlobalFilters):Promise<DashboardPayload>{
    const f=libraryGlobalFilters(filters);
    try{return await this.database.withPrincipal(principal,async tx=>{
      const base=dashboardBase(tx,principal.accountId,f);
      const aggregates=await tx<{library_revision:string;state_revision:string;owned_games:number;family_games:number;completed_games:number;total_minutes:string;known_playtime_games:number;unplayed_games:number}[]>`
        ${base} select a.library_revision,a.state_revision,
          (select count(*) from base where access='owned') owned_games,
          (select count(*) from base where access='family') family_games,
          (select count(*) from base where access='owned' and completed_at is not null) completed_games,
          coalesce((select sum(playtime_minutes) from base where access='owned'),0) total_minutes,
          (select count(*) from base where access='owned' and playtime_minutes is not null) known_playtime_games,
          (select count(*) from base where access='owned' and playtime_minutes=0) unplayed_games
        from app.accounts a where a.id=${principal.accountId}`;
      const value=await libraryValue(tx,base);
      const highlights=await tx<GameRow[]>`${base} select * from base where access='owned' order by playtime_minutes desc nulls last,normalized_sort_title,game_id limit 5`;
      const completions=await tx<GameRow[]>`${base} select * from base where access='owned' and completed_at is not null order by completed_at desc,game_id desc limit 8`;
      const suggestions=await tx<GameRow[]>`${base} select *,least(100,round(playtime_minutes*100.0/estimated_minutes))::integer progress_percent,
        case when playtime_minutes<=estimated_minutes*1.5 then 1 when playtime_minutes<=estimated_minutes*2.5 then .8 when playtime_minutes<=estimated_minutes*4 then .6 else .4 end confidence
        from base where access='owned' and completed_at is null and duration_kind<>'endless' and estimated_minutes>=120
          and playtime_minutes>=estimated_minutes*.75
          and (completion_dismissed_at is null or playtime_minutes>=coalesce(completion_dismissed_playtime,0)+greatest(180,coalesce(completion_dismissed_playtime,0)*.25))
        order by confidence desc,progress_percent desc,game_id limit 50`;
      // Only displayed highlights carry product DTOs, independent of total Library size.
      const ids=[...new Set([...highlights,...completions,...value.games.map(item=>({game_id:item.game.gameId}))].map(row=>row.game_id))];
      const cards=await readLibraryCards(tx,principal.accountId,ids);
      const availableExclusions=await exclusionOptions(tx,principal.accountId);
      // Unknown-coverage observations cannot prove a daily gain.
      const daily=await tx<{day:string|Date;minutes:string|number|null}[]>`
        with snapshots as(select activity_day,observed_minutes,coverage,lag(coverage) over(order by activity_day) previous_coverage,
          lag(observed_minutes) over(order by activity_day) previous from app.playtime_daily where account_id=${principal.accountId} order by activity_day desc limit 31)
        select activity_day as "day",case when coverage='complete' and previous_coverage='complete' then greatest(0,observed_minutes-previous) else null end as minutes
        from snapshots where previous is not null order by activity_day desc`;
      const row=aggregates[0];const owned=Number(row?.owned_games??0),completed=Number(row?.completed_games??0);
      const gains=daily.filter(x=>x.minutes!==null).map(x=>({day:x.day instanceof Date?x.day.toISOString().slice(0,10):String(x.day),minutes:Number(x.minutes)}));
      return Object.freeze({revision:Object.freeze({library:String(row?.library_revision??0),state:String(row?.state_revision??0)}),
        aggregates:Object.freeze({ownedGames:owned,familyGames:Number(row?.family_games??0),completedGames:completed,completedPercent:owned?Math.round(completed*100/owned):0,totalMinutes:Number(row?.total_minutes??0),knownPlaytimeGames:Number(row?.known_playtime_games??0),unplayedGames:Number(row?.unplayed_games??0),...value.aggregates}),
        currency:"USD",bestValueGames:Object.freeze(value.games),cards:Object.freeze(cards),availableExclusions:Object.freeze(availableExclusions),
        trend:Object.freeze({daysTracked:daily.length?daily.length+1:0,minutesLast7Days:sumWithin(gains,7),minutesLast30Days:sumWithin(gains,30),dailyGains:Object.freeze(gains)}),
        mostPlayed:Object.freeze(highlights.map(game)),recentCompletions:Object.freeze(completions.map(game)),
        completionSuggestions:Object.freeze(suggestions.map(x=>Object.freeze({game:game(x),estimatedMinutes:Number(x.estimated_minutes),progressPercent:Number(x.progress_percent),confidence:Number(x.confidence)})))});
    });}catch(error){if(error instanceof DatabaseUnavailableError || error instanceof InvalidPageQueryError)throw error;throw new DatabaseUnavailableError(error);}
  }
}

function accessible(tx:TenantTransaction,accountId:number) {
  return tx`with accessible as (
    select lg.game_id,lg.playtime_minutes,'owned'::text access from app.library_games lg where lg.account_id=${accountId}
    union all select f.game_id,null::integer,'family'::text from app.family_game_access f where f.account_id=${accountId}
      and not exists(select 1 from app.library_games lg where lg.account_id=f.account_id and lg.game_id=f.game_id) group by f.game_id
  )`;
}
function dashboardBase(tx:TenantTransaction,accountId:number,f:GlobalFilters) {
  return tx`${accessible(tx,accountId)}, base as (
    select a.*,g.title,g.normalized_sort_title,g.steam_app_id,gm.capsule_image_url,gs.completed_at,
      gs.completion_dismissed_at,gs.completion_dismissed_playtime,gf.duration_kind,
      greatest(60,round((coalesce(gf.main_duration_minutes,0)+coalesce(gf.extras_duration_minutes,0)+coalesce(gf.completion_duration_minutes,0))::numeric/
        nullif((case when gf.main_duration_minutes>0 then 1 else 0 end)+(case when gf.extras_duration_minutes>0 then 1 else 0 end)+(case when gf.completion_duration_minutes>0 then 1 else 0 end),0)/60)*60)::integer estimated_minutes,
      case when price.is_free then 0 else coalesce(nullif(price.price_initial_cents,0),nullif(price.price_final_cents,0)) end cents
    from accessible a join catalog.games g on g.id=a.game_id
    left join app.game_state gs on gs.account_id=${accountId} and gs.game_id=a.game_id
    left join catalog.game_metadata gm on gm.game_id=a.game_id left join catalog.game_features gf on gf.game_id=a.game_id
    left join lateral (
      select coalesce(p.is_free,o.is_free,false) is_free,p.price_initial_cents,p.price_final_cents
      from catalog.offers o left join catalog.offer_prices p on p.offer_id=o.id and p.is_current and p.currency='USD'
      where o.game_id=a.game_id and o.region_code='US'
      order by p.observed_at desc nulls last,o.last_observed_at desc,o.id desc limit 1
    ) price on true
    where g.lifecycle_status='active' and ${libraryGlobalPredicate(tx,f)}
  )`;
}
async function exclusionOptions(tx:TenantTransaction,accountId:number) {
  // Normalize the whole pool once. Repeating JSON scans and strongest-tag
  // calculations for every category dominated real large-library latency.
  const expressions=EXCLUSION_CATEGORIES.map(category=>{
    const tags=tx.array(category.tags.map(normalise));
    const categories=tx.array((category.categories??[]).map(normalise));
    return tx`case when bool_or(genre_labels && ${tags}::text[]
      or tag_labels && ${tags}::text[] or category_labels && ${categories}::text[]) then ${category.id}::text end`;
  });
  const rows=await tx<{options:string[]}[]>`${accessible(tx,accountId)}, shapes as materialized (
    select array(select replace(lower(btrim(case jsonb_typeof(e.value) when 'string' then e.value#>>'{}' else e.value->>'label' end)),'_',' ')
      from jsonb_array_elements(coalesce(gm.genres,'[]')) e(value)) genre_labels,
      array(select replace(lower(btrim(case jsonb_typeof(e.value) when 'string' then e.value#>>'{}' else e.value->>'label' end)),'_',' ')
        from jsonb_array_elements(coalesce(gm.categories,'[]')) e(value)) category_labels,
      array(select replace(lower(btrim(w.value->>'tag')),'_',' ') from (
        select e.value,(e.value->>'weight')::numeric weight,max((e.value->>'weight')::numeric) over() strongest
        from jsonb_array_elements(coalesce(gm.weighted_tags,'[]')) e(value)
      ) w where w.weight>0 and w.weight>=${EXCLUSION_TAG_SHARE}*w.strongest) tag_labels
    from accessible a join catalog.games g on g.id=a.game_id
      left join catalog.game_metadata gm on gm.game_id=a.game_id where g.lifecycle_status='active'
  ) select array_remove(array[${expressions.reduce((left,right)=>tx`${left}, ${right}`)}],null) options from shapes`;
  return rows[0]?.options??[];
}
function normalise(value:string) { return value.trim().toLowerCase().replace(/[_]+/g,' ').replace(/\s+/g,' '); }

async function libraryValue(tx:TenantTransaction,base:ReturnType<typeof dashboardBase>) {
  const rows=await tx<{priced:number;library_value:string|null;completed_value:string|null;unplayed_value:string|null;games:Array<GameRow&{cents:number;cents_per_hour:number}>}[]>`
    ${base}, owned as(select * from base where access='owned'), top_value as (
      select *,cents*60.0/playtime_minutes cents_per_hour from owned where cents>0 and playtime_minutes>=60
      order by cents*60.0/playtime_minutes,title,game_id limit 4
    ) select count(*) filter(where cents>0)::integer priced,sum(cents) library_value,
      case when count(cents)>0 then coalesce(sum(cents) filter(where completed_at is not null),0) end completed_value,
      case when count(cents)>0 then coalesce(sum(cents) filter(where playtime_minutes=0),0) end unplayed_value,
      coalesce((select jsonb_agg(to_jsonb(top_value) order by cents_per_hour,title,game_id) from top_value),'[]'::jsonb) games from owned`;
  const row=rows[0];
  return {aggregates:{pricedGames:row.priced,libraryValueCents:nullable(row.library_value),completedValueCents:nullable(row.completed_value),unplayedValueCents:nullable(row.unplayed_value)},
    games:row.games.map(item=>Object.freeze({game:game(item),cents:Number(item.cents),centsPerHour:Number(item.cents_per_hour)}))};
}
function game(row:GameRow):DashboardGame{return Object.freeze({gameId:row.game_id,title:row.title,appId:row.steam_app_id===null?null:String(row.steam_app_id),playtimeMinutes:row.playtime_minutes,completedAt:row.completed_at===null?null:row.completed_at instanceof Date?row.completed_at.toISOString():row.completed_at,imageUrl:row.capsule_image_url});}
function nullable(value:string|null) { return value===null?null:Number(value); }
function sumWithin(gains:readonly {day:string;minutes:number}[],days:number) {
  const today=new Date().toISOString().slice(0,10),cutoff=new Date();cutoff.setUTCDate(cutoff.getUTCDate()-(days-1));
  const start=cutoff.toISOString().slice(0,10);
  return gains.filter(gain=>gain.day>=start&&gain.day<=today).reduce((sum,gain)=>sum+gain.minutes,0);
}
