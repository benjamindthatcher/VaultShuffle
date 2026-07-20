import { NextResponse } from "next/server";
import { processDurationQueue } from "@/lib/duration-worker";

async function processQueue(request: Request) {
  const authorization = request.headers.get("authorization");
  const acceptedTokens = [process.env.CATALOGUE_INGEST_SECRET, process.env.CRON_SECRET]
    .filter((secret): secret is string => Boolean(secret))
    .map((secret) => `Bearer ${secret}`);
  if (!authorization || !acceptedTokens.includes(authorization)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await processDurationQueue(8));
}

export const GET = processQueue;
export const POST = processQueue;
