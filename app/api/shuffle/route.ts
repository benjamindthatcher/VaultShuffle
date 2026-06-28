import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { listGames, recordRecommendation, shuffleGame } from "@/lib/games";

export async function GET(request: Request) {
  try {
    const { user } = await requireSession();
    const url = new URL(request.url);
    const genre = url.searchParams.get("genre") || url.searchParams.get("mood") || "Any genre";
    const time = url.searchParams.get("time") || "Any time";
    const result = shuffleGame(await listGames(user.id), genre, time);

    if (result.game) {
      await recordRecommendation(user.id, result.game, "shuffle", result.reason, genre, time);
    }

    return NextResponse.json(result);
  } catch {
    return unauthorizedResponse();
  }
}
