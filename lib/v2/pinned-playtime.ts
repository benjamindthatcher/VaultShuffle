import {fetchSteamResponse,SteamApiError} from '../steam-api-error.ts';
import {steamPlaytimeFromPayload,SteamLibraryUnavailableError} from '../steam-owned-games.ts';
import type {VerifiedServerPrincipal} from './db/client.ts';
import {RequestLimitError} from './db/errors.ts';
import {PinnedRefreshError,type PinnedRepository,type PinnedRefreshResult,type PinnedAttempt} from './repositories/pinned-core.ts';

export async function refreshV2PinnedPlaytime(repository:Pick<PinnedRepository,'reserve'|'publish'>,principal:VerifiedServerPrincipal,
  options:{apiKey:string;secret:string;fetch:typeof fetch}):Promise<PinnedRefreshResult> {
  if(!options.apiKey.trim())throw new PinnedRefreshError('Steam playtime checks are temporarily unavailable.',503);
  const {total,attempts}=await repository.reserve(principal,options.secret);
  if(!total)return {games:[],refreshed:0,skipped:0,refreshedAt:new Date().toISOString(),retryAfterSeconds:0};
  try {
    // At most three independent, charged, AppID-filtered requests in parallel.
    // Collect all responses before opening the atomic publication transaction.
    const observations=await fetchV2PinnedObservations(attempts,options);
    const readable=observations.filter(observation=>observation!==null);
    if(!readable.length)throw new PinnedRefreshError('Steam did not share readable playtime for these pins. Check that Game details and playtime are public, then try again. Your saved playtime has not changed.');
    const games=await repository.publish(principal,readable);
    return {games,refreshed:games.length,skipped:total-games.length,refreshedAt:new Date().toISOString(),retryAfterSeconds:60};
  }catch(error){
    if(error instanceof SteamApiError){
      if(error.code==='steam_rate_limited')throw new RequestLimitError(Math.max(60,error.retryAfterSeconds??60));
      throw new PinnedRefreshError(error.message,502);
    }
    throw error;
  }
}

/** Shared strict, AppID-filtered transport for manual and scheduled pin checks. */
export async function fetchV2PinnedObservations(attempts:readonly PinnedAttempt[],options:{apiKey:string;fetch:typeof fetch}) {
  return Promise.all(attempts.map(async attempt=>{
      const query=new URLSearchParams({key:options.apiKey,format:'json',input_json:JSON.stringify({steamid:attempt.steamId,
        include_appinfo:false,include_played_free_games:true,appids_filter:[Number(attempt.appId)]})});
      const response=await fetchSteamResponse('owned_games',`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?${query}`,{redirect:'error'},options.fetch);
      if(response.status!==200)throw new SteamApiError('owned_games','steam_invalid_response');
      const reader=response.body?.getReader();
      if(!reader)throw new SteamApiError('owned_games','steam_invalid_response');
      let text='',bytes=0;const decoder=new TextDecoder();
      try {
        while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
          if(bytes>32768){await reader.cancel();throw new SteamApiError('owned_games','steam_invalid_response');}
          text+=decoder.decode(chunk.value,{stream:true});}
      } catch(error) {
        if(error instanceof SteamApiError)throw error;
        throw new SteamApiError('owned_games','steam_invalid_response');
      } finally {reader.releaseLock();}
      let body:unknown;
      try{body=JSON.parse(text+decoder.decode());}catch{throw new SteamApiError('owned_games','steam_invalid_response');}
      try {
        const match=steamPlaytimeFromPayload(body).find(game=>game.steam_appid===attempt.appId);
        return match?{attempt,minutes:match.minutes,lastPlayedAt:match.last_played_at}:null;
      }catch(error){if(error instanceof SteamLibraryUnavailableError)return null;throw error;}
    }));
}
