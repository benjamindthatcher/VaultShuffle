import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { addGameToCollection } from "@/lib/collections";
import { jsonError, readJsonBody } from "@/lib/http";
import { collectionGamePayloadSchema } from "@/lib/validation";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ user }, { id }] = await Promise.all([requireSession(), context.params]);
    const payload = collectionGamePayloadSchema.parse(await readJsonBody(request));
    const item = await addGameToCollection(user.id, id, payload);
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
