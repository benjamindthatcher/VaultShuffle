import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { InvalidPageQueryError } from "./page-errors.ts";
import { parseSmartRule, smartPredicate, type SmartRule } from "./smart-predicates.ts";

export type CollectionInput = { name:string; description?:string; kind?:"custom"|"smart"; rules?:{preset:string;version?:number} };
export class CollectionNotFoundError extends InvalidPageQueryError { readonly code="not_found"; readonly status=404; }
export class CollectionConflictError extends InvalidPageQueryError { readonly code="collection_changed"; readonly status=409; }
type Row = {id:string; collection_kind:"custom"|"smart"; rules:unknown};

export class CollectionMutationsRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient) { this.database=database; }

  async create(principal:VerifiedServerPrincipal,input:CollectionInput):Promise<string> {
    validate(input,false);
    return this.run(principal,async tx=>{
      await tx`select id from app.accounts where id=${principal.accountId} for update`;
      const count=await tx<{count:number}[]>`select count(*)::integer count from app.collections where account_id=${principal.accountId}`;
      if(count[0].count>=100) throw new CollectionConflictError();
      const kind=input.kind??"custom",rules=kind==='smart'?supportedRule(tx,input.rules):null;
      const rows=await tx<{public_id:string}[]>`insert into app.collections(account_id,collection_kind,name,description,rules)
        values(${principal.accountId},${kind},${input.name.trim()},${input.description?.trim()||null},${rules?tx.json(rules):null}) returning public_id`;
      return rows[0].public_id;
    });
  }
  async update(principal:VerifiedServerPrincipal,id:string,input:Partial<CollectionInput>):Promise<void> {
    validate(input,true); validId(id);
    await this.run(principal,async tx=>{
      const row=await collection(tx,principal.accountId,id);
      const kind=input.kind??row.collection_kind;
      const rules=kind==='smart'?supportedRule(tx,input.rules??row.rules):null;
      if(row.collection_kind==='custom'&&kind==='smart') await tx`delete from app.collection_games where account_id=${principal.accountId} and collection_id=${row.id}`;
      await tx`update app.collections set
        name=case when ${input.name!==undefined} then ${input.name?.trim()??null} else name end,
        description=case when ${input.description!==undefined} then ${input.description?.trim()||null} else description end,
        collection_kind=${kind},rules=${rules?tx.json(rules):null},revision=revision+1,updated_at=statement_timestamp()
        where account_id=${principal.accountId} and id=${row.id}`;
    });
  }
  async remove(principal:VerifiedServerPrincipal,id:string):Promise<void> {
    validId(id);
    await this.run(principal,async tx=>{
      const row=await collection(tx,principal.accountId,id);
      await tx`delete from app.collections where account_id=${principal.accountId} and id=${row.id}`;
    });
  }
  async addGame(principal:VerifiedServerPrincipal,id:string,gameId:number,note?:string,position?:number):Promise<void> {
    validId(id); validGame(gameId);
    if(note!==undefined&&(typeof note!=='string'||note.length>500)
      ||position!==undefined&&(!Number.isInteger(position)||position<0||position>2147483647)) throw new InvalidPageQueryError();
    await this.run(principal,async tx=>{
      const row=await collection(tx,principal.accountId,id); if(row.collection_kind!=='custom') throw new InvalidPageQueryError('Smart collection membership is automatic.');
      const accessible=await tx<{id:number}[]>`select g.id from catalog.games g where g.id=${gameId} and g.lifecycle_status='active'
        and (exists(select 1 from app.library_games where account_id=${principal.accountId} and game_id=g.id)
          or exists(select 1 from app.family_game_access where account_id=${principal.accountId} and game_id=g.id))`;
      if(!accessible[0]) throw new CollectionNotFoundError();
      const existing=await tx<{position:number}[]>`select position from app.collection_games where account_id=${principal.accountId} and collection_id=${row.id} and game_id=${gameId}`;
      const tail=await tx<{position:number}[]>`select coalesce(max(position),-1) position from app.collection_games where account_id=${principal.accountId} and collection_id=${row.id}`;
      const target=position??existing[0]?.position??(tail[0].position+1);
      if(target>2147483647) throw new CollectionConflictError();
      const occupied=await tx<{game_id:number}[]>`select game_id from app.collection_games where account_id=${principal.accountId} and collection_id=${row.id} and position=${target} and game_id<>${gameId}`;
      if(occupied[0]) throw new CollectionConflictError();
      await tx`insert into app.collection_games(account_id,collection_id,game_id,position,note)
        values(${principal.accountId},${row.id},${gameId},${target},${note?.trim()||null})
        on conflict(account_id,collection_id,game_id) do update set position=excluded.position,note=excluded.note`;
    });
  }
  /** Atomic additive picker batch; duplicates retain their notes and positions. */
  async addGames(principal:VerifiedServerPrincipal,id:string,gameIds:readonly number[]):Promise<void> {
    validId(id);
    if(!Array.isArray(gameIds)||gameIds.length<1||gameIds.length>1000)throw new InvalidPageQueryError();
    gameIds.forEach(validGame);
    const ids=[...new Set(gameIds)];
    await this.run(principal,async tx=>{
      const row=await collection(tx,principal.accountId,id);
      if(row.collection_kind!=='custom')throw new InvalidPageQueryError('Smart collection membership is automatic.');
      const accessible=await tx<{id:number}[]>`select g.id from catalog.games g where g.id=any(${tx.array(ids)}::integer[]) and g.lifecycle_status='active'
        and (exists(select 1 from app.library_games where account_id=${principal.accountId} and game_id=g.id)
          or exists(select 1 from app.family_game_access where account_id=${principal.accountId} and game_id=g.id))`;
      if(accessible.length!==ids.length)throw new CollectionNotFoundError();
      const current=await tx<{tail:number;new_count:number}[]>`select coalesce(max(position),-1) tail,
        (select count(*)::integer from unnest(${tx.array(ids)}::integer[]) chosen(game_id)
          where not exists(select 1 from app.collection_games cg where cg.account_id=${principal.accountId} and cg.collection_id=${row.id} and cg.game_id=chosen.game_id)) new_count
        from app.collection_games where account_id=${principal.accountId} and collection_id=${row.id}`;
      if(current[0].tail+current[0].new_count>2147483647)throw new CollectionConflictError();
      await tx`insert into app.collection_games(account_id,collection_id,game_id,position)
        select ${principal.accountId},${row.id},chosen.game_id,${current[0].tail}+row_number() over(order by chosen.ordinal)
        from unnest(${tx.array(ids)}::integer[]) with ordinality chosen(game_id,ordinal)
        where not exists(select 1 from app.collection_games cg where cg.account_id=${principal.accountId} and cg.collection_id=${row.id} and cg.game_id=chosen.game_id)
        on conflict(account_id,collection_id,game_id) do nothing`;
    });
  }
  async removeGame(principal:VerifiedServerPrincipal,id:string,gameId:number):Promise<void> {
    validId(id); validGame(gameId);
    await this.run(principal,async tx=>{
      const row=await collection(tx,principal.accountId,id); if(row.collection_kind!=='custom') throw new InvalidPageQueryError('Smart collection membership is automatic.');
      await tx`delete from app.collection_games where account_id=${principal.accountId} and collection_id=${row.id} and game_id=${gameId}`;
    });
  }
  private async run<T>(principal:VerifiedServerPrincipal,operation:(tx:TenantTransaction)=>Promise<T>):Promise<T> {
    try{return await this.database.withPrincipal(principal,operation);}
    catch(error){if(error instanceof InvalidPageQueryError) throw error; throw new DatabaseUnavailableError(error);}
  }
}
async function collection(tx:TenantTransaction,accountId:number,id:string):Promise<Row> {
  // Lock in the same account -> child order as revision triggers and all other
  // authored mutations, avoiding cross-feature deadlocks.
  await tx`select id from app.accounts where id=${accountId} for update`;
  const rows=await tx<Row[]>`select id,collection_kind,rules from app.collections where account_id=${accountId} and public_id=${id} for update`;
  if(!rows[0]) throw new CollectionNotFoundError(); return rows[0];
}
function supportedRule(tx:TenantTransaction,value:unknown):SmartRule { const rule=parseSmartRule(value); smartPredicate(tx,rule.preset); return rule; }
function validate(input:Partial<CollectionInput>,partial:boolean) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!["name","description","kind","rules"].includes(key))
    ||(!partial&&input.name===undefined)||(input.name!==undefined&&(typeof input.name!=='string'||input.name.trim().length<1||input.name.trim().length>90))
    ||input.description!==undefined&&(typeof input.description!=='string'||input.description.length>280)
    ||input.kind!==undefined&&!['custom','smart'].includes(input.kind)) throw new InvalidPageQueryError();
}
function validId(id:string) {if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new InvalidPageQueryError();}
function validGame(id:number) {if(!Number.isInteger(id)||id<1||id>2147483647) throw new InvalidPageQueryError();}
