import { createHash } from "node:crypto";
import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { InvalidPageQueryError, PageCursorRestartRequiredError } from "./page-errors.ts";

export const LIBRARY_SORTS = ["recent", "title", "hours", "progress", "added", "duration", "status"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];
export type LibrarySection = "active" | "completed" | "blacklisted" | "all";
export type LibraryLength = "any" | "under-10" | "10-30" | "over-30" | "endless";
export type LibraryQuery = Readonly<{ cursor?: string; limit?: number; search?: string; access?: "all" | "owned" | "family"; progress?: "any" | "not-started" | "in-progress"; length?: LibraryLength; genres?: readonly string[]; section?: LibrarySection; sort?: LibrarySort; direction?: "asc" | "desc"; includeCompleted?: boolean; includeBlacklisted?: boolean }>;
export type LibraryRevision = Readonly<{ library: string; state: string; catalog: string; features: string }>;
export type LibraryCard = Readonly<{ gameId: number; title: string; appId: string | null; playtimeMinutes: number | null; access: "owned" | "family"; completed: boolean; blacklisted: boolean; lastPlayedAt: string | null; notes?: string | null; manualProgress?: number | null; genres?: readonly { tag: string; weight: number | null }[]; description?: string | null; imageUrl?: string | null }>;
export type LibraryPage = Readonly<{ items: readonly LibraryCard[]; nextCursor: string | null; total: number; revision: LibraryRevision }>;

type Normalized = Readonly<{ limit: number; search: string; access: "all" | "owned" | "family"; progress: "any" | "not-started" | "in-progress"; length: LibraryLength; genres: readonly string[]; section: LibrarySection; includeCompleted: boolean; includeBlacklisted: boolean; sort: LibrarySort; direction: "asc" | "desc"; filterHash: string }>;
type Cursor = Readonly<{ v: 1; s: LibrarySort; d: "asc" | "desc"; f: string; t: string; r: readonly [string, string, string, string]; n: boolean; k: string | null; g: number }>;
type Row = { game_id: number; title: string; steam_app_id: string | number | null; playtime_minutes: number | null; access: "owned" | "family"; completed: boolean; blacklisted: boolean; last_played_at: Date | string | null; sort_value: string | null; total: string | number; library_revision: string | number; state_revision: string | number; catalog_revision: string; feature_revision: string };
type PageRow = { [Key in keyof Row]: Key extends "total" | "library_revision" | "state_revision" | "catalog_revision" | "feature_revision" ? Row[Key] : Row[Key] | null };

