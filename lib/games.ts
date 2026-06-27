import { getSupabaseAdmin } from "@/lib/supabase";
import { applyCachedSteamMetadata, queueSteamMetadata } from "@/lib/steam-metadata";
import type { Game, GamePayload, RecommendationPayload, StatsPayload } from "@/lib/types";

function normalizeGamePayload(payload: Partial<GamePayload>): GamePayload {
  return {
    title: String(payload.title ?? "").trim(),
    genre: String(payload.genre ?? "Unknown").trim() || "Unknown",
    store: String(payload.store ?? "Steam").trim() || "Steam",
    ownership: payload.ownership ?? "Owned",
    status: payload.status ?? "Not Started",
    rating: Number(payload.rating ?? 0),
    hours_played: Number(payload.hours_played ?? 0),
    completion_percentage: payload.status === "Completed" ? 100 : Number(payload.completion_percentage ?? 0),
    priority: payload.priority ?? "Medium",
    date_added: payload.date_added || null,
    last_played_at: payload.last_played_at || null,
    notes: String(payload.notes ?? "").trim(),
    steam_appid: String(payload.steam_appid ?? "").trim() || null
  };
}

export async function listGames(userId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("user_id", userId)
    .order("title", { ascending: true });

  if (error) throw error;
  return applyCachedSteamMetadata((data ?? []) as Game[]);
}

export async function findGame(userId: string, gameId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("user_id", userId)
    .eq("id", gameId)
    .maybeSingle();

  if (error) throw error;
  return data as Game | null;
}

export async function createGame(userId: string, payload: GamePayload) {
  const game = normalizeGamePayload(payload);
  const supabase = getSupabaseAdmin();

  if (game.steam_appid) {
    const existing = await findGameBySteamAppId(userId, game.steam_appid);
    if (existing) return updateSteamBackedGame(userId, existing, game);
  }

  const { data, error } = await supabase
    .from("games")
    .insert({ ...game, user_id: userId })
    .select("*")
    .single();

  if (error) throw error;
  return data as Game;
}

