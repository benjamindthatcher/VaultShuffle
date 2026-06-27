import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { enrichSteamMetadataForUser } from "@/lib/steam-metadata";

export async function POST(request: Request) {
  try {
    const { user } = await requireSession();
    const body = await request.json().catch(() => ({}));
    const limit = Number(body?.limit ?? 12);
    const result = await enrichSteamMetadataForUser(user.id, limit);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) return unauthorizedResponse();
    return jsonError(error, 502);
  }
}
