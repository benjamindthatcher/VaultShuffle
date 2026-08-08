import { NextResponse } from "next/server";
import { refreshNightlyMetadata } from "@/lib/nightly-metadata";
import { withMetadataWorkerRun } from "@/lib/worker-runs";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await withMetadataWorkerRun("nightly-metadata", refreshNightlyMetadata));
  } catch (error) {
    console.error("Nightly metadata refresh failed.", error);
    return NextResponse.json({ error: "Nightly metadata refresh failed." }, { status: 500 });
  }
}
