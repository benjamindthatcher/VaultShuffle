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
const PREFERENCE_REASON_THRESHOLD = 2.5;

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
  /** Population rates, same shape, aggregated across all users. */
  globals: GenrePreferenceIndex | null;
  genreWeights: GenreWeightIndex | null;
};

/**
 * Weight given to the population when standing in for a user who has no evidence
 * of their own. Deliberately light: shared taste is a starting point, not a
 * claim about this person.
 */
const POPULATION_PRIOR_STRENGTH = 4;

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
/**
 * Tags that describe how a game was funded or priced rather than how it plays.
 * Both map onto Casual for display, which is a reasonable shelf to file them
 * under, but it made the learner read "owns Hollow Knight" as evidence of a
 * taste for Casual games. Indie is a funding model and Free to Play is a
 * pricing one; neither says anything about what a session feels like.
 *
 * Excluded from learning only. The Vault filter still treats Indie as its own
 * thing, and display genres are untouched — at these volumes one contaminated
 * broad category is enough to move the whole model.
 */
const NON_GAMEPLAY_LEARNING_TAGS = new Set(["indie", "free to play", "free-to-play", "freetoplay"]);

/**
 * What one game teaches, as a set of keys the learner tallies against.
 *
 * This used to return only the top-level genre, and the resolution that cost is
 * the whole reason the model says so little: across two thousand draws the
 * entire spread between the best and worst of the eight buckets was seven
 * percentage points. Everything is Action or Adventure, so nothing is.
 *
 * The specific labels come back too. They are already on every game - the view
 * model puts up to eight Steam tag labels on `genres` alongside the coarse ones
 * - so this reads better evidence out of data the client is already carrying,
 * with nothing new to fetch or store.
 *
 * Both levels are kept rather than swapping one for the other. A tag is sharp
 * but thin, a top-level genre is blunt but always has evidence behind it, and
 * the adjustment averages over whatever matched: the coarse key answers when a
 * game's tags are unfamiliar, and the sharp ones decide when they are not.
 * buildGenreWeightIndex already discounts by how common a key is, so the broad
 * ones cannot drown out the distinctive ones just by turning up more often.
 */
