import {createHmac} from 'node:crypto';
import type {DatabaseClient,VerifiedServerPrincipal,TenantTransaction} from '../db/client.ts';
import {DatabaseUnavailableError,RequestLimitError} from '../db/errors.ts';
import {InvalidPageQueryError} from './page-errors.ts';
import {readLibraryCards,type LibraryCard} from './library-core.ts';
import type {SteamCapabilities} from '../../steam-capabilities.ts';

export class PinnedRefreshError extends InvalidPageQueryError {
  readonly code='library_unavailable';
  readonly status:number;
  constructor(message:string,status=422){super(message);this.status=status;}
}
export type PinnedAttempt={gameId:number;appId:string;steamId:string;attemptId:string;attemptToken:string};
export type PinnedObservation={attempt:PinnedAttempt;minutes:number;lastPlayedAt:string|null};
export type PinnedRefreshResult={capabilities?:SteamCapabilities;games:LibraryCard[];refreshed:number;skipped:number;refreshedAt:string;retryAfterSeconds:number};

export class PinnedRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient){this.database=database;}

  async reserve(principal:VerifiedServerPrincipal,secret:string) {
    if(!secret)throw new DatabaseUnavailableError();
    return this.run(principal,async tx=>{
      const pins=await tx<{game_id:number;steam_app_id:string|null;eligible:boolean}[]>`select * from app.pinned_playtime_targets()`;
      if(!pins.length)return {total:0,attempts:[] as PinnedAttempt[]};
      const selected=pins.filter(pin=>pin.eligible);
      if(!selected.length)throw new PinnedRefreshError('There are no owned Steam games in these pins to refresh.',409);
      const profiles=await tx<{steam_id:string}[]>`select steam_id::text from app.steam_profiles where account_id=${principal.accountId}`;
      const steamId=profiles[0]?.steam_id;
      if(!steamId||!/^\d{17}$/.test(steamId))throw new PinnedRefreshError('Your Steam profile could not be checked. Please reload and try again.',409);
      const digest=(scope:string,identity:string)=>createHmac('sha256',secret).update(`${scope}\u001f${identity}`).digest();
      const gates=await tx<{allowed:boolean;retry_after_seconds:number}[]>`select * from app.begin_pinned_playtime_window(
        ${digest('pinned_playtime_account',principal.accountPublicId)},${digest('pinned_playtime_steam',steamId)})`;
      if(!gates[0])throw new DatabaseUnavailableError();
      if(!gates[0].allowed)throw new RequestLimitError(Math.max(1,gates[0].retry_after_seconds));
      const attempts:PinnedAttempt[]=[];
      for(const pin of selected) {
        const rows=await tx<{allowed:boolean;block_code:string|null;provider_mode:string;attempt_id:string;attempt_token:string|null;provider_subject:string;retry_seconds:number}[]>`
          select allowed,block_code,provider_mode,attempt_id,attempt_token,provider_subject::text,
            greatest(1,ceil(extract(epoch from retry_at-clock_timestamp())))::integer retry_seconds
          from app.begin_pinned_owned_refresh(${pin.game_id})`;
        const row=rows[0];
        if(row?.block_code==='quota_exhausted')throw new RequestLimitError(row.retry_seconds??60);
        if(!row?.allowed||row.provider_mode!=='live'||!row.attempt_token||row.provider_subject!==steamId)
          throw new PinnedRefreshError('Steam playtime checks are temporarily unavailable. Please try again shortly.',503);
        // One charged attempt authorizes one filtered request, never a full import.
        attempts.push({gameId:pin.game_id,appId:pin.steam_app_id!,steamId,attemptId:row.attempt_id,attemptToken:row.attempt_token});
      }
      return {total:pins.length,attempts};
    });
  }

  async publish(principal:VerifiedServerPrincipal,observations:readonly PinnedObservation[]):Promise<LibraryCard[]> {
    if(observations.length>3)throw new InvalidPageQueryError();
    return this.run(principal,async tx=>{
      const accepted:number[]=[];
      for(const {attempt,minutes,lastPlayedAt} of observations) {
        const result=await tx<{accepted:boolean;game_id:number}[]>`select accepted,game_id from app.record_pinned_owned_observation(
          ${attempt.attemptId}::uuid,${attempt.attemptToken}::uuid,${tx.json({status:'complete',provider:'steam',appId:attempt.appId,
            playtimeMinutes:minutes,lastPlayedAtEpochSeconds:lastPlayedAt?Math.floor(Date.parse(lastPlayedAt)/1000):null,
            lastPlayedSource:lastPlayedAt?'steam.rtime_last_played':'not_provided'})})`;
        if(result[0]?.accepted)accepted.push(result[0].game_id);
      }
      return readLibraryCards(tx,principal.accountId,accepted);
    });
  }

  private async run<T>(principal:VerifiedServerPrincipal,operation:(tx:TenantTransaction)=>Promise<T>):Promise<T> {
    try{return await this.database.withPrincipal(principal,operation);}
    catch(error){if(error instanceof InvalidPageQueryError||error instanceof RequestLimitError)throw error;throw new DatabaseUnavailableError(error);}
  }
}