export class LibraryRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database = database; }
  async list(principal: VerifiedServerPrincipal, query: LibraryQuery = {}): Promise<LibraryPage> {
    const normalized = normalize(query);
    const cursor = decodeCursor(query.cursor);
    if (cursor && (cursor.s !== normalized.sort || cursor.d !== normalized.direction || cursor.f !== normalized.filterHash || cursor.t !== principal.accountPublicId)) throw new PageCursorRestartRequiredError();
    try {
      return await this.database.withPrincipal(principal, async (tx) => {
        const rows = await pageRows(tx, principal.accountId, normalized, cursor);
        const first = rows[0];
        const revision: LibraryRevision = Object.freeze({ library: String(first?.library_revision ?? "0"), state: String(first?.state_revision ?? "0"), catalog: String(first?.catalog_revision ?? "empty"), features: String(first?.feature_revision ?? "empty") });
        const revisionTuple = [revision.library, revision.state, revision.catalog, revision.features];
        if (cursor && cursor.r.some((value, index) => value !== revisionTuple[index])) throw new PageCursorRestartRequiredError();
        const matching = rows.filter((row) => row.game_id !== null) as Row[];
        const selected = matching.slice(0, normalized.limit);
        const tail = selected.at(-1);
        return Object.freeze({ items: Object.freeze(selected.map(card)), total: Number(first?.total ?? 0), revision, nextCursor: matching.length > normalized.limit && tail ? encodeCursor(normalized, principal.accountPublicId, revision, tail) : null });
      });
    } catch (error) {
      if (error instanceof InvalidPageQueryError || error instanceof PageCursorRestartRequiredError || error instanceof DatabaseUnavailableError) throw error;
      throw new DatabaseUnavailableError();
    }
  }
  async detail(principal: VerifiedServerPrincipal, gameId: number): Promise<LibraryCard | null> {
    if (!Number.isSafeInteger(gameId) || gameId < 1) throw new InvalidPageQueryError("The game ID is invalid.");
    try { return await this.database.withPrincipal(principal, async tx => {
      const rows = await tx<(Row & { notes: string | null; manual_progress: string | number | null; genres: unknown; short_description: string | null; capsule_image_url: string | null })[]>`
        with accessible as (
          select lg.game_id,lg.playtime_minutes,'owned'::text access from app.library_games lg where lg.account_id=${principal.accountId} and lg.game_id=${gameId}
          union all select f.game_id,null::integer,'family'::text from app.family_game_access f where f.account_id=${principal.accountId} and f.game_id=${gameId}
            and not exists(select 1 from app.library_games lg where lg.account_id=f.account_id and lg.game_id=f.game_id) group by f.game_id
        ) select a.game_id,g.title,g.steam_app_id,a.playtime_minutes,a.access,coalesce(gs.completed_at is not null,false) completed,
          coalesce(gs.blacklisted,false) blacklisted,ga.last_played_at,null::text sort_value,0 total,0 library_revision,0 state_revision,'' catalog_revision,'' feature_revision,
          gs.notes,gs.manual_progress,coalesce(gm.genres,'[]'::jsonb)||coalesce(gm.weighted_tags,'[]'::jsonb) genres,gm.short_description,gm.capsule_image_url
        from accessible a join catalog.games g on g.id=a.game_id left join app.game_state gs on gs.account_id=${principal.accountId} and gs.game_id=a.game_id
        left join app.game_activity ga on ga.account_id=${principal.accountId} and ga.game_id=a.game_id left join catalog.game_metadata gm on gm.game_id=a.game_id where g.lifecycle_status='active'`;
      return rows[0] ? detailCard(rows[0]) : null;
    }); } catch(error) { if(error instanceof InvalidPageQueryError || error instanceof DatabaseUnavailableError) throw error; throw new DatabaseUnavailableError(); }
  }
}