export function preferenceGenresFor(genres: string[], title = ""): string[] {
  const gameplayOnly = genres.filter((genre) => !NON_GAMEPLAY_LEARNING_TAGS.has(genre.trim().toLowerCase()));
  const topLevel = topLevelGenresFor(gameplayOnly.join(" / "), title);
  const keys = [...topLevel, ...gameplayOnly].map(canonicalPreferenceGenre).filter(Boolean);
  return [...new Set(keys)];
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

function rowFor(index: GenrePreferenceIndex | null, genre: string, context: GenrePreferenceContext) {
  const row = index?.get(preferenceKey(genre, context));
  return row && row.total > 0 ? row : null;
}

/** The population's overall response rate, the root of the whole hierarchy. */
function populationBaseline(globals: GenrePreferenceIndex | null) {
  const row = rowFor(globals, BASELINE_GENRE, ANY_MOOD_CONTEXT);
  // 0.5 remains the root prior, but now only the population is measured against
  // it. No individual is judged by it any more.
  return row ? shrunkRate(row.positive, row.total, 0.5) : 0.5;
}

/**
 * What the population thinks of this genre, expressed as a rate. Used to give a
 * user with no evidence of their own a starting point other than "no opinion".
 */
function populationGenreRate(globals: GenrePreferenceIndex | null, genre: string, populationRate: number) {
  const row = rowFor(globals, genre, ANY_MOOD_CONTEXT);
  return row ? shrunkRate(row.positive, row.total, populationRate, POPULATION_PRIOR_STRENGTH) : populationRate;
}

/**
 * The user's own rate of responding well, which is what a genre is judged against.
 *
 * Anchoring on a fixed 0.5 was wrong: rerolling is the ordinary way to use the
 * Vault and most draws produce no positive event at all, so a genre drawing a
 * perfectly typical response still scored negative, and every genre with evidence
 * ranked below every genre without any.
 */
function baselineRate(index: GenrePreferenceIndex, mood: VaultMoodId | null, populationRate: number) {
  const general = rowFor(index, BASELINE_GENRE, ANY_MOOD_CONTEXT);
  const generalRate = general ? shrunkRate(general.positive, general.total, populationRate) : populationRate;
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
function genreRate(
  index: GenrePreferenceIndex,
  genre: string,
  mood: VaultMoodId | null,
  baseline: number,
  genrePrior: number
) {
  const general = rowFor(index, genre, ANY_MOOD_CONTEXT);
  const generalRate = general ? shrunkRate(general.positive, general.total, genrePrior) : genrePrior;
  if (!mood) return { rate: generalRate, moodScoped: false };

  const scoped = rowFor(index, genre, mood);
  if (!scoped) return { rate: generalRate, moodScoped: false };
  return { rate: shrunkRate(scoped.positive, scoped.total, generalRate), moodScoped: true };
}

/**
 * Transfers the population's opinion of a genre onto this user's own baseline,
 * as a log-odds offset so it survives users whose overall rate is nothing like
 * average and can never push a prior outside (0, 1). Adding rates directly did:
 * for a user with a low baseline the offset drove every prior negative, where
 * clamping flattened them all onto the same floor and destroyed the very
 * differences the term exists to express.
 *
 * A user with no evidence of their own lands exactly on the population rate,
 * which is the cold-start behaviour: day one they inherit shared taste, and it is
 * shrunk away as soon as they generate anything of their own.
 */
function genrePriorFor(baseline: number, populationRate: number, populationGenre: number) {
  return sigmoid(logit(baseline) + (logit(populationGenre) - logit(populationRate)));
}

/**
 * Log-odds difference between a genre and the baseline, squashed into the bound.
 *
 * Rates are compared in log-odds rather than directly. Proportional distance
 * ((rate - baseline) / baseline) is ill-conditioned when the baseline is small:
 * as it approaches zero every genre saturates at the cap and the differences
 * between them — the only part that affects selection — are crushed out. Log-odds
 * is well behaved near both boundaries and symmetric by construction, so the
 * separate normalisation above and below the baseline is no longer needed.
 */
function pointsForRate(rate: number, baseline: number) {
  const difference = logit(rate) - logit(baseline);
  return VAULT_PREFERENCE_MAX_POINTS * Math.tanh(difference / PREFERENCE_LOG_ODDS_SCALE);
}

/**
 * A log-odds difference of this size maps to ~76% of the bound — roughly a 20x
 * odds ratio against the user's own baseline before the term is nearly maxed.
 */
const PREFERENCE_LOG_ODDS_SCALE = 3;

const RATE_EPSILON = 1e-6;

function logit(rate: number) {
  const bounded = Math.min(1 - RATE_EPSILON, Math.max(RATE_EPSILON, rate));
  return Math.log(bounded / (1 - bounded));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
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
  const globals = context?.globals ?? null;
  // Either source alone is enough to say something: a user with no history of
  // their own can still be served the population's view.
  if (!index || (index.size === 0 && !globals?.size)) return NO_ADJUSTMENT;

  const genres = preferenceGenresFor(gameGenres, title);
  if (!genres.length) return NO_ADJUSTMENT;

  const populationRate = populationBaseline(globals);
  const baseline = baselineRate(index, mood, populationRate);
  let weightedPoints = 0;
  let weightTotal = 0;
  let strongest: { points: number; genre: string; moodScoped: boolean } | null = null;

  for (const genre of genres) {
    const hasEvidence = rowFor(index, genre, ANY_MOOD_CONTEXT)
      || (mood && rowFor(index, genre, mood))
      || rowFor(globals, genre, ANY_MOOD_CONTEXT);
    if (!hasEvidence) continue;

    const genrePrior = genrePriorFor(baseline, populationRate, populationGenreRate(globals, genre, populationRate));
    const { rate, moodScoped } = genreRate(index, genre, mood, baseline, genrePrior);
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

/**
 * Only positive preferences are explained.
 *
 * reasons[] justifies the game that was drawn, so a negative line is
 * anti-justification: "Casual usually gets rerolled" printed under a Casual game
 * the Vault just chose tells the user their pick is bad without giving them
 * anything to do about it. The negative still shapes the draw, it just does not
 * argue against the result it produced.
 */
function preferenceReason(
  points: number,
  strongest: { points: number; genre: string; moodScoped: boolean },
  mood: VaultMoodId | null
) {
  if (points < PREFERENCE_REASON_THRESHOLD) return null;

  const genre = displayPreferenceGenre(strongest.genre);
  const context = strongest.moodScoped && mood ? ` when ${moodLabel(mood)}` : "";
  return `${genre} lands well for you${context}`;
}

/**
 * Keep only each account's most recent decisions.
 *
 * The completion sweep is built for clearing a backlog in bulk: the median
 * account has marked 21 games finished, one has marked 443. Ungated, that single
 * account outweighs twenty ordinary ones in the population view, and what it
 * describes is a weekend of tidying rather than twenty people's taste.
 *
 * Newest first, so what survives the cap is what someone thinks now rather than
 * whatever happened to be at the top of their library.
 */
export function capDecisionsPerUser<T extends { userId: string; reviewedAt: string }>(
  decisions: readonly T[],
  limit: number
): T[] {
  if (limit <= 0) return [];

  const byUser = new Map<string, T[]>();
  for (const decision of decisions) {
    const held = byUser.get(decision.userId);
    if (held) held.push(decision); else byUser.set(decision.userId, [decision]);
  }

  const kept: T[] = [];
  for (const forUser of byUser.values()) {
    kept.push(...[...forUser].sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt)).slice(0, limit));
  }
  return kept;
}
