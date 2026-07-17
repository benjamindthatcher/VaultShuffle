import { getSupabaseAdmin } from "@/lib/supabase";
import {
  displayStatus,
  gameProgress,
  inferredCompletionForPayload,
  isCompletedGame,
  statusFromGameProgress
} from "@/lib/game-classification";
import { applyCachedSteamMetadata, queueSteamMetadata } from "@/lib/steam-metadata";
import { normaliseSteamGenreLabel } from "@/lib/genres";
import type { Game, GamePayload, StatsPayload } from "@/lib/types";

type GameDatabaseRow = ReturnType<typeof normalizeGamePayload> & { user_id: string };

function normalizeGamePayload(payload: Partial<GamePayload>): GamePayload {
  const title = String(payload.title ?? "").trim();
  const genre = normaliseSteamGenreLabel(payload.genre ?? "Unknown", title);
  const hours = Number(payload.hours_played ?? 0);
  const completion = inferredCompletionForPayload(title, genre, hours, payload.status, payload.completion_percentage);
  return {
    title,
    genre,
    store: String(payload.store ?? "Steam").trim() || "Steam",
    ownership: normalizeOwnership(payload.ownership),
    status: payload.status ?? statusFromGameProgress({ title, genre, hours_played: hours }, completion),
    rating: Number(payload.rating ?? 0),
    hours_played: hours,
    completion_percentage: completion,
    priority: payload.priority ?? "Medium",
    date_added: payload.date_added || null,
    last_played_at: payload.last_played_at || null,
    notes: cleanUserNotes(payload.notes),
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
  const games = ((data ?? []) as Game[]).map(cleanStoredGame);
  return applyCachedSteamMetadata(games);
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
  if (typeof update.status === "string") {
    const status = update.status;
    const { data: statusGame, error: statusError } = await supabase.rpc("set_user_game_status", {
      p_user_id: userId,
      p_game_id: gameId,
      p_status: status
    });
    if (statusError) throw statusError;
    delete update.status;
    delete update.completed_at;
    delete update.slept_at;
    if (Object.keys(update).length === 0) return statusGame as Game | null;
  }
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

export async function restoreGameToActive(userId: string, gameId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("restore_user_game_active", {
    p_user_id: userId,
    p_game_id: gameId
  });
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
    if (!existing) return gameDatabaseRow(userId, incoming);

    const existingCompletion = clamp(Math.round(Number(existing.completion_percentage || 0)), 0, 100);
    const incomingCompletion = inferredCompletionForPayload(
      incoming.title,
      incoming.genre,
      Number(incoming.hours_played || 0),
      incoming.status,
      incoming.completion_percentage
    );
    const completion = existingCompletion > 0 ? existingCompletion : incomingCompletion;
    const status = existing.status;

    return {
      user_id: userId,
      title: incoming.title,
      genre: existing.genre && existing.genre !== "Unknown" ? existing.genre : incoming.genre,
      store: "Steam",
      ownership: "Owned",
      status,
      rating: Number(existing.rating || 0) > 0 ? existing.rating : incoming.rating,
      hours_played: incoming.hours_played,
      completion_percentage: completion,
      priority: existing.priority,
      date_added: existing.date_added || incoming.date_added,
      last_played_at: incoming.last_played_at || existing.last_played_at,
      notes: cleanUserNotes(existing.notes) || incoming.notes,
      steam_appid: incoming.steam_appid,
      completed_at: existing.completed_at,
      slept_at: existing.slept_at,
      completion_suggestion_dismissed_at: existing.completion_suggestion_dismissed_at,
      completion_suggestion_dismissed_playtime: existing.completion_suggestion_dismissed_playtime
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

function gameDatabaseRow(userId: string, game: GamePayload): GameDatabaseRow {
  return {
    ...normalizeGamePayload(game),
    user_id: userId
  };
}

export function statsPayload(games: Game[]): StatsPayload {
  const ratings = games.map((game) => Number(game.rating || 0)).filter((rating) => rating > 0);
  const completionTotal = games.reduce((total, game) => total + gameProgress(game), 0);
  const completed = games.filter(isCompletedGame).length;
  const inProgress = games.filter((game) => displayStatus(game) === "In Progress").length;
  return {
    total: games.length,
    completed,
    in_progress: inProgress,
    wishlist: games.filter((game) => game.ownership === "Wishlist").length,
    hours: round1(games.reduce((total, game) => total + Number(game.hours_played || 0), 0)),
    avg_rating: ratings.length ? round1(ratings.reduce((total, rating) => total + rating, 0) / ratings.length) : 0,
    avg_completion: games.length ? round1(completionTotal / games.length) : 0
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
    status: existing.status,
    date_added: existing.date_added || incoming.date_added,
    last_played_at: incoming.last_played_at || existing.last_played_at,
    notes: cleanUserNotes(existing.notes) || incoming.notes,
    ownership: existing.ownership,
    rating: Number(existing.rating || 0) > 0 ? existing.rating : incoming.rating,
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
    else if (key === "ownership") update[key] = normalizeOwnership(value);
    else if (typeof value === "number") update[key] = value;
    else update[key] = key === "notes" ? cleanUserNotes(value) : String(value ?? "").trim();
  }
  if (update.status === "Completed") {
    update.completed_at = typeof update.completed_at === "string" ? update.completed_at : new Date().toISOString();
    update.slept_at = null;
  } else if (update.status === "Slept") {
    update.slept_at = typeof update.slept_at === "string" ? update.slept_at : new Date().toISOString();
    update.completed_at = null;
  } else if (typeof update.status === "string") {
    update.completed_at = null;
    update.slept_at = null;
  }
  if (typeof update.completion_percentage === "number") {
    update.completion_percentage = clamp(Math.round(update.completion_percentage), 0, update.status === "Completed" ? 100 : 99);
  }
  return update;
}

function cleanStoredGame(game: Game) {
  const notes = cleanUserNotes(game.notes);
  const ownership = normalizeOwnership(game.ownership);
  return notes === game.notes && ownership === game.ownership ? game : { ...game, notes, ownership };
}

function cleanUserNotes(value: unknown) {
  const notes = String(value ?? "").trim();
  return isGeneratedSteamNote(notes) ? "" : notes;
}

function isGeneratedSteamNote(notes: string) {
  return /^(Imported from Steam account|Added from Steam search)\. AppID: \d+$/i.test(notes);
}

function normalizeOwnership(value: unknown): GamePayload["ownership"] {
  return value === "Owned" ? "Owned" : "Wishlist";
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
