import { createHash } from "node:crypto";
import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { InvalidPageQueryError, PageCursorRestartRequiredError } from "./page-errors.ts";
import { parseSmartRule, smartEligibleCte, smartPredicate, SMART_PRESETS, type SmartRule } from "./smart-predicates.ts";
import { libraryGlobalFilters } from "./library-global-filters.ts";
import { readLibraryCards, type LibraryCard } from "./library-core.ts";
import type { GlobalFilters } from "../../global-filters.ts";

export type CollectionPreview=Readonly<{gameId:number;title:string;imageUrl:string|null;access:"owned"|"family"}>;
export type CollectionSummary=Readonly<{publicId:string;kind:"custom"|"smart";name:string;description:string|null;rules:SmartRule|null;revision:string;count:number;updatedAt:string;preview:readonly CollectionPreview[]}>;
export type CollectionMember=Readonly<{gameId:number;appId:string|null;title:string;position:number;note:string|null;card:LibraryCard|null}>;
export type CollectionMemberPage=Readonly<{collection:CollectionSummary;items:readonly CollectionMember[];nextCursor:string|null;total:number;libraryRevision:string;stateRevision:string;catalogRevision:string}>;
type CollectionRow={id:number;public_id:string;collection_kind:"custom"|"smart";name:string;description:string|null;rules:unknown;revision:string|number;updated_at:string|Date;count:string|number;preview:CollectionPreview[]};
type MemberRow={game_id:number;steam_app_id:string|number|null;title:string;position:number;note:string|null};
type MemberCursor={v:1;t:string;c:string;r:string;lr:string;sr:string;cr:string;f:string;k:"custom"|"smart";p:number;s:string;g:number};
export type CollectionPageQuery={limit?:number;cursor?:string;globalFilters?:GlobalFilters};

