import type { VaultMoodId } from "./demo-data.ts";
import { topLevelGenresFor } from "./genres.ts";

/**
 * How far a learned genre preference may move a score that is otherwise 0-100.
 * Deliberately small: the session/mood/goal match is what the user actually asked
 * for, and a preference is only ever a tiebreaker between games that already fit.
 */
export const VAULT_PREFERENCE_MAX_POINTS = 15;

/** Below this the preference is too weak to be worth a line of explanation. */
const PREFERENCE_REASON_THRESHOLD = 3;

/** The mood-agnostic bucket, used when the mood-specific one has nothing to say. */
export const ANY_MOOD_CONTEXT = "any";

export type GenrePreferenceContext = VaultMoodId | typeof ANY_MOOD_CONTEXT;

export type GenrePreference = {
  genre: string;
  contextMood: GenrePreferenceContext;
  positive: number;
  total: number;
};

export type GenrePreferenceIndex = Map<string, GenrePreference>;

/**
 * Laplace-style smoothing towards 0.5 (neutral). The +2/+4 is what stops a single
 * event creating a preference: one "liked" lands at 4/6, not 1/1, so it nudges
 * rather than declares.
 */
export function smoothedPreference(positive: number, total: number) {
  return (positive + 2) / (total + 4);
}

export function preferenceKey(genre: string, contextMood: GenrePreferenceContext) {
  return `${contextMood}::${genre}`;
}

export function buildGenrePreferenceIndex(preferences: GenrePreference[]): GenrePreferenceIndex {
  return new Map(preferences.map((preference) => [
    preferenceKey(preference.genre, preference.contextMood),
    preference
  ]));
}

/**
 * Preferences are keyed on top-level genres rather than the full tag list. The
 * tag list runs to eight entries per game, which with a handful of users spreads
 * every signal across buckets too thin to ever mean anything; the nine top-level
 * genres actually accumulate. Both this and the nightly worker route through
 * topLevelGenresFor so the keys cannot drift apart.
 */
export function preferenceGenresFor(genres: string[], title = ""): string[] {
  return topLevelGenresFor(genres.join(" / "), title).map(canonicalPreferenceGenre);
}

export function canonicalPreferenceGenre(value: string) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function displayPreferenceGenre(value: string) {
  if (value === "rpg") return "RPG";
  return value.replace(/(^|-)([a-z])/g, (_match, separator: string, letter: string) =>
    `${separator ? " " : ""}${letter.toUpperCase()}`);
}

function moodLabel(mood: VaultMoodId) {
  if (mood === "brain-off") return "Brain-Off";
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}

/**
 * Resolves the context-scoped row first and only falls back to the mood-agnostic
 * one when the specific context has no evidence, because "likes RPGs when Intense"
 * is a sharper statement than "likes RPGs" and should win where it exists.
 */
function lookupPreference(
  index: GenrePreferenceIndex,
  genre: string,
  mood: VaultMoodId | null
): { preference: GenrePreference; moodScoped: boolean } | null {
  if (mood) {
    const scoped = index.get(preferenceKey(genre, mood));
    if (scoped && scoped.total > 0) return { preference: scoped, moodScoped: true };
  }
  const general = index.get(preferenceKey(genre, ANY_MOOD_CONTEXT));
  if (general && general.total > 0) return { preference: general, moodScoped: false };
  return null;
}

export type GenrePreferenceAdjustment = { points: number; reason: string | null };

const NO_ADJUSTMENT: GenrePreferenceAdjustment = { points: 0, reason: null };

/**
 * The single additive term the recommender learns. Averaged across the game's
 * top-level genres so a three-genre game cannot collect three times the bonus of
 * a one-genre game.
 */
export function genrePreferenceAdjustment(
  index: GenrePreferenceIndex | null,
  gameGenres: string[],
  title: string,
  mood: VaultMoodId | null
): GenrePreferenceAdjustment {
  if (!index || index.size === 0) return NO_ADJUSTMENT;

  const genres = preferenceGenresFor(gameGenres, title);
  if (!genres.length) return NO_ADJUSTMENT;

  let pointsTotal = 0;
  let matched = 0;
  let strongest: { points: number; genre: string; moodScoped: boolean } | null = null;

  for (const genre of genres) {
    const hit = lookupPreference(index, genre, mood);
    if (!hit) continue;

    const smoothed = smoothedPreference(hit.preference.positive, hit.preference.total);
    const points = (smoothed - 0.5) * 2 * VAULT_PREFERENCE_MAX_POINTS;
    pointsTotal += points;
    matched += 1;
    if (!strongest || Math.abs(points) > Math.abs(strongest.points)) {
      strongest = { points, genre, moodScoped: hit.moodScoped };
    }
  }

  if (!matched || !strongest) return NO_ADJUSTMENT;

  const points = pointsTotal / matched;
  return { points, reason: preferenceReason(points, strongest, mood) };
}

function preferenceReason(
  points: number,
  strongest: { points: number; genre: string; moodScoped: boolean },
  mood: VaultMoodId | null
) {
  if (Math.abs(points) < PREFERENCE_REASON_THRESHOLD) return null;

  const genre = displayPreferenceGenre(strongest.genre);
  const context = strongest.moodScoped && mood ? ` when ${moodLabel(mood)}` : "";
  return points > 0 ? `${genre} lands well for you${context}` : `${genre} usually gets rerolled${context}`;
}
