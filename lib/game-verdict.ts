import { shrunkRate } from "./genre-preferences.ts";

/**
 * What everyone did with one specific game.
 *
 * Genres could not see what is wrong with the games people complain about.
 * Hellblade's VR Edition was slept by 10 of the 10 people who met it, Resident
 * Evil Resistance by 13 of 13, Conan Exiles' beta client by 17 of 17. Every one
 * of those shares its tags with a game worth playing, so no amount of tag
 * resolution reaches them - only the game itself does.
 *
 * This is about the game rather than about you, which is why it sits beside
 * appeal rather than with learned taste: it applies to everybody, and it applies
 * in both arms of the preference experiment.
 */

export type GameVerdict = [positive: number, total: number];
export type GameVerdicts = Record<string, GameVerdict>;

/**
 * How much evidence it takes to move a game off what it looks like on paper.
 *
 * Below this the shrinkage keeps a game near the population's average and its
 * own reviews carry the pick, which is the honest reading of two people having
 * an opinion. By about fifty it is being judged on what people actually did.
 */
const VERDICT_PRIOR_STRENGTH = 8;

/**
 * Bounded like the appeal penalty rather than the appeal bonus.
 *
 * A game everybody set aside is the clearest "do not offer this" the product
 * can observe, and at the selection temperature of 15 the full penalty leaves it
 * at about half the odds of an equally fitting game. Praise is capped tighter:
 * that people finished a game is not a reason to put it ahead of one that
 * actually suits the evening.
 */
export const MAX_VERDICT_POINTS = 6;
export const MAX_VERDICT_PENALTY = 10;

/** A log-odds gap of this size reaches ~76% of the bound. Matches the taste term. */
const VERDICT_LOG_ODDS_SCALE = 3;
const RATE_EPSILON = 1e-6;

function logit(rate: number) {
  const bounded = Math.min(1 - RATE_EPSILON, Math.max(RATE_EPSILON, rate));
  return Math.log(bounded / (1 - bounded));
}

/**
 * What an ordinary game looks like, so a specific one can be measured against it.
 *
 * Taken from the games in front of us rather than a constant: the mix of signals
 * feeding these tallies changes as the product does, and a fixed reference would
 * quietly start describing something else. Falls back to even odds when there is
 * nothing to average.
 */
export function verdictBaseline(verdicts: GameVerdicts): number {
  let positive = 0;
  let total = 0;
  for (const [gamePositive, gameTotal] of Object.values(verdicts)) {
    if (!Number.isFinite(gamePositive) || !Number.isFinite(gameTotal) || gameTotal <= 0) continue;
    positive += gamePositive;
    total += gameTotal;
  }
  return total > 0 ? Math.min(1, Math.max(0, positive / total)) : 0.5;
}

/**
 * The population's verdict on one game, in points.
 *
 * Zero whenever nothing is known, which is the normal case and always will be:
 * a game released tomorrow has no verdict, and what it is on paper decides the
 * pick until one exists.
 */
export function verdictPoints(
  verdict: GameVerdict | undefined | null,
  baseline: number
): number {
  if (!verdict) return 0;
  const [positive, total] = verdict;
  if (!Number.isFinite(positive) || !Number.isFinite(total) || total <= 0) return 0;

  const rate = shrunkRate(positive, total, baseline, VERDICT_PRIOR_STRENGTH);
  const difference = logit(rate) - logit(baseline);
  const bound = difference < 0 ? MAX_VERDICT_PENALTY : MAX_VERDICT_POINTS;
  return bound * Math.tanh(difference / VERDICT_LOG_ODDS_SCALE);
}

export function verdictFor(verdicts: GameVerdicts | null | undefined, steamAppId: number | null | undefined) {
  if (!verdicts || !steamAppId) return null;
  return verdicts[String(steamAppId)] ?? null;
}
