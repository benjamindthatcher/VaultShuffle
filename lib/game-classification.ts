import type { Game, GamePayload } from "./types.ts";
import { completionFromDuration, estimatedTimeToBeatMinutes } from "./game-duration.ts";

type GameLike = Pick<Game, "title" | "genre"> & Partial<Pick<Game,
  "hours_played" | "completion_percentage" | "status" | "main_story_minutes" |
  "main_extras_minutes" | "completionist_minutes" | "duration_kind"
>>;

type ReplayabilityMetadata = {
  tags?: Record<string, unknown> | string[] | null;
  genres?: string[] | null;
  categories?: string[] | null;
};

const DECISIVE_ENDLESS_SIGNALS = new Set([
  "auto battler",
  "automation",
  "battle royale",
  "clicker",
  "colony sim",
  "idler",
  "incremental",
  "massively multiplayer",
  "mmo",
  "mmorpg",
  "moba",
  "open world survival craft",
  "party game",
]);

/**
 * A decisive tag only counts when it is a dominant description of the game.
 *
 * Steam tags are community-voted, so a minority vote can plant a decisive tag on
 * something it does not describe: Runner3, a linear platformer, carries
 * "Massively Multiplayer" on 45% of its top tag's votes. Valheim's
 * "Open World Survival Craft" sits at 100%, and Far Cry Primal's at 50% — which
 * is why share, not presence, is the test.
 */
const DOMINANT_TAG_SHARE = 0.65;

function dominantSignals(tags: ReplayabilityMetadata["tags"]) {
  if (!tags || Array.isArray(tags) || typeof tags !== "object") return new Set<string>();
  const counts = Object.values(tags).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (!counts.length) return new Set<string>();
  const top = Math.max(...counts);
  return new Set(
    Object.entries(tags)
      .filter(([, votes]) => Number(votes) >= DOMINANT_TAG_SHARE * top)
      .map(([tag]) => tag.trim().toLowerCase())
  );
}

/**
 * A completion time far beyond the story length means the length is not a
 * completion at all — it is score chasing or a live-service grind. Counter-Strike 2
 * reports 1h story against 186h completionist; the median across the library is 2.6.
 */
const ENDLESS_COMPLETION_RATIO = 12;

export function hasEndlessDurationShape(duration: {
  mainStoryMinutes?: number | null;
  completionistMinutes?: number | null;
}) {
  const story = Number(duration.mainStoryMinutes ?? 0);
  const completionist = Number(duration.completionistMinutes ?? 0);
  if (!completionist) return false;
  if (story > 0) return completionist / story >= ENDLESS_COMPLETION_RATIO;
  return completionist > 12_000;
}

const PERSISTENT_ONLINE_SIGNALS = new Set([
  "live service",
  "massively multiplayer",
  "mmo",
  "mmorpg",
  "persistent online",
]);

const REPLAY_LOOP_SIGNALS = new Set([
  "competitive",
  "esports",
  "open world survival craft",
  "online co-op",
  "online pvp",
  "pvp",
  "sandbox",
  "survival",
]);

export const LENGTH_LABELS = ["Bitesize", "Short", "Weekend", "Campaign", "Meaty", "Marathon", "Odyssey", "Endless"] as const;

export const LENGTH_HELP_TEXT =
  "Bitesize: under 5h. Short: 5-10h. Weekend: 10-20h. Campaign: 20-40h. Meaty: 40-80h. Marathon: 80-120h. Odyssey: 120h+. Endless: replayable, live-service, or sandbox.";

export type LengthLabel = (typeof LENGTH_LABELS)[number];

