import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, requireWriteSession } from "@/lib/auth";
import { HttpError, jsonError, readJsonBody } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";
import { recordCompletionClaim } from "@/lib/completion-events";
import { purgeReviewPayloadSchema } from "@/lib/validation";

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
    const input = purgeReviewPayloadSchema.parse(await readJsonBody(request));
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .rpc("apply_user_purge_decision", {
        p_user_id: user.id,
        p_game_id: input.game_id,
        p_action: input.action
      });

    if (error?.message === "GAME_NOT_REVIEWABLE") {
      throw new HttpError("This game has already changed. Refresh the Purge queue and try again.", 409);
    }
    if (error) throw error;

    // The completion ledger row goes in with the decision. Sending it from the
    // browser afterwards would be a second write per decision, and people work
    // this queue at a median of one second apart - two writes a second is the
    // whole hundred-and-twenty-a-minute budget.
    if (input.action === "complete") {
      await recordCompletionClaim(user.id, {
        gameId: input.game_id,
        source: "purge",
        hoursPlayed: null,
        estimateMinutes: null,
        priceCents: null
      }).catch(() => undefined);
    }

    // A decision answers the question the flag was asking, so the flag goes with
    // it. Left set, a game would rejoin the queue the moment a Keep expired.
    await supabase
      .from("user_games")
      .update({ review_requested_at: null })
      .eq("user_id", user.id)
      .eq("id", input.game_id);

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
    reviewedAt: String(review.reviewed_at)
  };
}
