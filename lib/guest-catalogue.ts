import "server-only";

import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { Game } from "@/lib/types";

const GUEST_POOL_SIZE = 250;
const GUEST_QUERY_SIZE = 300;

type GuestCatalogueRow = {
  steam_appid: number;
  name: string;
  genres: string[];
  tags: Record<string, number>;
  short_description: string | null;
  capsule_url: string | null;
  header_url: string | null;
  review_positive: number;
  review_total: number | null;
  main_story_minutes: number | null;
  main_extras_minutes: number | null;
  completionist_minutes: number | null;
  duration_source: string | null;
  duration_source_updated_at: string | null;
  duration_confidence: Game["duration_confidence"];
  duration_kind: Game["duration_kind"];
};

const loadCachedGuestCatalogue = unstable_cache(
  async () => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("catalog_games")
      .select("steam_appid,name,genres,tags,short_description,capsule_url,header_url,review_positive,review_total,main_story_minutes,main_extras_minutes,completionist_minutes,duration_source,duration_source_updated_at,duration_confidence,duration_kind")
      .eq("steam_type", "game")
      .order("popularity_rank", { ascending: true, nullsFirst: false })
      .order("review_total", { ascending: false, nullsFirst: false })
      .order("steam_appid", { ascending: true })
      .limit(GUEST_QUERY_SIZE);

    if (error) throw error;
    const rows = (data ?? []) as GuestCatalogueRow[];
    const appIds = rows.map((row) => row.steam_appid);
    const { data: quarantined, error: quarantineError } = appIds.length
      ? await supabase
          .from("catalog_game_quarantine")
          .select("steam_appid")
          .in("steam_appid", appIds)
          .eq("review_status", "excluded")
      : { data: [], error: null };

    if (quarantineError) throw quarantineError;
    const excluded = new Set((quarantined ?? []).map((row) => Number(row.steam_appid)));
    return rows
      .filter((row) => !excluded.has(Number(row.steam_appid)))
      .slice(0, GUEST_POOL_SIZE)
      .map(guestGameFromCatalogue);
  },
  ["guest-catalogue-v1"],
  { revalidate: 60 * 60, tags: ["guest-catalogue"] }
);

export async function listGuestCatalogueGames() {
  const games = await loadCachedGuestCatalogue();
  if (games.length < GUEST_POOL_SIZE) {
    throw new Error(`Guest catalogue returned ${games.length} games; expected ${GUEST_POOL_SIZE}.`);
  }
  return games;
}

function guestGameFromCatalogue(row: GuestCatalogueRow): Game {
  const appId = Number(row.steam_appid);
  const reviewTotal = Math.max(0, Number(row.review_total || 0));
  const rating = reviewTotal > 0
    ? Math.max(0, Math.min(10, Math.round(Number(row.review_positive || 0) * 10 / reviewTotal)))
    : 0;

  return {
    id: `guest-${appId}`,
    user_id: "",
    title: String(row.name || "").trim(),
    genre: row.genres.filter(Boolean).join(" / ") || "Unknown",
    store: "Steam",
    ownership: "Owned",
    status: "Not Started",
    rating,
    hours_played: 0,
    completion_percentage: 0,
    priority: "Medium",
    date_added: null,
    last_played_at: null,
    notes: String(row.short_description || "").trim(),
    steam_appid: String(appId),
    capsule_url: row.capsule_url,
    header_url: row.header_url,
    main_story_minutes: row.main_story_minutes,
    main_extras_minutes: row.main_extras_minutes,
    completionist_minutes: row.completionist_minutes,
    duration_source: row.duration_source,
    duration_source_updated_at: row.duration_source_updated_at,
    duration_confidence: row.duration_confidence,
    duration_kind: row.duration_kind,
    steam_tags: row.tags,
    is_quarantined: false
  };
}