export function isCompletedGame(game: GameLike) {
  return game.status === "Completed";
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
  if (isEndlessGame(game)) return 99;
  const inferred = inferredProgressFromHours(game, Number(game.hours_played || 0));
  if (estimatedTimeToBeatMinutes(durationForGame(game))) return inferred;
  const stored = Number(game.completion_percentage || 0);
  if (stored > 0) {
    const roundedStored = clamp(Math.round(stored), 0, 100);
    return Math.min(99, roundedStored);
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
  const stored = clamp(Math.round(Number(completion ?? 0)), 0, status === "Completed" ? 100 : 99);
  if (stored > 0) return stored;
  return inferredProgressFromHours({ title, genre, hours_played: hours }, hours);
}

export function inferredProgressFromHours(game: GameLike, hours: number) {
  if (isEndlessGame(game)) return 99;
  const durationProgress = completionFromDuration(hours, durationForGame(game));
  if (estimatedTimeToBeatMinutes(durationForGame(game))) return durationProgress;
  const estimate = estimatedGameHours(game);
  const played = Number(hours || 0);
  if (!played || !estimate) return 0;
  if (played >= estimate) return 99;
  return clamp(Math.round((played / estimate) * 100), 0, 99);
}

export function statusFromGameProgress(game: GameLike, completion: number): GamePayload["status"] {
  if (completion > 10) return "In Progress";
  if (completion > 0) return "Sampled";
  if (isEndlessGame(game) && Number(game.hours_played || 0) > 0) return "In Progress";
  return "Not Started";
}

export function estimatedGameHours(game: GameLike) {
  const durationMinutes = estimatedTimeToBeatMinutes(durationForGame(game));
  if (durationMinutes) return durationMinutes / 60;
  const text = `${game.title} ${game.genre}`.toLowerCase();
  if (isEndlessGame(game)) return 0;
  if (/(open world|grand strategy|4x|jrpg|role-playing|role playing)/.test(text)) return 120;
  if (/(rpg|strategy|simulation|management)/.test(text)) return 80;
  if (/(adventure|action-adventure|souls|metroidvania|horror)/.test(text)) return 40;
  if (/(action|shooter|fps|third-person|racing|sports|fighting)/.test(text)) return 20;
  if (/(puzzle|casual|arcade|platformer|indie|hidden object|visual novel)/.test(text)) return 10;
  return 20;
}

function durationForGame(game: GameLike) {
  return {
    mainStoryMinutes: game.main_story_minutes,
    mainExtrasMinutes: game.main_extras_minutes,
    completionistMinutes: game.completionist_minutes
  };
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
  if (game.duration_kind === "endless") return true;
  if (game.duration_kind === "finite" || game.duration_kind === "not-applicable") return false;
  if (hasEndlessDurationShape({
    mainStoryMinutes: game.main_story_minutes,
    completionistMinutes: game.completionist_minutes
  })) return true;
  if (estimatedTimeToBeatMinutes(durationForGame(game))) return false;
  const text = `${game.title} ${game.genre}`.toLowerCase();
  return (
    /(counter-?strike|destiny|apex legends|rust|palworld|new world|for honor|warframe|dota|team fortress|pubg|rainbow six|rocket league|dead by daylight|elder scrolls online|final fantasy xiv|path of exile|lost ark|factorio|rimworld|terraria|monster hunter)/.test(text) ||
    /(\bmmo\b|massively multiplayer|battle royale|\bmoba\b|live service)/.test(text)
  );
}

/**
 * Classifies only decisive replayability metadata. It is intentionally stricter
 * than the UI's fallback title heuristic because this result can be persisted.
 * A real finite duration must be checked by the caller before using this result.
 */
export function hasStrongReplayabilitySignals(metadata: ReplayabilityMetadata) {
  const signals = new Set([
    ...normaliseSignals(metadata.tags),
    ...normaliseSignals(metadata.genres),
    ...normaliseSignals(metadata.categories),
  ]);

  const dominant = dominantSignals(metadata.tags);
  if ([...DECISIVE_ENDLESS_SIGNALS].some((signal) => dominant.has(signal))) return true;
  const persistent = [...PERSISTENT_ONLINE_SIGNALS].some((signal) => signals.has(signal));
  const replayLoop = [...REPLAY_LOOP_SIGNALS].some((signal) => signals.has(signal));
  return persistent && replayLoop;
}

function normaliseSignals(value: ReplayabilityMetadata["tags"] | string[] | null | undefined) {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.keys(value)
      : [];
  return values.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
