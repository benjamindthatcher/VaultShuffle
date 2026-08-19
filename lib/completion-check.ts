import type { DemoGame } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";

/**
 * Games the playtime says you have almost certainly finished.
 *
 * This used to live inside Purge, filed under a category literally named
 * "untouched", behind a 180-day idle gate, as one of four equal buttons. That
 * merged two different questions: "did you finish this" is a fact you know
 * instantly, while "should this stay in the draw pool" is a judgement. Mixing
 * them made the fast, rewarding one inherit the slow, deliberate pacing of the
 * chore — which is why a real library ended up with 23 unclaimed completions
 * worth $284 sitting untouched.
 *
 * Nothing here ever marks a game complete on its own. It only decides what is
 * worth asking about, and in what order.
 */

export type CompletionCandidate = {
  game: DemoGame;
  hoursPlayed: number;
  estimatedHours: number;
  /** 0-1. How confident the playtime alone makes us. */
  confidence: number;
  reason: string;
};

/**
 * Below two hours the duration estimate is usually junk rather than a short
 * game: Euro Truck Simulator 2 is stored as a finite one-hour game, so a naive
 * rule "asks" whether you finished it after 24 hours of driving.
 */
const MIN_CREDIBLE_ESTIMATE_MINUTES = 120;

/** Enough of the estimate to be worth asking about. */
const FINISHED_RATIO = 0.9;

/**
 * Re-asking after a dismissal needs new evidence, not just a new day. The
 * dismissal records the playtime at the time, so we only ask again once another
 * real session has gone in.
 */
const REASK_AFTER_EXTRA_HOURS = 5;

export function findCompletionCandidates(games: DemoGame[], now = new Date()): CompletionCandidate[] {
  const candidates: CompletionCandidate[] = [];

  for (const game of games) {
    if (game.ownership !== "Owned") continue;
    if (game.status === "Completed" || game.status === "Slept") continue;
    if (game.duration?.endless) continue;

    const estimateMinutes = estimatedTimeToBeatMinutes(game.duration);
    if (!estimateMinutes || estimateMinutes < MIN_CREDIBLE_ESTIMATE_MINUTES) continue;

    const hoursPlayed = Number(game.hoursPlayed ?? 0);
    const estimatedHours = estimateMinutes / 60;
    if (hoursPlayed < estimatedHours * FINISHED_RATIO) continue;

    if (isDismissed(game, hoursPlayed)) continue;

    const ratio = hoursPlayed / estimatedHours;
    candidates.push({
      game,
      hoursPlayed,
      estimatedHours,
      confidence: confidenceFor(ratio),
      reason: reasonFor(hoursPlayed, estimatedHours, ratio)
    });
  }

  // Most certain first, then by what it is worth, so the easy wins come first and
  // the sweep feels like claiming rather than grinding.
  return candidates.sort((left, right) =>
    right.confidence - left.confidence || priceOf(right.game) - priceOf(left.game));
}

function isDismissed(game: DemoGame, hoursPlayed: number) {
  if (!game.completionSuggestionDismissedAt) return false;
  const dismissedAt = Number(game.completionSuggestionDismissedPlaytime ?? 0);
  return hoursPlayed < dismissedAt + REASK_AFTER_EXTRA_HOURS;
}

/**
 * Peaks around the estimate and eases off well beyond it. A long way past the
 * estimate is still worth asking — plenty of people finish a game and keep
 * playing — but it is also what an endless game looks like, so it should not
 * lead the queue.
 */
function confidenceFor(ratio: number) {
  if (ratio <= 1.5) return 1;
  if (ratio <= 2.5) return 0.8;
  if (ratio <= 4) return 0.6;
  return 0.4;
}

function reasonFor(hoursPlayed: number, estimatedHours: number, ratio: number) {
  const played = Math.round(hoursPlayed);
  const estimate = Math.round(estimatedHours);
  if (ratio >= 2) return `${played}h played against a ${estimate}h campaign — well past the credits.`;
  return `${played}h played against a ${estimate}h campaign.`;
}

function priceOf(game: DemoGame) {
  if (game.isFree) return 0;
  return Number(game.priceInitial ?? 0) || 0;
}

/** Total shelf value of everything waiting to be claimed. */
export function completionCandidateValue(candidates: CompletionCandidate[]) {
  return candidates.reduce((total, candidate) => total + priceOf(candidate.game), 0);
}
