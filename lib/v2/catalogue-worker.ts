import 'server-only';
import {BackgroundWorkerRepository} from './import/background-worker-core.ts';
import {workerDatabase} from './owned-worker.ts';
import {CatalogueWorkerRepository,runCatalogueWorker} from './import/catalogue-worker-core.ts';
export async function runV2CatalogueWorker() {
  const deadlineAt=Date.now()+100000;
  const database=await workerDatabase();
  const totals=await runCatalogueWorker(new CatalogueWorkerRepository(database,deadlineAt),{fetch,deadlineAt,maxJobs:100});
  let familyAccountsRefreshed=0;
  if(Date.now()+10000<deadlineAt)try{familyAccountsRefreshed=await new BackgroundWorkerRepository(database,deadlineAt).refreshFamily();}catch{totals.failed++;}
  return {...totals,familyAccountsRefreshed};
}