export class CollectionsRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient){this.database=database;}
  async list(principal:VerifiedServerPrincipal,filters?:GlobalFilters):Promise<readonly CollectionSummary[]> {
    const f=libraryGlobalFilters(filters);
    try{return await this.database.withPrincipal(principal,async tx=>{
      const rows=await collectionRows(tx,principal.accountId,f);
      if(rows.length>100)throw new InvalidPageQueryError("This account has more collections than the bounded metadata contract supports.");
      return Object.freeze(rows.map(summary));
    });}catch(error){return failed(error);}
  }
  async members(principal:VerifiedServerPrincipal,publicId:string,options:CollectionPageQuery={}):Promise<CollectionMemberPage|null>{
    if(!UUID.test(publicId))throw new InvalidPageQueryError("The collection ID is invalid.");
    const limit=options.limit??50,f=libraryGlobalFilters(options.globalFilters),filterHash=createHash('sha256').update(JSON.stringify(f)).digest('base64url').slice(0,22);
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new InvalidPageQueryError();
    const cursor=decode(options.cursor);
    if(cursor&&(cursor.t!==principal.accountPublicId||cursor.c!==publicId||cursor.f!==filterHash))throw new PageCursorRestartRequiredError();
    try{return await this.database.withPrincipal(principal,async tx=>{
      const found=await collectionRows(tx,principal.accountId,f,publicId);
      if(!found[0])return null;
      const row=found[0],rule=row.collection_kind==='smart'?parseSmartRule(row.rules):null;
      const eligible=smartEligibleCte(tx,principal.accountId,f);
      const versions=await tx<{library_revision:string;state_revision:string;catalog_revision:string}[]>`
        with eligible as (${eligible}) select a.library_revision,a.state_revision,
          coalesce((select md5(string_agg(game_id||':'||catalog_stamp,',' order by game_id)) from eligible),'empty') catalog_revision
        from app.accounts a where a.id=${principal.accountId}`;
      const version=versions[0],lr=String(version?.library_revision??0),sr=String(version?.state_revision??0),cr=version?.catalog_revision??'empty';
      if(cursor&&(cursor.r!==String(row.revision)||cursor.lr!==lr||cursor.sr!==sr||cursor.cr!==cr||cursor.k!==row.collection_kind))throw new PageCursorRestartRequiredError();
      const after=!cursor?tx``:rule?tx`and (lower(e.title),e.game_id)>(${cursor.s},${cursor.g})`:tx`and (cg.position,cg.game_id)>(${cursor.p},${cursor.g})`;
      const order=rule?tx`lower(e.title),e.game_id`:tx`cg.position,cg.game_id`;
      const rows=await tx<MemberRow[]>`with eligible as (${eligible})
        select e.game_id,e.steam_app_id,e.title,${rule?tx`0`:tx`cg.position`} position,${rule?tx`null::text`:tx`cg.note`} note
        from eligible e ${rule?tx``:tx`join app.collection_games cg on cg.account_id=${principal.accountId} and cg.collection_id=${row.id} and cg.game_id=e.game_id`}
        where ${rule?smartPredicate(tx,rule.preset):tx`true`} ${after} order by ${order} limit ${limit+1}`;
      const selected=rows.slice(0,limit);
      const cards=new Map((await readLibraryCards(tx,principal.accountId,selected.map(item=>item.game_id))).map(card=>[card.gameId,card]));
      const items=selected.map((item,index)=>Object.freeze({gameId:item.game_id,appId:item.steam_app_id===null?null:String(item.steam_app_id),title:item.title,
        position:rule?(cursor?.p??-1)+index+1:item.position,note:item.note,card:cards.get(item.game_id)??null}));
      const tail=items.at(-1);
      const nextCursor=rows.length>limit&&tail?encode({v:1,t:principal.accountPublicId,c:publicId,r:String(row.revision),lr,sr,cr,f:filterHash,k:row.collection_kind,p:tail.position,s:tail.title.toLowerCase(),g:tail.gameId}):null;
      return Object.freeze({collection:summary(row),items:Object.freeze(items),nextCursor,total:Number(row.count),libraryRevision:lr,stateRevision:sr,catalogRevision:cr});
    });}catch(error){return failed(error);}
  }
}
/** One metadata query, including whole counts and at most four image-only previews per shelf. */
async function collectionRows(tx:TenantTransaction,accountId:number,f:GlobalFilters,publicId?:string) {
  const cases=SMART_PRESETS.map(preset=>tx`when ${preset} then (${smartPredicate(tx,preset)})`).reduce((left,right)=>tx`${left} ${right}`);
  return tx<CollectionRow[]>`
    with shelves as(select * from app.collections where account_id=${accountId} ${publicId?tx`and public_id=${publicId}`:tx``} order by updated_at desc,id desc limit 101),
    eligible as (${smartEligibleCte(tx,accountId,f)}), matches as (
      select c.id collection_id,e.game_id,e.title,e.access,e.image_url,c.collection_kind,cg.position
      from shelves c cross join eligible e
      left join app.collection_games cg on cg.account_id=${accountId} and cg.collection_id=c.id and cg.game_id=e.game_id
      where (c.collection_kind='custom' and cg.game_id is not null)
        or (c.collection_kind='smart' and case c.rules->>'preset' ${cases} else false end)
    ) select c.id,c.public_id,c.collection_kind,c.name,c.description,c.rules,c.revision,c.updated_at,
      (select count(*) from matches m where m.collection_id=c.id) count,
      coalesce((select jsonb_agg(jsonb_build_object('gameId',p.game_id,'title',p.title,'imageUrl',p.image_url,'access',p.access)
        order by p.position nulls last,lower(p.title),p.game_id) from (
          select * from matches m where m.collection_id=c.id order by case when c.collection_kind='custom' then m.position end nulls last,lower(m.title),m.game_id limit 4
        ) p),'[]'::jsonb) preview from shelves c order by c.updated_at desc,c.id desc`;
}
function summary(row:CollectionRow):CollectionSummary{return Object.freeze({publicId:row.public_id,kind:row.collection_kind,name:row.name,description:row.description,
  rules:row.collection_kind==='smart'?parseSmartRule(row.rules):null,revision:String(row.revision),count:Number(row.count),
  updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():row.updated_at,preview:Object.freeze(row.preview)});}
function failed(error:unknown):never {if(error instanceof InvalidPageQueryError||error instanceof PageCursorRestartRequiredError||error instanceof DatabaseUnavailableError)throw error;throw new DatabaseUnavailableError(error);}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function encode(cursor:MemberCursor){return Buffer.from(JSON.stringify(cursor)).toString('base64url');}
function decode(value:string|undefined):MemberCursor|null {
  if(value===undefined)return null;if(typeof value!=='string'||value.length<1||value.length>2048)throw new InvalidPageQueryError('The cursor is invalid.');
  try {const c=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as MemberCursor;
    if(c?.v!==1||typeof c.t!=='string'||typeof c.c!=='string'||typeof c.r!=='string'||typeof c.lr!=='string'||typeof c.sr!=='string'||typeof c.cr!=='string'||typeof c.f!=='string'
      ||(c.k!=='custom'&&c.k!=='smart')||!Number.isSafeInteger(c.p)||typeof c.s!=='string'||!Number.isSafeInteger(c.g)||c.g<1)throw 0;
    return c;
  }catch{throw new InvalidPageQueryError('The cursor is invalid.');}
}
