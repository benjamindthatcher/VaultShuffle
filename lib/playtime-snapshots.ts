import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import type { GamePayload } from "@/lib/types";
import { summarisePlaytime, type PlaytimeSnapshot, type PlaytimeSummary } from "@/lib/playtime-summary";

/**
 * Writes down today's playtime totals so tomorrow can be compared to them.
 *
 * Steam only exposes a running total per game, never a history, so "did they play
 * yesterday" is unanswerable unless yesterday's total was recorded at the time.
 * That makes this the one thing here that cannot be backfilled later.
 *
 * Idempotent by day: running the worker twice simply overwrites the same row.
 */
export async function capturePlaytimeSnapshot(userId: string, games: GamePayload[]) {
  try {
    let totalMinutes = 0;
    let gamesWithPlaytime = 0;
    for (const game of games) {
      const minutes = Math.max(0, Math.round(Number(game.hours_played ?? 0) * 60));
      totalMinutes += minutes;
      if (minutes > 0) gamesWithPlaytime += 1;
    }

    const { error } = await getSupabaseAdmin()
      .from("user_playtime_snapshots")
      .upsert({
        user_id: userId,
        captured_on: new Date().toISOString().slice(0, 10),
        total_minutes: totalMinutes,
        games_with_playtime: gamesWithPlaytime
      }, { onConflict: "user_id,captured_on" });
    if (error) throw error;
  } catch (error) {
    // Never allowed to fail a library refresh: a missing day is a gap in a chart,
    // a thrown error is a library that stopped updating.
    console.error("Could not capture playtime snapshot.", error);
  }
}

export type { PlaytimeSnapshot, PlaytimeSummary } from "@/lib/playtime-summary";

export async function getPlaytimeSummary(userId: string): Promise<PlaytimeSummary> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("user_playtime_snapshots")
      .select("captured_on, total_minutes")
      .eq("user_id", userId)
      .order("captured_on", { ascending: false })
      .limit(60);
    if (error) throw error;

    const snapshots: PlaytimeSnapshot[] = (data ?? []).map((row) => ({
      capturedOn: String(row.captured_on),
      totalMinutes: Number(row.total_minutes) || 0
    }));
    return summarisePlaytime(snapshots);
  } catch (error) {
    console.error("Could not load playtime summary.", error);
    return { streakDays: 0, minutesLast7Days: 0, minutesLast30Days: 0, daysTracked: 0, dailyGains: [] };
  }
}

