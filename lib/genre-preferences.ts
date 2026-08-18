import type { VaultMoodId } from "./demo-data.ts";
import { topLevelGenresFor } from "./genres.ts";

/**
 * How far a learned preference may tilt the draw.
 *
 * Calibrated against VAULT_SELECTION_TEMPERATURE (15) rather than the 0-100 score
 * range, because the temperature is what actually decides how much a point is
 * worth: at ±8 the widest possible spread between two finalists is 16 points,
 * which is an odds ratio of e^(16/15) ≈ 2.9. That is a real tilt without letting
 * a learned guess dominate a game the user explicitly asked for.
 *
 * The term is deliberately kept out of the ranking used to build the deck and the
 * finalist slice — see buildVaultPool. Ranking is truncated twice (32 then ~13),
 * so a term that moved the ordering would silently make disfavoured games
 * undrawable rather than merely less likely.
 */
export const VAULT_PREFERENCE_MAX_POINTS = 8;

/**
 * Below this the preference is too weak to be worth a line of explanation. Set
 * above what a single event can produce, so the UI never claims a pattern from one
 * data point.
 */
const PREFERENCE_REASON_THRESHOLD = 2;

/**
 * Strength of the prior, in weighted event units. A genre needs roughly this much
 * evidence before it moves halfway from its prior to its own observed rate.
 *
 * Eight is four strong events, deliberately more than the two units a single
 * like is worth: one enthusiastic evening should be visible in the numbers and
 * still not be enough to reorder anything.
 */
const PRIOR_STRENGTH = 8;

/** The mood-agnostic bucket, used as the prior for each mood-specific one. */
export const ANY_MOOD_CONTEXT = "any";

/** Sentinel row holding the user's own overall rate rather than a genre's. */
export const BASELINE_GENRE = "__baseline__";

export type GenrePreferenceContext = VaultMoodId | typeof ANY_MOOD_CONTEXT;

export type GenrePreference = {
  genre: string;
  contextMood: GenrePreferenceContext;
  positive: number;
  total: number;
};

export type GenrePreferenceIndex = Map<string, GenrePreference>;

/** Inverse-frequency weight per genre, so common genres carry less credit. */
export type GenreWeightIndex = Map<string, number>;

export type GenrePreferenceContextData = {
  index: GenrePreferenceIndex;
  genreWeights: GenreWeightIndex | null;
};

/**
 * Shrinks an observed rate toward a prior. With no evidence the result *is* the
 * prior, which is what makes an unseen genre score exactly neutral instead of
 * accidentally looking better than a genre the user has actually rejected.
 */
