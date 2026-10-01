import type { DatabaseClient, VerifiedServerPrincipal, TenantTransaction } from "../db/client.ts";
import { DatabaseUnavailableError, RequestLimitError } from "../db/errors.ts";
import { InvalidPageQueryError } from "./page-errors.ts";
import type { FamilyImportCounts } from "../../family-sharing.ts";
import { canonicalSteamProfileUrl } from "../../steam-profile-input.ts";

export type FamilyMember = Readonly<{ id:string; steamId:string; displayName:string; avatarUrl:string|null; profileUrl:string;
  librarySeen:number; gamesImported:number; lastSyncedAt:string|null; lastError:string|null }>;
export type FamilyLookup = Readonly<{ attemptId:string; attemptToken:string; expiresAt:string }>;
export type FamilySnapshot = Readonly<{ steamId:string; displayName:string; avatarUrl:string|null;
  games:readonly {appId:string; title:string}[]; observedAt:string; lookup:FamilyLookup }>;
type Row={id:string;steam_id:string;display_name:string|null;avatar_url:string|null;profile_url:string|null;
  library_seen:number;games_imported:number;last_synced_at:string|null;last_error:string|null};

export class FamilyRequestError extends InvalidPageQueryError {
  readonly code:string;
  readonly status:number;
  constructor(code:string,message:string,status=400){super(message);this.code=code;this.status=status;}
}

