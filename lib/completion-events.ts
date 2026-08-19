import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";

export type CompletionSource = "sweep" | "sweep_bulk" | "library" | "vault" | "purge" | "details";

export type CompletionClaim = {
  gameId: string;
  source: CompletionSource;
  hoursPlayed?: number | null;
  estimateMinutes?: number | null;
  priceCents?: number | null;
};

/**
 * Records a completion claim in the durable ledger.
 *
 * Best effort on purpose: the game is already marked complete by the time this
 * runs, and losing an analytics row is a far better outcome than failing the
 * action the player actually took.
 */
export async function recordCompletionClaim(userId: string, claim: CompletionClaim) {
  try {
    const supabase = getSupabaseAdmin();
    const { data: game } = await supabase
      .from("user_games")
      .select("catalog_steam_appid")
      .eq("id", claim.gameId)
      .eq("user_id", userId)
      .maybeSingle();

    const { error } = await supabase.from("completion_events").insert({
      user_id: userId,
      game_id: claim.gameId,
      steam_appid: game?.catalog_steam_appid ?? null,
      source: claim.source,
      hours_played: claim.hoursPlayed ?? null,
      estimate_minutes: claim.estimateMinutes ?? null,
      price_cents: claim.priceCents ?? null
    });
    if (error) throw error;
  } catch (error) {
    console.error("Could not record completion claim.", error);
  }
}

/**
 * Marks the most recent standing claim for a game as undone.
 *
 * The row stays: a reversal is part of the record. Without it the ledger would
 * quietly overstate how well the completion flows convert.
 */
export async function recordCompletionUndone(userId: string, gameId: string) {
  try {
    const supabase = getSupabaseAdmin();
    const { data: latest } = await supabase
      .from("completion_events")
      .select("id")
      .eq("user_id", userId)
      .eq("game_id", gameId)
      .is("undone_at", null)
      .order("claimed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest?.id) return;

    const { error } = await supabase
      .from("completion_events")
      .update({ undone_at: new Date().toISOString() })
      .eq("id", latest.id);
    if (error) throw error;
  } catch (error) {
    console.error("Could not record completion undo.", error);
  }
}