async function pageRows(tx: TenantTransaction, accountId: number, q: Normalized, cursor: Cursor | null): Promise<PageRow[]> {
  const genres = tx.array([...q.genres]), cursorNull = cursor?.n ?? false, cursorKey = cursor?.k ?? "", cursorGame = cursor?.g ?? 0;
  const after = !cursor ? tx`` : q.direction === "asc"
    ? tx`and ((${cursorNull} and sort_value is null and game_id > ${cursorGame}) or (not ${cursorNull} and (sort_value is null or sort_value > ${cursorKey} or (sort_value = ${cursorKey} and game_id > ${cursorGame}))))`
    : tx`and ((${cursorNull} and sort_value is null and game_id < ${cursorGame}) or (not ${cursorNull} and (sort_value is null or sort_value < ${cursorKey} or (sort_value = ${cursorKey} and game_id < ${cursorGame}))))`;
  const order = q.direction === "asc" ? tx`sort_value asc, game_id asc` : tx`sort_value desc, game_id desc`;
  return tx<PageRow[]>`
    with accessible as (
      select lg.game_id,lg.playtime_minutes,'owned'::text access from app.library_games lg where lg.account_id=${accountId}
      union all select f.game_id,null::integer,'family'::text from app.family_game_access f where f.account_id=${accountId}
        and not exists(select 1 from app.library_games lg where lg.account_id=f.account_id and lg.game_id=f.game_id) group by f.game_id
    ), base as (
      select a.game_id,g.title,g.normalized_sort_title,g.steam_app_id,g.first_seen_at,g.updated_at game_updated_at,a.playtime_minutes,a.access,
        coalesce(gs.completed_at is not null,false) completed,coalesce(gs.blacklisted,false) blacklisted,gs.manual_progress,ga.last_played_at,
        gm.updated_at metadata_updated_at,gf.feature_revision,gf.updated_at feature_updated_at,gf.duration_kind,
        case when coalesce(gf.main_duration_minutes,0)+coalesce(gf.extras_duration_minutes,0)+coalesce(gf.completion_duration_minutes,0)>0
          then round((coalesce(nullif(gf.main_duration_minutes,0),nullif(gf.extras_duration_minutes,0),nullif(gf.completion_duration_minutes,0))+coalesce(nullif(gf.extras_duration_minutes,0),nullif(gf.main_duration_minutes,0),nullif(gf.completion_duration_minutes,0))+coalesce(nullif(gf.completion_duration_minutes,0),nullif(gf.extras_duration_minutes,0),nullif(gf.main_duration_minutes,0)))/3.0)::integer end duration_minutes,
        gm.genres,gm.weighted_tags
      from accessible a join catalog.games g on g.id=a.game_id left join app.game_state gs on gs.account_id=${accountId} and gs.game_id=a.game_id
      left join app.game_activity ga on ga.account_id=${accountId} and ga.game_id=a.game_id left join catalog.game_metadata gm on gm.game_id=a.game_id left join catalog.game_features gf on gf.game_id=a.game_id
      where g.lifecycle_status='active'
    ), filtered_raw as (
      select *,case ${q.sort} when 'title' then lower(normalized_sort_title) when 'hours' then case when playtime_minutes is not null then lpad(playtime_minutes::text,20,'0') end
        when 'progress' then case when manual_progress is not null then lpad(round(manual_progress*100)::text,20,'0') when duration_minutes>0 and playtime_minutes is not null then lpad(least(10000,round(playtime_minutes*10000.0/duration_minutes))::text,20,'0') end
        when 'added' then to_char(first_seen_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') when 'duration' then case when duration_minutes is not null then lpad(duration_minutes::text,20,'0') end
        when 'status' then case when completed then '4' when blacklisted then '1' when coalesce(playtime_minutes,0)>0 then '3' else '2' end else to_char(last_played_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') end sort_value
      from base where (${q.access}='all' or access=${q.access}) and (${q.progress}='any' or (${q.progress}='not-started' and playtime_minutes=0) or (${q.progress}='in-progress' and playtime_minutes>0))
        and (${q.length}='any' or (${q.length}='endless' and duration_kind='endless') or (${q.length}='under-10' and duration_kind<>'endless' and duration_minutes<600) or (${q.length}='10-30' and duration_kind<>'endless' and duration_minutes between 600 and 1800) or (${q.length}='over-30' and duration_kind<>'endless' and duration_minutes>1800))
        and (case ${q.section} when 'active' then not completed and not blacklisted when 'completed' then completed when 'blacklisted' then blacklisted when 'all' then true end)
        and (${q.includeCompleted} or not completed) and (${q.includeBlacklisted} or not blacklisted)
        and (${q.search}='' or title ilike '%'||${q.search}||'%' or exists(select 1 from jsonb_array_elements(coalesce(genres,'[]')||coalesce(weighted_tags,'[]')) e(value) where lower(case jsonb_typeof(e.value) when 'string' then e.value#>>'{}' when 'object' then coalesce(e.value->>'tag',e.value->>'label','') else '' end) like '%'||lower(${q.search})||'%'))
        and (cardinality(${genres}::text[])=0 or exists(select 1 from jsonb_array_elements(coalesce(genres,'[]')||coalesce(weighted_tags,'[]')) e(value) where lower(case jsonb_typeof(e.value) when 'string' then e.value#>>'{}' when 'object' then coalesce(e.value->>'tag',e.value->>'label','') else '' end)=any(${genres}::text[])))
    ), revisions as (
      select a.library_revision,a.state_revision,coalesce(md5(string_agg(b.game_id||':'||coalesce(extract(epoch from b.game_updated_at)::text,'')||':'||coalesce(extract(epoch from b.metadata_updated_at)::text,'') order by b.game_id)),'empty') catalog_revision,
        coalesce(md5(string_agg(b.game_id||':'||coalesce(b.feature_revision::text,'')||':'||coalesce(extract(epoch from b.feature_updated_at)::text,'') order by b.game_id)),'empty') feature_revision
      from app.accounts a left join base b on true where a.id=${accountId} group by a.library_revision,a.state_revision
    ), filtered as (select * from filtered_raw), page as (select * from filtered where true ${after} order by (sort_value is null) asc, ${order} limit ${q.limit+1})
    select page.*,totals.total,r.library_revision,r.state_revision,r.catalog_revision,r.feature_revision from (select count(*) total from filtered) totals cross join revisions r left join page on true
      order by (page.sort_value is null) asc, ${order}`;
}

