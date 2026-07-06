import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { deleteCollection, getCollectionWithGames, updateCollection } from "@/lib/collections";
import { jsonError } from "@/lib/http";
import { collectionPayloadSchema } from "@/lib/validation";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ user }, { id }] = await Promise.all([requireSession(), context.params]);
    return NextResponse.json(await getCollectionWithGames(user.id, id));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes("not found") ? 404 : 500);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const [{ user }, { id }] = await Promise.all([requireSession(), context.params]);
    const payload = collectionPayloadSchema.partial().parse(await request.json());
    const collection = await updateCollection(user.id, id, payload);
    if (!collection) return NextResponse.json({ error: "Collection not found." }, { status: 404 });
    return NextResponse.json({ ok: true, collection });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const [{ user }, { id }] = await Promise.all([requireSession(), context.params]);
    await deleteCollection(user.id, id);
    return NextResponse.json({ ok: true });
  } catch {
    return unauthorizedResponse();
  }
}
