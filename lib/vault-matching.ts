import { sessionLean } from "./sessionability.ts";
import type { VaultMoodId, VaultSessionId } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";
import type { GameDurationEstimate } from "./types.ts";

export type VaultMoodScores = Record<VaultMoodId, number>;

type WeightedMoodRule = Partial<VaultMoodScores>;

const MOOD_RULES: Record<string, WeightedMoodRule> = {
  arcade: { "brain-off": 4, intense: 1 },
  casual: { "brain-off": 3, chill: 3, intense: -2 },
  racing: { "brain-off": 2, intense: 2 },
  sports: { "brain-off": 2, intense: 1 },
  rhythm: { "brain-off": 4, intense: 2 },
  "hack and slash": { "brain-off": 3, intense: 3 },
  "beat 'em up": { "brain-off": 3, intense: 3 },
  platformer: { "brain-off": 3 },
  idle: { "brain-off": 5, chill: 3 },
  incremental: { "brain-off": 5, chill: 2 },
  sandbox: { "brain-off": 2, chill: 3 },

  strategy: { "brain-off": -4 },
  tactical: { "brain-off": -5 },
  puzzle: { "brain-off": -4 },
  investigation: { "brain-off": -5 },
  management: { "brain-off": -4 },
  "grand strategy": { "brain-off": -6 },
  crpg: { "brain-off": -5 },
  deckbuilder: { "brain-off": -5 },
  "card battler": { "brain-off": -4 },
  "story rich": { "brain-off": -3 },
  narrative: { "brain-off": -3 },
  "visual novel": { "brain-off": -4, chill: 1 },
  crafting: { "brain-off": -3 },

  cozy: { "brain-off": 2, chill: 5, intense: -5 },
  farming: { "brain-off": 2, chill: 5, intense: -4 },
  "life sim": { chill: 5 },
  "life simulation": { chill: 5 },
  exploration: { chill: 3 },
  "walking simulator": { "brain-off": -1, chill: 5, intense: -5 },
  "point & click": { chill: 3 },
  "point and click": { chill: 3 },
  building: { chill: 3, intense: -2 },
  creative: { chill: 4, intense: -4 },
  "turn-based": { chill: 2 },
  "turn based": { chill: 2 },
  relaxing: { chill: 5, intense: -5 },

  horror: { chill: -5, intense: 5 },
  soulslike: { "brain-off": -2, chill: -5, intense: 5 },
  fighting: { intense: 4 },
  shooter: { intense: 3 },
  fps: { intense: 3 },
  survival: { "brain-off": -2, chill: -3, intense: 3 },
  "survival horror": { chill: -6, intense: 6 },
  "battle royale": { chill: -5, intense: 5 },
  competitive: { chill: -4, intense: 4 },
  pvp: { chill: -4, intense: 4 },
  "fast-paced": { chill: -4, intense: 4 },
  "fast paced": { chill: -4, intense: 4 },
  difficult: { chill: -3, intense: 4 },
  stealth: { chill: -2, intense: 2 },
  "bullet hell": { chill: -4, intense: 5 },
  roguelike: { intense: 3 },
  roguelite: { intense: 3 },

  action: { intense: 1 },
  adventure: {},
  simulation: {},
  rpg: { "brain-off": -1 }
};

const MOOD_THRESHOLD = 3;

export function deriveMoodScores(labels: string[]): VaultMoodScores {
  const tags = new Set(labels.map(normalizeTag).filter(Boolean));
  const scores: VaultMoodScores = { "brain-off": 0, chill: 0, intense: 0 };

  for (const tag of tags) {
    const rule = MOOD_RULES[tag];
    if (!rule) continue;
    scores["brain-off"] += rule["brain-off"] ?? 0;
    scores.chill += rule.chill ?? 0;
    scores.intense += rule.intense ?? 0;
  }

  if (hasAll(tags, "action", "horror")) scores.intense += 3;
  if (hasAny(tags, "shooter", "fps") && hasAny(tags, "competitive", "pvp", "battle royale")) scores.intense += 3;
  if (hasAny(tags, "shooter", "fps") && hasAny(tags, "arcade", "casual")) scores["brain-off"] += 2;
  if (hasAny(tags, "simulation", "simulator") && hasAny(tags, "farming", "cozy")) scores.chill += 3;
  if (hasAny(tags, "simulation", "simulator") && hasAny(tags, "management", "strategy")) scores["brain-off"] -= 3;
  if (hasAll(tags, "adventure", "exploration")) scores.chill += 2;
  if (hasAny(tags, "rpg", "role-playing") && hasAny(tags, "tactical", "strategy")) scores["brain-off"] -= 3;
  if (hasAny(tags, "roguelike", "roguelite") && hasAny(tags, "action", "hack and slash", "arcade")) {
    scores["brain-off"] += 2;
    scores.intense += 2;
  }

  return {
    "brain-off": clamp(scores["brain-off"], -10, 10),
    chill: clamp(scores.chill, -10, 10),
    intense: clamp(scores.intense, -10, 10)
  };
}