function normalize(query: LibraryQuery): Normalized {
  const limit=query.limit??50,search=query.search?.trim()??"",access=query.access??"all",progress=query.progress??"any",length=query.length??"any",sort=query.sort??"hours",direction=query.direction??(sort==="title"||sort==="duration"?"asc":"desc"),rawGenres=query.genres??[];
  if(!Number.isInteger(limit)||limit<1||limit>100||search.length>120||rawGenres.length>18||!(["all","owned","family"] as const).includes(access)||!(["any","not-started","in-progress"] as const).includes(progress)||!(["any","under-10","10-30","over-30","endless"] as const).includes(length)||!LIBRARY_SORTS.includes(sort)||!(["asc","desc"] as const).includes(direction))throw new InvalidPageQueryError();
  const genres=[...new Set(rawGenres.map(value=>typeof value==="string"?value.trim().toLowerCase():""))];if(genres.some(value=>value.length<1||value.length>80))throw new InvalidPageQueryError();
  if(query.section!==undefined&&(query.includeCompleted!==undefined||query.includeBlacklisted!==undefined))throw new InvalidPageQueryError("Use either section or compatibility include switches.");
  let section:LibrarySection=query.section??"all",includeCompleted=query.includeCompleted??false,includeBlacklisted=query.includeBlacklisted??false;if(query.section!==undefined){if(!(["active","completed","blacklisted","all"] as const).includes(query.section))throw new InvalidPageQueryError();includeCompleted=true;includeBlacklisted=true;section=query.section;}
  const canonical={search:search.toLowerCase(),access,progress,length,genres:[...genres].sort(),section,includeCompleted,includeBlacklisted};const filterHash=createHash("sha256").update(JSON.stringify(canonical)).digest("base64url").slice(0,22);
  return Object.freeze({limit,search,access,progress,length,genres:Object.freeze(genres),section,includeCompleted,includeBlacklisted,sort,direction,filterHash});
}
function decodeCursor(value:string|undefined):Cursor|null{if(value===undefined)return null;if(typeof value!=="string"||value.length<1||value.length>2048)throw new InvalidPageQueryError("The cursor is invalid.");try{const parsed:unknown=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw 0;const c=parsed as Partial<Cursor>;if(c.v!==1||!LIBRARY_SORTS.includes(c.s as LibrarySort)||(c.d!=="asc"&&c.d!=="desc")||typeof c.f!=="string"||typeof c.t!=="string"||!Array.isArray(c.r)||c.r.length!==4||!c.r.every(x=>typeof x==="string")||typeof c.n!=="boolean"||(c.k!==null&&typeof c.k!=="string")||!Number.isSafeInteger(c.g)||Number(c.g)<1)throw 0;return c as Cursor;}catch{throw new InvalidPageQueryError("The cursor is invalid.");}}
function encodeCursor(q:Normalized,tenant:string,r:LibraryRevision,row:Row):string{return Buffer.from(JSON.stringify({v:1,s:q.sort,d:q.direction,f:q.filterHash,t:tenant,r:[r.library,r.state,r.catalog,r.features],n:row.sort_value===null,k:row.sort_value,g:row.game_id} satisfies Cursor)).toString("base64url");}
function card(row:Row):LibraryCard{return Object.freeze({gameId:row.game_id,title:row.title,appId:row.steam_app_id===null?null:String(row.steam_app_id),playtimeMinutes:row.playtime_minutes,access:row.access,completed:row.completed,blacklisted:row.blacklisted,lastPlayedAt:row.last_played_at===null?null:row.last_played_at instanceof Date?row.last_played_at.toISOString():row.last_played_at});}
function detailCard(row:Row&{notes:string|null;manual_progress:string|number|null;genres:unknown;short_description:string|null;capsule_image_url:string|null}):LibraryCard{return Object.freeze({...card(row),notes:row.notes,manualProgress:row.manual_progress===null?null:Number(row.manual_progress),genres:tags(row.genres),description:row.short_description,imageUrl:row.capsule_image_url});}
function tags(value:unknown):readonly {tag:string;weight:number|null}[]{if(!Array.isArray(value))return [];const found=new Map<string,{tag:string;weight:number|null}>();for(const item of value){const tag=typeof item==="string"?item:item&&typeof item==="object"&&typeof (item as any).tag==="string"?(item as any).tag:item&&typeof item==="object"&&typeof (item as any).label==="string"?(item as any).label:null;if(!tag)continue;const weight=item&&typeof item==="object"&&typeof (item as any).weight==="number"?(item as any).weight:null;const key=tag.toLowerCase();const previous=found.get(key);if(!previous||(previous.weight===null&&weight!==null))found.set(key,{tag,weight});}return [...found.values()];}
