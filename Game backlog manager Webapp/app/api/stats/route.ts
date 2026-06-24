import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { listGames, statsPayload } from "@/lib/games";

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json(statsPayload(await listGames(user.id)));
  } catch {
    return unauthorizedResponse();
  }
}
