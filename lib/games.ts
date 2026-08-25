import { getSupabaseAdmin } from "@/lib/supabase";
import {
  displayStatus,
  gameProgress,
  inferredCompletionForPayload,
  isCompletedGame,
  statusFromGameProgress
} from "@/lib/game-classification";
import { applyCatalogueMetadata } from "@/lib/catalog-game-metadata";
import { normaliseSteamGenreLabel } from "@/lib/genres";
import { ensureCatalogueGameStubs, recordAutomaticSteamQuarantine } from "@/lib/catalogue";
import { USER_GAMES_READ_MODEL, USER_GAMES_TABLE } from "@/lib/game-tables";
import type { Game, GamePayload, StatsPayload } from "@/lib/types";

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
    .from(USER_GAMES_READ_MODEL)
    .select("*")
    .eq("user_id", userId)
    .eq("is_quarantined", false)
    // Wishlist was removed. Any legacy row is skipped rather than promoted to
    // Owned, which would silently add games the user does not own.
    .eq("ownership", "Owned")
    .order("title", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as Game[]).map(cleanStoredGame);
}

export async function findGame(userId: string, gameId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(USER_GAMES_READ_MODEL)
    .select("*")
    .eq("user_id", userId)
    .eq("id", gameId)
    .eq("is_quarantined", false)
    .eq("ownership", "Owned")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return cleanStoredGame(data as Game);
}

export async function createGame(userId: string, payload: GamePayload) {
  const game = normalizeGamePayload(payload);
  if (!game.steam_appid) throw new Error("A Steam App ID is required.");
  await ensureCatalogueGameStubs([game]);
  await recordAutomaticSteamQuarantine([game]);
  const [saved] = await upsertSteamImportRows(userId, [steamImportRow(game)], game.ownership);
  if (!saved) throw new Error("Could not save this Steam game.");
  return findGame(userId, saved.id);
}

export async function updateGame(userId: string, gameId: string, payload: GamePayload) {
  return patchGame(userId, gameId, {
    ownership: payload.ownership,
    status: payload.status,
    hours_played: payload.hours_played,
    completion_percentage: payload.completion_percentage,
    priority: payload.priority,
    date_added: payload.date_added,
    last_played_at: payload.last_played_at,
    notes: payload.notes,
    completed_at: payload.completed_at,
    slept_at: payload.slept_at,
    completion_suggestion_dismissed_at: payload.completion_suggestion_dismissed_at,
    completion_suggestion_dismissed_playtime: payload.completion_suggestion_dismissed_playtime
  });
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
    if (Object.keys(update).length === 0) {
      return statusGame ? findGame(userId, gameId) : null;
    }
  }
  const { data, error } = await supabase
    .from(USER_GAMES_TABLE)
    .update(update)
    .eq("user_id", userId)
    .eq("id", gameId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? findGame(userId, gameId) : null;
}

export async function restoreGameToActive(userId: string, gameId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("restore_user_game_active", {
    p_user_id: userId,
    p_game_id: gameId
  });
  if (error) throw error;
  return data ? findGame(userId, gameId) : null;
}

export async function deleteGame(userId: string, gameId: string) {
  const game = await findGame(userId, gameId);
  if (!game) return null;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(USER_GAMES_TABLE).delete().eq("user_id", userId).eq("id", gameId);
  if (error) throw error;
  return game;
}

export async function upsertSteamGames(userId: string, games: GamePayload[]) {
  const steamGames = new Map<string, GamePayload>();
  for (const game of games.map(normalizeGamePayload)) {
    if (game.steam_appid) steamGames.set(game.steam_appid, game);
  }

  const importedGames = [...steamGames.values()];
  await ensureCatalogueGameStubs(importedGames);
  const incomingGames = await applyCatalogueMetadata(importedGames);
  if (!incomingGames.length) return [];
  await recordAutomaticSteamQuarantine(incomingGames);
  const rows = incomingGames.map(steamImportRow);

  return upsertSteamImportRows(userId, rows, "Owned");
}

async function upsertSteamImportRows<T extends object>(
  userId: string,
  rows: T[],
  ownership: GamePayload["ownership"]
) {
  if (!rows.length) return [] as Game[];

  const supabase = getSupabaseAdmin();
  const saved: Game[] = [];
  for (let index = 0; index < rows.length; index += 400) {
    const { data, error } = await supabase.rpc("upsert_user_steam_games", {
      p_user_id: userId,
      p_games: rows.slice(index, index + 400),
      p_ownership: ownership
    });
    if (error) throw error;
    saved.push(...((data ?? []) as Game[]));
  }
  return saved;
}

function steamImportRow(game: GamePayload) {
  const normalized = normalizeGamePayload(game);
  return {
    steam_appid: normalized.steam_appid,
    status: normalized.status,
    hours_played: normalized.hours_played,
    completion_percentage: normalized.completion_percentage,
    priority: normalized.priority,
    date_added: normalized.date_added,
    last_played_at: normalized.last_played_at,
    notes: normalized.notes
  };
}

export function statsPayload(games: Game[]): StatsPayload {
  const ownedGames = games.filter((game) => game.ownership === "Owned");
  const ratings = ownedGames.map((game) => Number(game.rating || 0)).filter((rating) => rating > 0);
  const completionTotal = ownedGames.reduce((total, game) => total + gameProgress(game), 0);
  const completed = ownedGames.filter(isCompletedGame).length;
  const inProgress = ownedGames.filter((game) => displayStatus(game) === "In Progress").length;
  return {
    total: ownedGames.length,
    completed,
    in_progress: inProgress,
    hours: round1(ownedGames.reduce((total, game) => total + Number(game.hours_played || 0), 0)),
    avg_rating: ratings.length ? round1(ratings.reduce((total, rating) => total + rating, 0) / ratings.length) : 0,
    avg_completion: ownedGames.length ? round1(completionTotal / ownedGames.length) : 0
  };
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
  return "Owned";
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}


/** Records what Steam shared for this account on the most recent import. */
export async function recordSteamVisibility(
  userId: string,
  visibility: { libraryVisible: boolean; playtimeVisible: boolean; lastPlayedVisible: boolean; gamesSeen: number }
) {
  const { error } = await getSupabaseAdmin()
    .from("app_users")
    .update({
      steam_library_visible: visibility.libraryVisible,
      steam_playtime_visible: visibility.playtimeVisible,
      // Recorded for diagnostics only. It is NOT a setting the user should be
      // asked to change: Steam withholds rtime_last_played from third-party apps
      // regardless of the Game details privacy setting, so the banner that used
      // to tell people to fix it was sending them to fix nothing. Recency is
      // inferred instead - see lib/recency.ts.
      steam_last_played_visible: visibility.lastPlayedVisible,
      steam_games_seen: visibility.gamesSeen,
      steam_visibility_checked_at: new Date().toISOString()
    })
    .eq("id", userId);
  if (error) throw error;
}