export class FamilyRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient) {this.database=database;}

  async list(principal:VerifiedServerPrincipal):Promise<FamilyMember[]> {
    return this.run(principal,async tx=>{
      const rows=await tx<Row[]>`select m.public_id id,m.steam_id::text,m.display_name,m.avatar_url,m.profile_url,
        m.candidate_count library_seen,(select count(*)::integer from app.family_game_access f
          where f.account_id=m.account_id and f.member_id=m.id
          and not exists(select 1 from app.library_games l where l.account_id=f.account_id and l.game_id=f.game_id)) games_imported,
        to_char(m.last_synced_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') last_synced_at,m.last_error
        from app.family_members m where m.account_id=${principal.accountId} order by m.id limit 5`;
      return rows.map(row=>({id:row.id,steamId:row.steam_id,displayName:row.display_name??'Steam player',
        avatarUrl:row.avatar_url,profileUrl:row.profile_url??canonicalSteamProfileUrl(row.steam_id),
        librarySeen:row.library_seen,gamesImported:row.games_imported,lastSyncedAt:row.last_synced_at,lastError:row.last_error}));
    });
  }

  /** Preflight is advisory; the publishing transaction repeats all checks. */
  async checkAdd(principal:VerifiedServerPrincipal,steamId?:string) {
    if(steamId!==undefined&&!/^[1-9][0-9]{16}$/.test(steamId))throw new FamilyRequestError('invalid_profile','Enter a valid Steam profile.');
    return this.run(principal,async tx=>{
      const rows=await tx<{steam_id:string|null;count:number;duplicate:boolean}[]>`select sp.steam_id::text,
        (select count(*)::integer from app.family_members where account_id=${principal.accountId}) count,
        exists(select 1 from app.family_members where account_id=${principal.accountId} and steam_id=${steamId??null}::bigint) duplicate
        from app.accounts a left join app.steam_profiles sp on sp.account_id=a.id
        where a.id=${principal.accountId} and a.lifecycle_status='active'`;
      if(!rows[0]?.steam_id)throw new DatabaseUnavailableError();
      if(rows[0].count>=5)throw new FamilyRequestError('limit_reached','Your family already has five other members.',409);
      if(steamId===rows[0].steam_id)throw new FamilyRequestError('is_self','Add a family member other than your own Steam profile.',409);
      if(rows[0].duplicate)throw new FamilyRequestError('already_added','That family member has already been added.',409);
    });
  }

  async reserveLookup(principal:VerifiedServerPrincipal,endpoint:'profile'|'vanity'|'public_owned_lookup'):Promise<FamilyLookup> {
    return this.run(principal,async tx=>{
      const rows=await tx<{allowed:boolean;block_code:string|null;attempt_id:string;attempt_token:string|null;provider_mode:string|null;expires_at:string|null;retry_seconds:number}[]>`
        select allowed,block_code,attempt_id,attempt_token,provider_mode,
          to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') expires_at,
          greatest(1,ceil(extract(epoch from retry_at-clock_timestamp())))::integer retry_seconds
          from app.begin_family_lookup(${endpoint})`;
      const row=rows[0];
      if(!row)throw new DatabaseUnavailableError();
      if(!row.allowed) {
        if(row.block_code==='quota_exhausted')throw new RequestLimitError(row.retry_seconds??60);
        throw new FamilyRequestError('steam_unavailable','Steam library checks are temporarily unavailable. Please try again shortly.',503);
      }
      // A synthetic transport is never selected by the real app server.
      if(row.provider_mode!=='live'||!row.attempt_token||!row.expires_at)throw new FamilyRequestError('steam_unavailable','Steam library checks are temporarily unavailable.',503);
      return {attemptId:row.attempt_id,attemptToken:row.attempt_token,expiresAt:row.expires_at};
    });
  }

  async add(principal:VerifiedServerPrincipal,snapshot:FamilySnapshot):Promise<{memberId:string;counts:FamilyImportCounts}> {
    if(!snapshot||!/^[1-9][0-9]{16}$/.test(snapshot.steamId)||!Array.isArray(snapshot.games)||snapshot.games.length>10000
      ||!snapshot.displayName?.trim()||Array.from(snapshot.displayName.trim()).length>200
      ||typeof snapshot.observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(snapshot.observedAt))throw new InvalidPageQueryError();
    return this.run(principal,async tx=>{
      const rows=await tx<{member_public_id:string;counts:FamilyImportCounts}[]>`select member_public_id,counts
        from app.add_family_member(${snapshot.steamId}::bigint,${snapshot.displayName.trim()},${snapshot.avatarUrl},
          ${tx.json([...snapshot.games])},${snapshot.observedAt}::text::timestamptz,${snapshot.lookup.attemptId}::uuid,${snapshot.lookup.attemptToken}::uuid)`;
      if(!rows[0])throw new DatabaseUnavailableError();
      return {memberId:rows[0].member_public_id,counts:rows[0].counts};
    });
  }

  async recheck(principal:VerifiedServerPrincipal):Promise<FamilyImportCounts> {
    return this.run(principal,async tx=>{
      const rows=await tx<{counts:FamilyImportCounts}[]>`select app.recheck_family_library() counts`;
      if(!rows[0])throw new DatabaseUnavailableError();return rows[0].counts;
    });
  }

  async remove(principal:VerifiedServerPrincipal,id:string) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new InvalidPageQueryError();
    return this.run(principal,async tx=>{
      const rows=await tx<{removed:number;retained:number;display_name:string}[]>`select removed,retained,display_name from app.remove_family_member(${id}::uuid)`;
      if(!rows[0])throw new DatabaseUnavailableError();
      return {removed:rows[0].removed,retained:rows[0].retained,displayName:rows[0].display_name};
    });
  }

  private async run<T>(principal:VerifiedServerPrincipal,operation:(tx:TenantTransaction)=>Promise<T>):Promise<T> {
    try{return await this.database.withPrincipal(principal,operation);}
    catch(error){
      if(error instanceof InvalidPageQueryError||error instanceof RequestLimitError)throw error;
      const message=error instanceof Error?error.message:'';
      const known:Record<string,[string,string,number]>={family_is_self:['is_self','Add a family member other than your own profile.',409],
        family_already_added:['already_added','That family member has already been added.',409],family_limit_reached:['limit_reached','Your family already has five other members.',409],
        family_not_found:['not_found','That family member is no longer on your account.',404],family_snapshot_invalid:['library_unavailable','Steam did not return a complete valid library.',400],
        family_snapshot_stale:['library_unavailable','That library check expired. Please try again.',409]};
      if(known[message])throw new FamilyRequestError(...known[message]);
      throw new DatabaseUnavailableError();
    }
  }
}
