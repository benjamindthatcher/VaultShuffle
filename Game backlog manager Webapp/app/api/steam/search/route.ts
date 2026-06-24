import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { searchSteamStore } from "@/lib/steam";

export async function GET(request: Request) {
  try {
    await requireSession();
    const query = new URL(request.url).searchParams.get("q") || "";
    return NextResponse.json({ results: await searchSteamStore(query) });
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) return unauthorizedResponse();
    return jsonError(error, 502);
  }
}