export function shrunkRate(positive: number, total: number, prior: number, strength = PRIOR_STRENGTH) {
  return (positive + strength * prior) / (total + strength);
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

/**
 * Inverse document frequency over whatever corpus is to hand, normalised so the
 * average weight is 1 and the overall strength of the term is unchanged.
 *
 * Without this, Action (on 54% of the catalogue) earns as much credit as a genre
 * that actually distinguishes one game from another, so liking a single action
 * game teaches the model far more than it should.
 */
export function buildGenreWeightIndex(gamesGenres: Array<{ genres: string[]; title: string }>): GenreWeightIndex {
  const documentCount = gamesGenres.length;
  const weights: GenreWeightIndex = new Map();
  if (!documentCount) return weights;

  const frequency = new Map<string, number>();
  for (const game of gamesGenres) {
    for (const genre of new Set(preferenceGenresFor(game.genres, game.title))) {
      frequency.set(genre, (frequency.get(genre) ?? 0) + 1);
    }
  }
  if (!frequency.size) return weights;

  for (const [genre, count] of frequency) {
    weights.set(genre, Math.log(1 + documentCount / Math.max(1, count)));
  }

  const mean = [...weights.values()].reduce((total, weight) => total + weight, 0) / weights.size;
  if (mean > 0) for (const [genre, weight] of weights) weights.set(genre, weight / mean);
  return weights;
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

function rowFor(index: GenrePreferenceIndex, genre: string, context: GenrePreferenceContext) {
  const row = index.get(preferenceKey(genre, context));
  return row && row.total > 0 ? row : null;
}

/**
 * The user's own rate of responding well, which is what a genre is judged against.
 *
 * Anchoring on a fixed 0.5 was wrong: rerolling is the ordinary way to use the
 * Vault and most draws produce no positive event at all, so a genre drawing a
 * perfectly typical response still scored negative, and every genre with evidence
 * ranked below every genre without any.
 */
function baselineRate(index: GenrePreferenceIndex, mood: VaultMoodId | null) {
  const general = rowFor(index, BASELINE_GENRE, ANY_MOOD_CONTEXT);
  const generalRate = general ? shrunkRate(general.positive, general.total, 0.5) : 0.5;
  if (!mood) return generalRate;

  const scoped = rowFor(index, BASELINE_GENRE, mood);
  return scoped ? shrunkRate(scoped.positive, scoped.total, generalRate) : generalRate;
}

/**
 * Two-level shrinkage: the mood-agnostic row is the prior for the mood-specific
 * one, which is itself shrunk toward the user's baseline.
 *
 * The previous hard switch on `total > 0` let a single event in one mood override
 * twenty in the general row. Blending means the mood context only takes over as
 * fast as it earns the right to.
 */
function genreRate(index: GenrePreferenceIndex, genre: string, mood: VaultMoodId | null, baseline: number) {
  const general = rowFor(index, genre, ANY_MOOD_CONTEXT);
  const generalRate = general ? shrunkRate(general.positive, general.total, baseline) : baseline;
  if (!mood) return { rate: generalRate, moodScoped: false };

  const scoped = rowFor(index, genre, mood);
  if (!scoped) return { rate: generalRate, moodScoped: false };
  return { rate: shrunkRate(scoped.positive, scoped.total, generalRate), moodScoped: true };
}

/**
 * Maps a rate onto points, normalised separately above and below the baseline.
 *
 * The distance from the baseline to 1 and to 0 are not equal — for a user who
 * launches a fifth of their draws there is four times as much room above as
 * below — so a single linear factor would make positives dwarf negatives.
 */
function pointsForRate(rate: number, baseline: number) {
  if (rate >= baseline) {
    const headroom = 1 - baseline;
    return headroom <= 0 ? 0 : VAULT_PREFERENCE_MAX_POINTS * ((rate - baseline) / headroom);
  }
  return baseline <= 0 ? 0 : VAULT_PREFERENCE_MAX_POINTS * ((rate - baseline) / baseline);
}

export type GenrePreferenceAdjustment = { points: number; reason: string | null };

const NO_ADJUSTMENT: GenrePreferenceAdjustment = { points: 0, reason: null };

/**
 * The single additive term the recommender learns. Averaged across the game's
 * top-level genres, weighted by how discriminative each genre is, so a game
 * cannot collect a bonus simply for carrying more labels.
 */
export function genrePreferenceAdjustment(
  context: GenrePreferenceContextData | null,
  gameGenres: string[],
  title: string,
  mood: VaultMoodId | null
): GenrePreferenceAdjustment {
  const index = context?.index;
  if (!index || index.size === 0) return NO_ADJUSTMENT;

  const genres = preferenceGenresFor(gameGenres, title);
  if (!genres.length) return NO_ADJUSTMENT;

  const baseline = baselineRate(index, mood);
  let weightedPoints = 0;
  let weightTotal = 0;
  let strongest: { points: number; genre: string; moodScoped: boolean } | null = null;

  for (const genre of genres) {
    const hasEvidence = rowFor(index, genre, ANY_MOOD_CONTEXT) || (mood && rowFor(index, genre, mood));
    if (!hasEvidence) continue;

    const { rate, moodScoped } = genreRate(index, genre, mood, baseline);
    const points = pointsForRate(rate, baseline);
    const weight = context.genreWeights?.get(genre) ?? 1;

    weightedPoints += points * weight;
    weightTotal += weight;
    if (!strongest || Math.abs(points) > Math.abs(strongest.points)) {
      strongest = { points, genre, moodScoped };
    }
  }

  if (!weightTotal || !strongest) return NO_ADJUSTMENT;

  const points = weightedPoints / weightTotal;
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
