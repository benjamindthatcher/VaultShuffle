import type { Game, GamePayload } from "@/lib/types";

type GameLike = Pick<Game, "title" | "genre"> & Partial<Pick<Game, "hours_played" | "completion_percentage" | "status">>;

export const LENGTH_LABELS = ["Bitesize", "Short", "Weekend", "Campaign", "Meaty", "Marathon", "Odyssey", "Endless"] as const;

export const LENGTH_HELP_TEXT =
  "Bitesize: under 5h. Short: 5-10h. Weekend: 10-20h. Campaign: 20-40h. Meaty: 40-80h. Marathon: 80-120h. Odyssey: 120h+. Endless: replayable, live-service, or sandbox.";

export type LengthLabel = (typeof LENGTH_LABELS)[number];

export function isCompletedGame(game: GameLike) {
  return game.status === "Completed" || gameProgress(game) >= 100;
}

export function displayStatus(game: GameLike): GamePayload["status"] {
  if (isCompletedGame(game)) return "Completed";
  const progress = gameProgress(game);
  if (progress > 0 && progress <= 10) return "Sampled";
  if (progress > 10 || (isEndlessGame(game) && Number(game.hours_played || 0) > 0)) return "In Progress";
  return "Not Started";
}

export function gameProgress(game: GameLike) {
  if (game.status === "Completed") return 100;
  const inferred = inferredProgressFromHours(game, Number(game.hours_played || 0));
  const stored = Number(game.completion_percentage || 0);
  if (stored > 0) {
    const roundedStored = clamp(Math.round(stored), 0, 100);
    return inferred >= 100 && roundedStored >= 99 ? 100 : roundedStored;
  }
  return inferred;
}

export function inferredCompletionForPayload(
  title: string,
  genre: string,
  hours: number,
  status: Partial<GamePayload>["status"],
  completion: Partial<GamePayload>["completion_percentage"]
) {
  if (status === "Completed") return 100;
  const stored = clamp(Math.round(Number(completion ?? 0)), 0, 100);
  if (stored > 0) return stored;
  return inferredProgressFromHours({ title, genre, hours_played: hours }, hours);
}

export function inferredProgressFromHours(game: GameLike, hours: number) {
  const estimate = estimatedGameHours(game);
  const played = Number(hours || 0);
  if (!played || !estimate) return 0;
  if (played >= estimate) return 100;
  return clamp(Math.round((played / estimate) * 100), 0, 99);
}

export function statusFromGameProgress(game: GameLike, completion: number): GamePayload["status"] {
  if (completion >= 100) return "Completed";
  if (completion > 10) return "In Progress";
  if (completion > 0) return "Sampled";
  if (isEndlessGame(game) && Number(game.hours_played || 0) > 0) return "In Progress";
  return "Not Started";
}

export function statusFromCompletion(completion: number): GamePayload["status"] {
  if (completion >= 100) return "Completed";
  if (completion > 10) return "In Progress";
  if (completion > 0) return "Sampled";
  return "Not Started";
}

export function estimatedGameHours(game: GameLike) {
  const text = `${game.title} ${game.genre}`.toLowerCase();
  if (isEndlessGame(game)) return 0;
  if (/(open world|grand strategy|4x|jrpg|role-playing|role playing)/.test(text)) return 120;
  if (/(rpg|strategy|simulation|management)/.test(text)) return 80;
  if (/(adventure|action-adventure|souls|metroidvania|horror)/.test(text)) return 40;
  if (/(action|shooter|fps|third-person|racing|sports|fighting)/.test(text)) return 20;
  if (/(puzzle|casual|arcade|platformer|indie|hidden object|visual novel)/.test(text)) return 10;
  return 20;
}

export function lengthBucket(game: GameLike): LengthLabel {
  if (isEndlessGame(game)) return "Endless";
  const estimate = estimatedGameHours(game);
  if (estimate < 5) return "Bitesize";
  if (estimate <= 10) return "Short";
  if (estimate <= 20) return "Weekend";
  if (estimate <= 40) return "Campaign";
  if (estimate <= 80) return "Meaty";
  if (estimate <= 120) return "Marathon";
  return "Odyssey";
}

export function isEndlessGame(game: GameLike) {
  const text = `${game.title} ${game.genre}`.toLowerCase();
  return (
    /(counter-?strike|destiny|apex legends|rust|palworld|new world|for honor|warframe|dota|team fortress|pubg|rainbow six|rocket league|dead by daylight|elder scrolls online|final fantasy xiv|path of exile|lost ark|factorio|rimworld|terraria|monster hunter)/.test(text) ||
    /(mmo|massively multiplayer|multiplayer|battle royale|moba|live service|survival|sandbox|free to play|pvp|pve|online|roguelike|roguelite)/.test(text)
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
