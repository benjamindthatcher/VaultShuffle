import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
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
    const { user } = await requireSession();
    const input = reviewSchema.parse(await readJsonBody(request));
    const supabase = getSupabaseAdmin();
    const { data: ownedGame, error: gameError } = await supabase
      .from("games")
      .select("id, hours_played, completion_percentage, last_played_at")
      .eq("id", input.game_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (gameError) throw gameError;
    if (!ownedGame) return NextResponse.json({ error: "Game not found." }, { status: 404 });

    const { data, error } = await supabase
      .from("purge_reviews")
      .insert({
        user_id: user.id,
        game_id: input.game_id,
        action: input.action,
        category: input.category,
        playtime_minutes_at_review: Math.max(0, Math.round(Number(ownedGame.hours_played || 0) * 60)),
        progress_at_review: ownedGame.completion_percentage,
        last_played_at_review: ownedGame.last_played_at
      })
      .select("*")
      .single();

    if (error) throw error;
    return NextResponse.json({ review: mapReview(data) }, { status: 201 });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requireSession();
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
    const { error } = await getSupabaseAdmin()
      .from("purge_reviews")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

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
