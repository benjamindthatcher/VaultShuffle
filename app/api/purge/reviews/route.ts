import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, requireWriteSession } from "@/lib/auth";
import { HttpError, jsonError, readJsonBody } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";

const reviewSchema = z.object({
  game_id: z.string().uuid(),
  action: z.enum(["keep", "pin", "sleep", "complete"]),
  category: z.enum(["untouched", "barely-started", "dormant"])
});

export async function GET() {
  try {
    const { user } = await requireSession();
    const { data, error } = await getSupabaseAdmin()
      .from("purge_reviews")
      .select("*")
      .eq("user_id", user.id)
      .order("reviewed_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ reviews: (data ?? []).map(mapReview) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireWriteSession();
    const input = reviewSchema.parse(await readJsonBody(request));
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .rpc("apply_user_purge_decision", {
        p_user_id: user.id,
        p_game_id: input.game_id,
        p_action: input.action,
        p_category: input.category
      });

    if (error?.message === "GAME_NOT_REVIEWABLE") {
      throw new HttpError("This game has already changed. Refresh the Purge queue and try again.", 409);
    }
    if (error) throw error;
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requireWriteSession();
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
    const { error } = await getSupabaseAdmin()
      .rpc("undo_user_purge_decision", {
        p_user_id: user.id,
        p_review_id: id
      });

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, 500);
  }
}

function mapReview(review: Record<string, unknown>) {
  return {
    id: String(review.id),
    gameId: String(review.game_id),
    action: String(review.action),
    category: String(review.category),
    reviewedAt: String(review.reviewed_at)
  };
}
