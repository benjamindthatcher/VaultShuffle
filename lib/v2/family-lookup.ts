import {parseSteamProfileInput,isSteamId,SteamProfileInputError} from "../steam-profile-input.ts";
import {fetchSteamResponse,readSteamJson,SteamApiError} from "../steam-api-error.ts";
import {describeFamilyImport} from "../family-sharing.ts";
import {fetchSteamOwnedSnapshot,type SteamOwnedGamesFetch} from "./import/steam-owned-fetch.ts";
import type {VerifiedServerPrincipal} from "./db/client.ts";
import {FamilyRequestError,type FamilyRepository} from "./repositories/family-core.ts";

type Options={apiKey:string;fetch:SteamOwnedGamesFetch;nowEpochSeconds:()=>number;
  profile:(steamId:string,key:string)=>Promise<{display_name:string|null;avatar_url:string|null;community_visibility_state?:number|null}|null>};

/** Only a complete, validated full response can reach the atomic publish. */
export async function addV2FamilyMember(repository:Pick<FamilyRepository,'checkAdd'|'reserveLookup'|'add'|'list'>,principal:VerifiedServerPrincipal,input:string,options:Options) {
  try {
    const reference=parseSteamProfileInput(input);
    if(!options.apiKey.trim())throw new FamilyRequestError('steam_unavailable','Steam library checks are temporarily unavailable.',503);
    await repository.checkAdd(principal,reference.kind==='steam_id'?reference.steamId:undefined);
    let steamId:string;
    if(reference.kind==='steam_id')steamId=reference.steamId;
    else {
      await repository.reserveLookup(principal,'vanity');
      const query=new URLSearchParams({key:options.apiKey,vanityurl:reference.vanity,url_type:'1',format:'json'});
      const response=await fetchSteamResponse('resolve_vanity',`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?${query}`,{},options.fetch);
      const body=await readSteamJson(response,'resolve_vanity') as {response?:{success?:number;steamid?:string}};
      steamId=body.response?.steamid??'';
      if(body.response?.success!==1||!isSteamId(steamId))throw new FamilyRequestError('profile_not_found','We could not find that Steam profile.');
      await repository.checkAdd(principal,steamId);
    }
    await repository.reserveLookup(principal,'profile');
    const lookup=await repository.reserveLookup(principal,'public_owned_lookup');
    const [profileResult,snapshotResult]=await Promise.allSettled([
      options.profile(steamId,options.apiKey),
      fetchSteamOwnedSnapshot(steamId,options.apiKey,{fetch:options.fetch,nowEpochSeconds:options.nowEpochSeconds})
    ]);
    if(profileResult.status==='rejected')throw profileResult.reason;
    if(!profileResult.value)throw new FamilyRequestError('profile_not_found','We could not find that Steam profile.');
    if(snapshotResult.status==='rejected')throw new FamilyRequestError('steam_unavailable','Steam could not share that library just now.',502);
    const snapshot=snapshotResult.value,profile=profileResult.value;
    if(snapshot.status!=='complete') {
      if(snapshot.status==='unavailable'&&snapshot.reason==='private')throw new FamilyRequestError('library_private',"That profile's Game details are private. They need to make them Public in Steam.");
      throw new FamilyRequestError('library_unavailable','Steam did not return a complete library. No family games were changed.',502);
    }
    const added=await repository.add(principal,{steamId,displayName:profile.display_name?.trim()||'Steam player',avatarUrl:profile.avatar_url,
      games:snapshot.games.map(game=>({appId:game.appId,title:game.name})),
      observedAt:new Date(snapshot.provenance.observationTimeEpochSeconds*1000).toISOString(),lookup});
    const member=(await repository.list(principal)).find(entry=>entry.id===added.memberId);
    if(!member)throw new FamilyRequestError('not_found','That family member could not be loaded. Refresh your family roster.',404);
    return {ok:true,member,counts:added.counts,truncated:0,summary:describeFamilyImport(added.counts,member.displayName)};
  } catch(error) {
    if(error instanceof SteamProfileInputError)throw new FamilyRequestError(error.code,error.message);
    if(error instanceof SteamApiError)throw new FamilyRequestError(error.code,error.message,502);
    throw error;
  }
}
