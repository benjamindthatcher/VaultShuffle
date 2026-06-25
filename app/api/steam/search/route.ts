import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { searchSteamStore } from "@/lib/steam";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q") || "";
    return NextResponse.json({ results: await searchSteamStore(query) });
  } catch (error) {
    return jsonError(error, 502);
  }
}