export async function updateGame(userId: string, gameId: string, payload: GamePayload) {
  const game = normalizeGamePayload(payload);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("games")
    .update(game)
    .eq("user_id", userId)
    .eq("id", gameId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data as Game | null;
}

export async function patchGame(userId: string, gameId: string, payload: Partial<GamePayload>) {
  const update = normalizePatchPayload(payload);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("games")
    .update(update)
    .eq("user_id", userId)
    .eq("id", gameId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data as Game | null;
}

export async function deleteGame(userId: string, gameId: string) {
  const game = await findGame(userId, gameId);
  if (!game) return null;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("games").delete().eq("user_id", userId).eq("id", gameId);
  if (error) throw error;
  return game;
}

export async function upsertSteamGames(userId: string, games: GamePayload[]) {
  const steamGames = new Map<string, GamePayload>();
  for (const game of games.map(normalizeGamePayload)) {
    if (game.steam_appid) steamGames.set(game.steam_appid, game);
  }

  const incomingGames = await applyCachedSteamMetadata([...steamGames.values()]);
  if (!incomingGames.length) return [];
  await queueSteamMetadata(incomingGames.map((game) => String(game.steam_appid ?? "")));

  const supabase = getSupabaseAdmin();
  const { data: existingData, error: existingError } = await supabase
    .from("games")
    .select("*")
    .eq("user_id", userId)
    .in("steam_appid", incomingGames.map((game) => game.steam_appid as string));

  if (existingError) throw existingError;

  const existingByAppId = new Map(
    ((existingData ?? []) as Game[])
      .filter((game) => game.steam_appid)
      .map((game) => [game.steam_appid as string, game])
  );

  const rows = incomingGames.map((incoming) => {
    const existing = existingByAppId.get(incoming.steam_appid as string);
    if (!existing) return { ...incoming, user_id: userId };

    return {
      user_id: userId,
      title: incoming.title,
      genre: existing.genre && existing.genre !== "Unknown" ? existing.genre : incoming.genre,
      store: "Steam",
      ownership: existing.ownership,
      status: existing.status === "Completed" ? existing.status : incoming.status,
      rating: existing.rating,
      hours_played: incoming.hours_played,
      completion_percentage: existing.completion_percentage,
      priority: existing.priority,
      date_added: existing.date_added || incoming.date_added,
      last_played_at: incoming.last_played_at || existing.last_played_at,
      notes: existing.notes || incoming.notes,
      steam_appid: incoming.steam_appid
    };
  });

  const saved: Game[] = [];
  for (let index = 0; index < rows.length; index += 400) {
    const { data, error } = await supabase
      .from("games")
      .upsert(rows.slice(index, index + 400), { onConflict: "user_id,steam_appid" })
      .select("*");

    if (error) throw error;
    saved.push(...((data ?? []) as Game[]));
  }

  return saved;
}

export function statsPayload(games: Game[]): StatsPayload {
  const ratings = games.map((game) => Number(game.rating || 0)).filter((rating) => rating > 0);
  const completionTotal = games.reduce((total, game) => total + Number(game.completion_percentage || 0), 0);
  return {
    total: games.length,
    completed: games.filter((game) => game.status === "Completed").length,
    in_progress: games.filter((game) => game.status === "In Progress").length,
    wishlist: games.filter((game) => game.ownership === "Wishlist").length,
    hours: round1(games.reduce((total, game) => total + Number(game.hours_played || 0), 0)),
    avg_rating: ratings.length ? round1(ratings.reduce((total, rating) => total + rating, 0) / ratings.length) : 0,
    avg_completion: games.length ? round1(completionTotal / games.length) : 0
  };
}

export function recommendationsPayload(games: Game[]): RecommendationPayload {
  const backlog = topBacklog(games);
  const wishlist = topWishlist(games);
  const unfinished = games.filter((game) => game.ownership === "Owned" && game.status !== "Completed");
  return {
    backlog,
    wishlist,
    random: unfinished.length ? unfinished[Math.floor(Math.random() * unfinished.length)] : null
  };
}

export async function recordRecommendation(
  userId: string,
  game: Game,
  kind: string,
  reason: string,
  mood?: string,
  timeCommitment?: string
) {
  const supabase = getSupabaseAdmin();
  await supabase.from("recommendations").insert({
    user_id: userId,
    game_id: game.id,
    kind,
    reason,
    mood: mood ?? null,
    time_commitment: timeCommitment ?? null
  });
}

export function shuffleGame(games: Game[], mood: string, time: string) {
  let candidates = games.filter((game) => game.ownership === "Owned" && game.status !== "Completed");

  if (mood !== "Any vibe") {
    const keywords = {
      Relaxed: ["cozy", "farming", "sim", "puzzle", "casual", "stardew", "sky"],
      Action: ["action", "shooter", "fps", "rogue", "combat", "counter", "fear"],
      Story: ["story", "rpg", "adventure", "narrative", "witcher", "detroit"],
      Competitive: ["competitive", "multiplayer", "online", "counter-strike", "league"]
    }[mood] ?? [];
    const matched = candidates.filter((game) => {
      const text = `${game.title} ${game.genre} ${game.notes}`.toLowerCase();
      return keywords.some((word) => text.includes(word));
    });
    candidates = matched.length ? matched : candidates;
  }

  if (!candidates.length) return { game: null, reason: "No unfinished owned games were found." };

  const game = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    game,
    reason: `${game.status} pick for ${mood.toLowerCase()} / ${time.toLowerCase()} with ${Number(game.hours_played).toLocaleString()}h logged.`
  };
}

async function findGameBySteamAppId(userId: string, steamAppId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("user_id", userId)
    .eq("steam_appid", steamAppId)
    .maybeSingle();
  if (error) throw error;
  return data as Game | null;
}

async function updateSteamBackedGame(userId: string, existing: Game, incoming: GamePayload) {
  const update: Partial<GamePayload> = {
    title: incoming.title,
    store: "Steam",
    steam_appid: incoming.steam_appid,
    hours_played: incoming.hours_played,
    genre: existing.genre && existing.genre !== "Unknown" ? existing.genre : incoming.genre,
    status: existing.status === "Completed" ? existing.status : incoming.status,
    date_added: existing.date_added || incoming.date_added,
    last_played_at: incoming.last_played_at || existing.last_played_at,
    notes: existing.notes || incoming.notes,
    ownership: existing.ownership,
    rating: existing.rating,
    completion_percentage: existing.completion_percentage,
    priority: existing.priority
  };
  const saved = await updateGame(userId, existing.id, { ...existing, ...update });
  if (!saved) throw new Error("Could not update existing Steam game.");
  return saved;
}

function normalizePatchPayload(payload: Partial<GamePayload>) {
  const update: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (key === "steam_appid") update[key] = String(value ?? "").trim() || null;
    else if (key === "date_added" || key === "last_played_at") update[key] = value ? String(value) : null;
    else if (typeof value === "number") update[key] = value;
    else update[key] = String(value ?? "").trim();
  }
  if (update.status === "Completed") update.completion_percentage = 100;
  if (typeof update.completion_percentage === "number" && update.completion_percentage >= 100) update.status = "Completed";
  return update;
}

function topBacklog(games: Game[]) {
  return [...games]
    .filter((game) => game.ownership === "Owned" && game.status !== "Completed")
    .sort((a, b) => scoreBacklog(b) - scoreBacklog(a))
    .slice(0, 3);
}

function topWishlist(games: Game[]) {
  return [...games]
    .filter((game) => game.ownership === "Wishlist")
    .sort((a, b) => scoreWishlist(b) - scoreWishlist(a))
    .slice(0, 3);
}

function scoreBacklog(game: Game) {
  return scoreWishlist(game) - Number(game.completion_percentage || 0);
}

function scoreWishlist(game: Game) {
  const priorityScore = game.priority === "High" ? 10 : game.priority === "Medium" ? 5 : 0;
  return Number(game.rating || 0) * 2 + priorityScore;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}
