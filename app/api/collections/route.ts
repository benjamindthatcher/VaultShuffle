import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { createCollection, listCollections } from "@/lib/collections";
import { jsonError } from "@/lib/http";
import { collectionPayloadSchema } from "@/lib/validation";

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json({ collections: await listCollections(user.id) });
  } catch {
    return unauthorizedResponse();
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireSession();
    const payload = collectionPayloadSchema.parse(await request.json());
    const collection = await createCollection(user.id, payload);
    return NextResponse.json({ ok: true, collection }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
