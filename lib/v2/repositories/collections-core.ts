import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { InvalidPageQueryError, PageCursorRestartRequiredError } from "./page-errors.ts";
import { parseSmartRule, smartEligibleCte, smartPredicate, type SmartRule } from "./smart-predicates.ts";

export type CollectionSummary = Readonly<{ publicId: string; kind: "custom" | "smart"; name: string; description: string | null; rules: SmartRule | null; revision: string; count: number; updatedAt: string }>;
export type CollectionMember = Readonly<{ gameId: number; appId: string | null; title: string; position: number; note: string | null }>;
export type CollectionMemberPage = Readonly<{ collection: CollectionSummary; items: readonly CollectionMember[]; nextCursor: string | null; total: number; libraryRevision: string; stateRevision: string }>;
type CollectionRow={id:string|number;public_id:string;collection_kind:"custom"|"smart";name:string;description:string|null;rules:unknown;revision:string|number;updated_at:string|Date;custom_count:string|number};
type MemberCursor={v:1;t:string;c:string;r:string;lr:string;sr:string;k:"custom"|"smart";p:number;s:string;g:number};

export class CollectionsRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient){this.database=database;}
  async list(principal:VerifiedServerPrincipal):Promise<readonly CollectionSummary[]> {
    try{return await this.database.withPrincipal(principal,async tx=>{
      const rows=await tx<CollectionRow[]>`select c.id,c.public_id,c.collection_kind,c.name,c.description,c.rules,c.revision,c.updated_at,count(g.id) custom_count from app.collections c left join app.collection_games cg on cg.account_id=c.account_id and cg.collection_id=c.id left join catalog.games g on g.id=cg.game_id and g.lifecycle_status='active' where c.account_id=${principal.accountId} group by c.id order by c.updated_at desc,c.id desc limit 101`;
      if(rows.length>100)throw new InvalidPageQueryError("This account has more collections than the bounded metadata contract supports.");
      const output:CollectionSummary[]=[];for(const row of rows){const rule=row.collection_kind==="smart"?parseSmartRule(row.rules):null;const count=rule?await smartCount(tx,principal.accountId,rule):Number(row.custom_count);output.push(summary(row,rule,count));}return Object.freeze(output);
    });}catch(error){if(error instanceof InvalidPageQueryError||error instanceof DatabaseUnavailableError)throw error;throw new DatabaseUnavailableError();}
  }
  async members(principal:VerifiedServerPrincipal,publicId:string,options:{limit?:number;cursor?:string}={}):Promise<CollectionMemberPage|null>{
    if(!UUID.test(publicId))throw new InvalidPageQueryError("The collection ID is invalid.");const limit=options.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new InvalidPageQueryError();const cursor=decode(options.cursor);
    if(cursor&&(cursor.t!==principal.accountPublicId||cursor.c!==publicId))throw new PageCursorRestartRequiredError();
    try{return await this.database.withPrincipal(principal,async tx=>{
      const found=await tx<CollectionRow[]>`select c.id,c.public_id,c.collection_kind,c.name,c.description,c.rules,c.revision,c.updated_at,count(g.id) custom_count from app.collections c left join app.collection_games cg on cg.account_id=c.account_id and cg.collection_id=c.id left join catalog.games g on g.id=cg.game_id and g.lifecycle_status='active' where c.account_id=${principal.accountId} and c.public_id=${publicId} group by c.id`;
      if(!found[0])return null;const row=found[0],rule=row.collection_kind==="smart"?parseSmartRule(row.rules):null;
      const revisions=await tx<{library_revision:string|number;state_revision:string|number}[]>`select library_revision,state_revision from app.accounts where id=${principal.accountId}`;const lr=String(revisions[0]?.library_revision??0),sr=String(revisions[0]?.state_revision??0);
      if(cursor&&(cursor.r!==String(row.revision)||cursor.lr!==lr||cursor.sr!==sr||cursor.k!==row.collection_kind))throw new PageCursorRestartRequiredError();
      const result=rule?await smartMembers(tx,principal.accountId,rule,limit,cursor):await customMembers(tx,principal.accountId,Number(row.id),limit,cursor);const count=rule?result.total:Number(row.custom_count);
      const collection=summary(row,rule,count),tail=result.items.at(-1);const nextCursor=result.hasMore&&tail?encode({v:1,t:principal.accountPublicId,c:publicId,r:String(row.revision),lr,sr,k:row.collection_kind,p:tail.position,s:tail.title.toLowerCase(),g:tail.gameId}):null;
      return Object.freeze({collection,items:Object.freeze(result.items),nextCursor,total:count,libraryRevision:lr,stateRevision:sr});
    });}catch(error){if(error instanceof InvalidPageQueryError||error instanceof PageCursorRestartRequiredError||error instanceof DatabaseUnavailableError)throw error;throw new DatabaseUnavailableError();}
  }
}
async function smartCount(tx:TenantTransaction,accountId:number,rule:SmartRule){const eligible=smartEligibleCte(tx,accountId),predicate=smartPredicate(tx,rule.preset);const rows=await tx<{count:string|number}[]>`with eligible as (${eligible}) select count(*) count from eligible where ${predicate}`;return Number(rows[0]?.count??0);}
async function customMembers(tx:TenantTransaction,accountId:number,id:number,limit:number,cursor:MemberCursor|null){const after=cursor?tx`and (cg.position,cg.game_id)>(${cursor.p},${cursor.g})`:tx``;const rows=await tx<{game_id:number;steam_app_id:string|number|null;title:string;position:number;note:string|null}[]>`select cg.game_id,g.steam_app_id,g.title,cg.position,cg.note from app.collection_games cg join catalog.games g on g.id=cg.game_id and g.lifecycle_status='active' where cg.account_id=${accountId} and cg.collection_id=${id} ${after} order by cg.position,cg.game_id limit ${limit+1}`;return {items:rows.slice(0,limit).map(member),hasMore:rows.length>limit,total:0};}
async function smartMembers(tx:TenantTransaction,accountId:number,rule:SmartRule,limit:number,cursor:MemberCursor|null){const eligible=smartEligibleCte(tx,accountId),predicate=smartPredicate(tx,rule.preset),after=cursor?tx`and (lower(title),game_id)>(${cursor.s},${cursor.g})`:tx``;const rows=await tx<{game_id:number;steam_app_id:string|number|null;title:string;total:string|number}[]>`with eligible as (${eligible}),filtered as(select * from eligible where ${predicate}),page as(select * from filtered where true ${after} order by lower(title),game_id limit ${limit+1}) select page.*,totals.total from (select count(*) total from filtered) totals left join page on true order by lower(page.title) nulls last,page.game_id nulls last`;const actual=rows.filter(x=>x.game_id!==null);return {items:actual.slice(0,limit).map((row,index)=>member({...row,position:(cursor?.p??-1)+index+1,note:null})),hasMore:actual.length>limit,total:Number(rows[0]?.total??0)};}
function summary(row:CollectionRow,rules:SmartRule|null,count:number):CollectionSummary{return Object.freeze({publicId:row.public_id,kind:row.collection_kind,name:row.name,description:row.description,rules,revision:String(row.revision),count,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():row.updated_at});}
function member(row:{game_id:number;steam_app_id:string|number|null;title:string;position:number;note:string|null}):CollectionMember{return Object.freeze({gameId:row.game_id,appId:row.steam_app_id===null?null:String(row.steam_app_id),title:row.title,position:row.position,note:row.note});}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function encode(cursor:MemberCursor){return Buffer.from(JSON.stringify(cursor)).toString("base64url");}
function decode(value:string|undefined):MemberCursor|null{if(value===undefined)return null;if(typeof value!=="string"||value.length<1||value.length>2048)throw new InvalidPageQueryError("The cursor is invalid.");try{const c=JSON.parse(Buffer.from(value,"base64url").toString("utf8")) as MemberCursor;if(c?.v!==1||typeof c.t!=="string"||typeof c.c!=="string"||typeof c.r!=="string"||typeof c.lr!=="string"||typeof c.sr!=="string"||(c.k!=="custom"&&c.k!=="smart")||!Number.isSafeInteger(c.p)||typeof c.s!=="string"||!Number.isSafeInteger(c.g)||c.g<1)throw 0;return c;}catch{throw new InvalidPageQueryError("The cursor is invalid.");}}
