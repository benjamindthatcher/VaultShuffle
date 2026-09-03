import "server-only";

import { endlessVerdict, type EndlessWitness } from "@/lib/game-classification";
import type { getSupabaseAdmin } from "@/lib/supabase";

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

/**
 * Re-ask the endless question when a game's tags arrive.
 *
 * The catalogue used to answer it once, badly: a HowLongToBeat match wrote
 * `duration_kind = 'finite'` and nothing ever looked at the tags, so of the owned
 * catalogue every one of the 16,292 HLTB matches came out finite - Rainbow Six
 * Siege among them, on a recorded 3h19 "story". The 2,414-game backfill fixed the
 * rows that existed. This is what stops the drift starting again.
 *
 * Tags are the right trigger. They are the last piece of metadata to land for a
 * new game and the only one the verdict really turns on, and SteamSpy refreshes
 * them every thirty days, so a game whose community re-tags it gets re-judged
 * without a sweep.
 *
 * Only ever promotes. A game already marked endless is left alone, a manual
 * ruling is never overturned, and nothing here can move a game back to finite -
 * demotion is a decision for a person, through duration_manual_override.
 */
export async function promoteIfEndless(
  supabase: AdminClient,
  steamAppId: number,
  tags: Record<string, number> | null | undefined
): Promise<{ promoted: boolean; witnesses: EndlessWitness[] }> {
  const quiet = { promoted: false, witnesses: [] as EndlessWitness[] };
  if (!tags || !Object.keys(tags).length) return quiet;

  const { data, error } = await supabase
    .from("catalog_games")
    .select("genres, categories, main_story_minutes, completionist_minutes, duration_kind, duration_manual_override, steam_type")
    .eq("steam_appid", steamAppId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return quiet;

  const row = data as Record<string, unknown>;
  // Demos, DLC and software are a different problem - see the quarantine notes in
  // docs/vault-recommender.md - and not one a length verdict should guess at.
  if (String(row.steam_type ?? "").toLowerCase() !== "game") return quiet;
  if (row.duration_kind === "endless") return quiet;
  if (row.duration_manual_override === true) return quiet;

  const verdict = endlessVerdict({
    tags,
    genres: (row.genres ?? []) as string[],
    categories: (row.categories ?? []) as string[],
    mainStoryMinutes: row.main_story_minutes as number | null,
    completionistMinutes: row.completionist_minutes as number | null,
    manualOverride: false
  });
  if (!verdict.endless) return quiet;

  const now = new Date().toISOString();
  // The HLTB minutes are kept rather than nulled. Nothing reads them once the kind
  // is endless - isEndlessGame short-circuits and deriveSessionFits opens every
  // session - so keeping them costs nothing and leaves the figure to fall back on
  // if a person later rules the game finite.
  const { error: updateError } = await supabase
    .from("catalog_games")
    .update({
      duration_kind: "endless",
      duration_source: "classification",
      duration_status: "ready",
      duration_confidence: "medium",
      duration_source_updated_at: now,
      updated_at: now
    })
    .eq("steam_appid", steamAppId)
    .neq("duration_manual_override", true);
  if (updateError) throw updateError;

  return { promoted: true, witnesses: verdict.witnesses };
}
