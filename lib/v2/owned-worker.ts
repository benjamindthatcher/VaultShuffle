import 'server-only';
import {createDatabaseClient,type DatabaseClient} from './db/client.ts';
import {parseDatabaseConfig} from './db/config.ts';
import {verifyWorkerDatabase} from './db/worker-check.ts';
import {DatabaseUnavailableError} from './db/errors.ts';
import {createOwnedWorkerInvoker,runOwnedWorkerBatch} from './import/owned-worker-core.ts';

let worker:Promise<DatabaseClient>|undefined;
export async function workerDatabase() {
  worker??=(async()=>{
    let database:DatabaseClient|undefined;
    try {
      database=createDatabaseClient(parseDatabaseConfig({connectionString:process.env.V2_WORKER_DATABASE_URL,maxConnections:1,tlsCaPem:process.env.V2_DATABASE_CA_PEM}));
      await verifyWorkerDatabase(database,process.env.V2_PROJECT_REF??'');return database;
    }catch{await database?.close().catch(()=>{});worker=undefined;throw new DatabaseUnavailableError();}
  })();
  return worker;
}
export async function runV2OwnedWorker(lane:'interactive'|'background'='interactive',maxJobs=1,overallDeadlineAt=Date.now()+45000) {
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production')return {skipped:true,reason:'production_only'};
  const database=await workerDatabase();
  const deadlineAt=Math.min(Date.now()+45000,overallDeadlineAt);
  return runOwnedWorkerBatch({sql:createOwnedWorkerInvoker(database,{deadlineAt}),apiKey:process.env.STEAM_WEB_API_KEY?.trim()??'',
    fetch,nowEpochSeconds:()=>Math.floor(Date.now()/1000),lane,maxJobs,signal:AbortSignal.timeout(Math.max(1,deadlineAt-Date.now()))});
}
