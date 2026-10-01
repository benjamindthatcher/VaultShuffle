import 'server-only';
import {workerDatabase} from './owned-worker.ts';
import {TagWorkerRepository,runTagWorker,runEndlessSweep} from './import/tag-worker-core.ts';
export async function runV2TagWorker() {
  const startedAt=Date.now(),database=await workerDatabase();
  const steamspy=await runTagWorker(new TagWorkerRepository(database,startedAt+70000),'steamspy',{fetch,deadlineAt:startedAt+70000,maxJobs:60});
  const storeTags=await runTagWorker(new TagWorkerRepository(database,startedAt+180000),'steam_store',{fetch,deadlineAt:startedAt+180000,maxJobs:180});
  const endlessSweep=await runEndlessSweep(new TagWorkerRepository(database,startedAt+205000),startedAt+205000);
  return {steamspy,storeTags,endlessSweep,failed:steamspy.failed+storeTags.failed,rateLimited:steamspy.rateLimited||storeTags.rateLimited};
}
