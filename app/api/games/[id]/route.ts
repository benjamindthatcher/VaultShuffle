import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { deleteGame, patchGame, restoreGameToActive, updateGame } from "@/lib/games";
import { jsonError, readJsonBody } from "@/lib/http";
import { gamePayloadSchema, patchGameSchema } from "@/lib/validation";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  try {
    const [{ user }, { id }] = await Promise.all([requireSession(), context.params]);
    const payload = gamePayloadSchema.parse(await readJsonBody(request));
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
    const payload = patchGameSchema.parse(await readJsonBody(request));
    const { restore_active: restoreActive, ...patch } = payload;
    const game = restoreActive
      ? await restoreGameToActive(user.id, id)
      : await patchGame(user.id, id, patch);
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
