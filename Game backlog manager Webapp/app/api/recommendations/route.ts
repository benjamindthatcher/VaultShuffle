import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { listGames, recommendationsPayload } from "@/lib/games";

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json(recommendationsPayload(await listGames(user.id)));
  } catch {
    return unauthorizedResponse();
  }
}
