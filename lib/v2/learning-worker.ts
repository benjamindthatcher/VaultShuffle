import 'server-only';
import {workerDatabase} from './owned-worker.ts';
import {rebuildV2Learning} from './import/learning-worker-core.ts';
export async function runV2LearningWorker() {
  return rebuildV2Learning(await workerDatabase(),Date.now()+240000);
}
