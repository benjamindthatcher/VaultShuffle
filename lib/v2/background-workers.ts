import 'server-only';
import {workerDatabase,runV2OwnedWorker} from './owned-worker.ts';
import {BackgroundWorkerRepository,runScheduledPins} from './import/background-worker-core.ts';

export async function runV2ScheduledPins() {
  const deadlineAt=Date.now()+100000;
  return runScheduledPins(new BackgroundWorkerRepository(await workerDatabase(),deadlineAt),{
    fetch,apiKey:process.env.STEAM_WEB_API_KEY?.trim()??'',deadlineAt});
}
export async function runV2NightlyOwnedRefresh() {
  const deadlineAt=Date.now()+100000;
  const repository=new BackgroundWorkerRepository(await workerDatabase(),deadlineAt);
  // Bounded backpressure: enqueue only one small cohort per daily sweep.
  const queued=await repository.scheduleOwned(20);
  const totals={queued,claimed:0,published:0,retryScheduled:0,stale:0,failed:0};
  const interactive=await runV2OwnedWorker('interactive',3,deadlineAt);
  if(!('skipped' in interactive))for(const key of ['claimed','published','retryScheduled','stale','failed'] as const)totals[key]+=interactive[key];
  while(Date.now()+17000<deadlineAt&&totals.claimed<150) {
    const batch=await runV2OwnedWorker('background',3,deadlineAt);if('skipped' in batch)break;
    for(const key of ['claimed','published','retryScheduled','stale','failed'] as const)totals[key]+=batch[key];
    if(!batch.claimed||batch.failed||batch.retryScheduled)break;
  }
  return totals;
}
