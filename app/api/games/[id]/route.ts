import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { deleteGame, patchGame, updateGame } from "@/lib/games";
import { jsonError } from "@/lib/http";
import { gamePayloadSchema, patchGameSchema } from "@/lib/validation";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  try {
    const [{ user }, { id }] = await Promise.all([requireSession(), context.params]);
    const payload = gamePayloadSchema.parse(await request.json());
    const game = await updateGame(user.id, id, payload);
    if (!game) return NextResponse.json({ error: "Game not found." }, { status: 404 });
    return NextResponse.json({ ok: true, game });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const [{ user }, { id }] = await Promise.all([requireSession(), context.params]);
    const payload = patchGameSchema.parse(await request.json());
    const game = await patchGame(user.id, id, payload);
    if (!game) return NextResponse.json({ error: "Game not found." }, { status: 404 });
    return NextResponse.json({ ok: true, game });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { id } = await context.params;
    const game = await deleteGame(session.user.id, id);
    if (!game) return NextResponse.json({ error: "Game not found." }, { status: 404 });
    return NextResponse.json({ ok: true, removed: game.title });
  } catch {
    return unauthorizedResponse();
  }
}
