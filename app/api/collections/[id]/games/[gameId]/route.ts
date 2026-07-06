import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { removeGameFromCollection } from "@/lib/collections";
import { jsonError } from "@/lib/http";

type RouteContext = {
  params: Promise<{ id: string; gameId: string }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const [{ user }, { id, gameId }] = await Promise.all([requireSession(), context.params]);
    await removeGameFromCollection(user.id, id, gameId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