/**
 * The tags that actually pushed a game toward a mood, strongest first.
 *
 * The scores alone can say a game is Brain-Off but never why, which makes the
 * strongest claim on the result screen the least believable one. This reads the
 * same MOOD_RULES the score came from, so the explanation cannot drift from the
 * number it is explaining.
 */
export function moodContributors(labels: string[], mood: VaultMoodId, limit = 3): string[] {
  const seen = new Set<string>();
  const contributions: Array<{ label: string; weight: number }> = [];

  for (const label of labels) {
    const tag = normalizeTag(label);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    const weight = MOOD_RULES[tag]?.[mood] ?? 0;
    if (weight > 0) contributions.push({ label, weight });
  }

  return contributions
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit)
    .map((contribution) => contribution.label);
}

export function moodTagsFromScores(scores: VaultMoodScores): VaultMoodId[] {
  return (["brain-off", "chill", "intense"] as const).filter((mood) => scores[mood] >= MOOD_THRESHOLD);
}

/**
 * Which sessions a game can reasonably be played in.
 *
 * Fits run upward, not into a single bucket. Time available is a ceiling, not a
 * target: a three-hour game is a perfectly good pick for a free weekend, while a
 * hundred-hour game is a bad pick for a short evening. Assigning each game to
 * exactly one band meant choosing "Evening" discarded roughly seven games in ten
 * before scoring ever ran, which is most of why draws felt so narrow.
 *
 * Preference between eligible games is scoring's job — see sessionPoints, which
 * still rewards the length that actually matches the session.
 */
export function deriveSessionFits({
  duration,
  completionPercent,
  endless,
  sessionability = 0
}: {
  duration?: GameDurationEstimate | null;
  completionPercent: number;
  endless: boolean;
  /** See lib/sessionability.ts. Zero when the tags say nothing. */
  sessionability?: number;
}): VaultSessionId[] {
  if (endless) return ["short", "evening", "weekend"];

  const lean = sessionLean(sessionability);

  // A game whose sessions stand on their own suits a short sitting however long
  // it runs in total: a fifty-hour roguelike is a fine forty minutes, because a
  // run is twenty and finishing one is a real ending.
  if (lean === "pick-up") return ["short", "evening", "weekend"];

  // An unknown length is not evidence of a long game. Confining these to
  // "weekend" hid a third of a real library from every other session.
  const totalMinutes = estimatedTimeToBeatMinutes(duration);
  if (!totalMinutes) return ["short", "evening", "weekend"];

  const remainingRatio = Math.max(0.05, 1 - clamp(completionPercent, 0, 99) / 100);
  const remainingHours = (totalMinutes * remainingRatio) / 60;

  // And a game that wants an uninterrupted run at it is a poor short sitting
  // even when it is brief. Stopping a two-hour narrative game halfway is the
  // worst way to play it.
  if (remainingHours <= 10) return lean === "sit-down" ? ["evening", "weekend"] : ["short", "evening", "weekend"];
  if (remainingHours <= 30) return ["evening", "weekend"];
  return ["weekend"];
}

function normalizeTag(value: string) {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function hasAll(tags: Set<string>, ...values: string[]) {
  return values.every((value) => tags.has(value));
}

function hasAny(tags: Set<string>, ...values: string[]) {
  return values.some((value) => tags.has(value));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
