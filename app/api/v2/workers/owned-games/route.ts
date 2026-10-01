import {isV2Authority} from '@/lib/database-authority';
import {runV2OwnedWorker} from '@/lib/v2/owned-worker';
export const runtime='nodejs';
export const maxDuration=120;
export async function GET(request:Request) {
  const headers={'Cache-Control':'private, no-store'};
  if(!process.env.CRON_SECRET||request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`)
    return Response.json({error:'Unauthorized'},{status:401,headers});
  if(!isV2Authority()||process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production')
    return Response.json({skipped:true,reason:'inactive_authority_or_preview'},{headers});
  try {
    const interactive=await runV2OwnedWorker('interactive',3),background=await runV2OwnedWorker('background',3);
    return Response.json({interactive,background},{headers});
  }catch{return Response.json({error:'Worker unavailable; queued jobs remain saved.'},{status:503,headers});}
}
