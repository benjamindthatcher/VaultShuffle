import {after} from 'next/server';
import {v2Read,v2Write,v2JsonBody} from '@/lib/v2/http/request';
import {InvalidPageQueryError} from '@/lib/v2/repositories/page-errors';
import {runV2OwnedWorker} from '@/lib/v2/owned-worker';
export const runtime='nodejs';
export const maxDuration=60;
export function GET(){return v2Read((services,principal)=>services.imports.status(principal));}
export function POST(request:Request) {
  return v2Write(request,async(services,principal)=>{
    const body=await v2JsonBody(request);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!('request_key' in body)||typeof body.request_key!=='string')throw new InvalidPageQueryError();
    const result=await services.imports.request(principal,body.request_key,process.env.RATE_LIMIT_SECRET||process.env.SESSION_SECRET||'');
    if(result.progress.status==='importing'||result.progress.status==='fetching')after(async()=>{
      try{await runV2OwnedWorker();}catch{console.error('V2 owned import worker unavailable; queued work remains saved.');}
    });
    return result;
  });
}
