import { NextResponse } from "next/server";
import { rebuildGenrePreferences } from "@/lib/genre-preference-worker";
import { recountImportMetrics } from "@/lib/import-metrics";
import { withMetadataWorkerRun } from "@/lib/worker-runs";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Owner counts are recounted here rather than inside each import batch, where
    // they cost more than the import itself. It takes its own run record instead
    // of joining the summary below: seconds of work should not be buried in a
    // two-minute rebuild, and a bad night needs to name which of the two failed.
    //
    // A failed recount must not cost the rebuild. The counter orders two admin
    // screens, withMetadataWorkerRun has already recorded the failure against its
    // own run, and tomorrow recounts everything again from scratch anyway.
    const importMetrics = await withMetadataWorkerRun("import-metrics", () => recountImportMetrics())
      .catch((error) => {
        console.error("Import metric recount failed.", error);
        return null;
      });

    // Unlike the metadata workers this has no external API to pace against and no
    // queue to drain, so it runs as a single full rebuild rather than in batches.
    const result = await withMetadataWorkerRun("genre-preferences", () => rebuildGenrePreferences());
    return NextResponse.json({ ...result, importMetrics });
  } catch (error) {
    console.error("Genre preference rebuild failed.", error);
    return NextResponse.json({ error: "Genre preference rebuild failed." }, { status: 500 });
  }
}
