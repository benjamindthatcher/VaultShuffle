import { refreshPinnedPlaytime } from "@/lib/pinned-playtime-worker";
import { runNightlyWorker } from "@/lib/nightly-worker";

export const maxDuration = 120;

export async function GET(request: Request) {
  return runNightlyWorker(request, "pinned-playtime", refreshPinnedPlaytime);
}
