import { getSupabaseAdmin } from "@/lib/supabase";
import { applyCachedSteamMetadata, queueSteamMetadata } from "@/lib/steam-metadata";
import { matchesTopLevelGenre, normaliseSteamGenreLabel } from "@/lib/genres";
import type { Game, GamePayload, RecommendationPayload, StatsPayload } from "@/lib/types";

type GameDatabaseRow = ReturnType<typeof normalizeGamePayload> & { user_id: string };

function normalizeGamePayload(payload: Partial<GamePayload>): GamePayload {
  const title = String(payload.title ?? "").trim();
  const genre = normaliseSteamGenreLabel(payload.genre ?? "Unknown", title);
  const completion = payload.status === "Completed"
    ? 100
    : clamp(Math.round(Number(payload.completion_percentage ?? 0)), 0, 100);
  return {
    title,
    genre,
    store: String(payload.store ?? "Steam").trim() || "Steam",
    ownership: normalizeOwnership(payload.ownership),
    status: statusFromCompletion(completion),
    rating: Number(payload.rating ?? 0),
    hours_played: Number(payload.hours_played ?? 0),
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
    if (!existing) return gameDatabaseRow(userId, incoming);

    return {
      user_id: userId,
      title: incoming.title,
      genre: existing.genre && existing.genre !== "Unknown" ? existing.genre : incoming.genre,
      store: "Steam",
      ownership: "Owned",
      status: existing.status === "Completed" ? existing.status : incoming.status,
      rating: existing.rating,
      hours_played: incoming.hours_played,
      completion_percentage: existing.completion_percentage,
      priority: existing.priority,
      date_added: existing.date_added || incoming.date_added,
      last_played_at: incoming.last_played_at || existing.last_played_at,
      notes: cleanUserNotes(existing.notes) || incoming.notes,
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
  const inProgress = games.filter((game) => !isCompletedGame(game) && (game.status === "In Progress" || gameProgress(game) > 0)).length;
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

export function recommendationsPayload(games: Game[]): RecommendationPayload {
  const backlog = topBacklog(games);
  const wishlist = topWishlist(games);
  const unfinished = games.filter((game) => game.ownership === "Owned" && !isCompletedGame(game));
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
  genre?: string,
  timeCommitment?: string
) {
  const supabase = getSupabaseAdmin();
  await supabase.from("recommendations").insert({
    user_id: userId,
    game_id: game.id,
    kind,
    reason,
    mood: genre ?? null,
    time_commitment: timeCommitment ?? null
  });
}

export function shuffleGame(games: Game[], genre: string, time: string) {
  const candidates = games.filter((game) =>
    game.ownership === "Owned" &&
    !isCompletedGame(game) &&
    matchesGenre(game, genre) &&
    matchesTime(game, time)
  );

  if (!candidates.length) return { game: null, reason: "No unfinished owned games were found." };

  const game = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    game,
    reason: `${game.status} pick for ${genre.toLowerCase()} / ${time.toLowerCase()} with ${Number(game.hours_played).toLocaleString()}h logged.`
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
    notes: cleanUserNotes(existing.notes) || incoming.notes,
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
    else if (key === "ownership") update[key] = normalizeOwnership(value);
    else if (typeof value === "number") update[key] = value;
    else update[key] = key === "notes" ? cleanUserNotes(value) : String(value ?? "").trim();
  }
  if (update.status === "Completed") update.completion_percentage = 100;
  if (typeof update.completion_percentage === "number") {
    update.completion_percentage = clamp(Math.round(update.completion_percentage), 0, 100);
    update.status = statusFromCompletion(update.completion_percentage);
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

function topBacklog(games: Game[]) {
  return [...games]
    .filter((game) => game.ownership === "Owned" && !isCompletedGame(game))
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
  return scoreWishlist(game) - gameProgress(game);
}

function scoreWishlist(game: Game) {
  return Number(game.rating || 0) * 2 + Number(game.hours_played || 0) / 40;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function isCompletedGame(game: Game) {
  return game.status === "Completed" || gameProgress(game) >= 100;
}

function gameProgress(game: Game) {
  if (game.status === "Completed") return 100;
  const estimate = estimatedGameHours(game);
  const played = Number(game.hours_played || 0);
  const inferred = !played || !estimate ? 0 : played >= estimate ? 100 : clamp(Math.round((played / estimate) * 100), 0, 99);
  const stored = Number(game.completion_percentage || 0);
  if (stored > 0) {
    const roundedStored = clamp(Math.round(stored), 0, 100);
    return inferred >= 100 && roundedStored >= 99 ? 100 : roundedStored;
  }
  return inferred;
}

function statusFromCompletion(completion: number): GamePayload["status"] {
  if (completion >= 100) return "Completed";
  if (completion > 0) return "In Progress";
  return "Not Started";
}

function estimatedGameHours(game: Pick<Game, "title" | "genre"> & Partial<Pick<Game, "hours_played">>) {
  const text = `${game.title} ${game.genre}`.toLowerCase();
  if (Number(game.hours_played || 0) >= 300) return 300;
  if (/(counter-?strike|destiny|apex legends|rust|palworld|new world|for honor|warframe|dota|team fortress|pubg|rainbow six|rocket league|dead by daylight|elder scrolls online|final fantasy xiv|path of exile|lost ark)/.test(text)) return 300;
  if (/(mmo|massively multiplayer|multiplayer|battle royale|moba|live service|survival|sandbox|free to play|pvp|pve|online)/.test(text)) return 300;
  if (/(rpg|role-playing|strategy|simulation|management|grand strategy|4x|open world)/.test(text)) return 100;
  if (/(adventure|action-adventure|souls|metroidvania|horror)/.test(text)) return 50;
  if (/(action|shooter|fps|third-person|racing|sports|fighting)/.test(text)) return 30;
  if (/(puzzle|casual|arcade|platformer|indie|hidden object|visual novel)/.test(text)) return 15;
  return 30;
}

function timeBucket(game: Game) {
  const estimate = estimatedGameHours(game);
  if (estimate <= 5) return "5h";
  if (estimate <= 15) return "15h";
  if (estimate <= 30) return "30h";
  if (estimate <= 50) return "50h";
  if (estimate <= 100) return "100h";
  return "300h+";
}

function matchesGenre(game: Game, genre: string) {
  return matchesTopLevelGenre(game.genre, genre, game.title);
}

function matchesTime(game: Game, time: string) {
  if (time === "Any time") return true;
  return timeBucket(game) === time;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
