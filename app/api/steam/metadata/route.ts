import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { enrichSteamMetadataForUser } from "@/lib/steam-metadata";

export async function POST(request: Request) {
  try {
    const { user } = await requireSession();
    const body = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(12),
      force: z.boolean().default(false),
      wishlist_only: z.boolean().default(false)
    }).strict().parse(await readJsonBody(request));
    const { limit, force, wishlist_only: wishlistOnly } = body;
    const result = await enrichSteamMetadataForUser(user.id, limit, force, wishlistOnly);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) return unauthorizedResponse();
    return jsonError(error, 502);
  }
}
