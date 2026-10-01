import {v2Write,v2JsonBody} from '@/lib/v2/http/request';
import {InvalidPageQueryError} from '@/lib/v2/repositories/page-errors';
import {refreshV2PinnedPlaytime} from '@/lib/v2/pinned-playtime';
export const runtime='nodejs';
export const maxDuration=30;
export function POST(request:Request) {
  return v2Write(request,async(services,principal)=>{
    const body=await v2JsonBody(request);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new InvalidPageQueryError();
    const result=await refreshV2PinnedPlaytime(services.pinned,principal,{apiKey:process.env.STEAM_WEB_API_KEY?.trim()??'',
      secret:process.env.RATE_LIMIT_SECRET||process.env.SESSION_SECRET||'',fetch});
    return result.refreshed>0?{...result,capabilities:(await services.bootstrap.read(principal)).capabilities}:result;
  });
}
