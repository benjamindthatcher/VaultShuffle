import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { createGame, listGames } from "@/lib/games";
import { jsonError, readJsonBody } from "@/lib/http";
import { gamePayloadSchema } from "@/lib/validation";

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json({ games: await listGames(user.id) });
  } catch {
    return unauthorizedResponse();
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireSession();
    const payload = gamePayloadSchema.parse(await readJsonBody(request));
    const game = await createGame(user.id, payload);
    return NextResponse.json({ ok: true, game }, { status: 201 });
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes("sign-in") ? 401 : 500);
  }
}
