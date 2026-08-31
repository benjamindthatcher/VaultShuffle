import { refreshNightlyMetadata } from "@/lib/nightly-metadata";
import { runNightlyWorker } from "@/lib/nightly-worker";

export const maxDuration = 120;

export async function GET(request: Request) {
  return runNightlyWorker(request, "nightly-metadata", refreshNightlyMetadata);
}
