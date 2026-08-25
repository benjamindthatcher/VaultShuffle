import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteSession } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";

const flagPayloadSchema = z.object({
  game_ids: z.array(z.string().uuid()).min(1).max(500)
}).strict();

/**
 * Put games back into the Purge queue by hand.
 *
 * The queue is otherwise built from evidence, which leaves no way to say "I want
 * to decide about this one" from the reviewed or unflagged lists.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireWriteSession();
    const input = flagPayloadSchema.parse(await readJsonBody(request));

    const { data, error } = await getSupabaseAdmin().rpc("request_user_game_review", {
      p_user_id: user.id,
      p_game_ids: input.game_ids
    });
    if (error) throw error;

    return NextResponse.json({ flagged: Number(data ?? 0) });
  } catch (error) {
    return jsonError(error, 500);
  }
}
