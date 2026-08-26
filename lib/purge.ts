import type { DemoGame } from "./demo-data.ts";
import { formatGameDuration } from "./game-duration.ts";
import { appealDetail, appealLabel, gameAppeal } from "./game-appeal.ts";
import { idleForAtLeast, type GameRecency } from "./recency.ts";

/**
 * What Purge can do now. "complete" is deliberately absent: whether you finished
 * something is a fact you already know, not a judgement about your draw pool, and
 * mixing the two buried the quick rewarding question inside the slow one. It
 * lives in the completion sweep instead.
 */
export type PurgeAction = "keep" | "pin" | "sleep";

/** Includes "complete" so historical reviews taken before the split still read. */
export type PurgeReviewAction = PurgeAction | "complete";
export type PurgeReview = {
  id: string;
  gameId: string;
  action: PurgeReviewAction;
  reviewedAt: string;
};
/**
 * Evidence that makes the decision, rather than leaving the player to guess.
 * `leaning` says which way it points, so the UI can colour a reason to cut
 * differently from a reason to keep.
 */
export type PurgeSignal = {
  label: string;
  detail: string;
  leaning: "cut" | "keep";
};

export type PurgeCandidate = {
  game: DemoGame;
  reason: string;
  signal: PurgeSignal | null;
  /** Higher means an easier call to make. Drives queue order. */
  confidence: number;
};

/**
 * Whether a recorded decision has since been reversed somewhere else.
 *
 * `purge_reviews` is an append-only audit log and the only thing that deletes a
 * row is the in-session "Undo last decision" button. Waking a slept game from the
 * Library, or restoring one after a draw, changes the game and leaves the review
 * untouched — so the page went on advertising "Put to sleep" beside a game that
 * was plainly active again.
 *
 * Judged on status alone, because status is what a decision changes. Pin is
 * treated as Keep: unpinning is a change of mind about placement, not about
 * whether the game stays in the library.
 */
export function isReviewSuperseded(action: PurgeReviewAction, status: DemoGame["status"]) {
  if (action === "sleep") return status !== "Slept";
  if (action === "complete") return status !== "Completed";
  return status === "Slept" || status === "Completed";
}

/** How long a started game must have gone untouched before it is worth reviewing. */
const PURGE_IDLE_DAYS = 180;

export function buildPurgeCandidates({
  games,
  pinnedIds,
  currentPickId,
  snoozedIds,
  reviews = [],
  likelyFinishedIds,
  now = new Date()
}: {
  games: DemoGame[];
  pinnedIds: string[];
  currentPickId: string | null;
  snoozedIds: string[];
  reviews?: PurgeReview[];
  /** Games already queued for the completion sweep; Purge must not ask about them too. */
  likelyFinishedIds?: Set<string>;
  now?: Date;
}): PurgeCandidate[] {
  const protectedIds = new Set([
    ...pinnedIds,
    ...snoozedIds,
    ...(currentPickId ? [currentPickId] : [])
  ]);
  const recentlyKept = new Set(
    reviews
      .filter(
        (review) =>
          review.action === "keep" &&
          now.getTime() - Date.parse(review.reviewedAt) < 180 * 86400000
      )
      .map((review) => review.gameId)
  );
  const recentlyActioned = new Set(
    reviews
      .filter(
        (review) =>
          review.action !== "keep" &&
          now.getTime() - Date.parse(review.reviewedAt) < 5 * 60000
      )
      .map((review) => review.gameId)
  );
  const result: PurgeCandidate[] = [];

  for (const game of games) {
    // Asked for by hand, which overrides everything the queue would otherwise
    // use to leave this one alone.
    //
    // The flag was read further down, to word the reason - but the exclusions
    // above ran first, so a game you had kept was dropped by its own keep before
    // the flag was ever consulted, for the 180 days that keep stands. Which is
    // the whole set of games the Reviewed tab offers to flag.
    //
    // It overrides the cooldowns, which exist to stop the queue nagging you
    // about something you have just decided - a rule about the queue's own
    // judgement, not about yours. It does not override a pin, a snooze or the
    // current pick: those are live commitments, not suppressed judgements. Nor
    // ownership or status - a completed or sleeping game is changed from the
    // Library, and the RPC will not set the flag on one.
    const requested = Boolean(game.reviewRequested);

    if (
      game.ownership !== "Owned" ||
      game.status === "Completed" ||
      game.status === "Slept" ||
      protectedIds.has(game.id) ||
      (!requested && (
        recentlyKept.has(game.id) ||
        recentlyActioned.has(game.id) ||
        likelyFinishedIds?.has(game.id)
      ))
    ) {
      continue;
    }

    const recency = game.recency;
    const duration = context(game);

    // Never opened is a fact about playtime, not about recency: nought hours is
    // nought hours whether or not Steam ever told us a date.
    const neverOpened = game.hoursPlayed === 0;

    // For everything else, age is the whole basis of the review, so it needs
    // evidence. Missing recency used to score as infinitely old, which put every
    // game Steam declined to date at the very top of the queue and described it
    // as "untouched for 9 years". Unknown now means we say nothing and ask
    // nothing - the game simply is not a candidate on age grounds.
    if (!requested && !neverOpened && !idleForAtLeast(recency, PURGE_IDLE_DAYS)) continue;

    const signal = purgeSignal(game);
    const confidence = purgeConfidence(game, recency, signal?.leaning ?? null);
    const reason = requested && !neverOpened && !idleForAtLeast(recency, PURGE_IDLE_DAYS)
      ? `You flagged this one for review.${duration}`
      : neverOpened
      ? `Never opened.${duration}`
      : `${game.hoursPlayed}h played, ${game.completionPercent}% progress, ${idlePhrase(recency)}.${duration}`;

    result.push({ game, reason, signal, confidence });
  }

  // Clearest decisions first. The queue was previously whatever order the library
  // happened to be in, so a player facing 223 games got no sense of momentum and
  // no reason to believe the next one would be any easier than the last.
  //
  // Cheapest breaks a tie, because most never-opened games have too few reviews to
  // carry a signal and would otherwise fall back to alphabetical. Letting go of a
  // £2 impulse buy is an easier first decision than a £50 one.
  return result.sort((left, right) =>
    right.confidence - left.confidence
    || shelfPrice(left.game) - shelfPrice(right.game)
    || left.game.title.localeCompare(right.game.title));
}

/**
 * How clear-cut a cut this is.
 *
 * Never opened, ancient and poorly reviewed is an easy yes. Something adored is
 * not a purge candidate at all in spirit, so it sinks to the bottom rather than
 * being put in front of the player as though it were.
 */
function shelfPrice(game: DemoGame) {
  if (game.isFree) return 0;
  return Number(game.priceInitial ?? 0) || 0;
}

function purgeConfidence(game: DemoGame, recency: GameRecency | null | undefined, signalLeaning: "cut" | "keep" | null) {
  let score = 0;
  if (game.hoursPlayed === 0) score += 2;
  // Age only adds confidence when we can show it. Not knowing how long ago
  // something was played is not a reason to be surer about letting it go.
  if (idleForAtLeast(recency, 730)) score += 1.5;
  else if (idleForAtLeast(recency, 365)) score += 1;
  if (signalLeaning === "cut") score += 2;
  if (signalLeaning === "keep") score -= 2.5;
  return score;
}

/**
 * Only the ends of the review spectrum are worth surfacing. "78% positive" does
 * not help anyone decide; "41% positive" and "94% from 141 reviews" both do.
 */
function purgeSignal(game: DemoGame): PurgeSignal | null {
  const appeal = gameAppeal(game);
  const label = appealLabel(appeal.kind);
  const detail = appealDetail(appeal);
  if (!label || !detail) return null;
  if (appeal.kind === "divisive") return { label, detail, leaning: "cut" };
  if (appeal.kind === "hidden-gem" || appeal.kind === "acclaimed" || appeal.kind === "phenomenon") {
    return { label, detail, leaning: "keep" };
  }
  return null;
}

function context(game: DemoGame) {
  const label = formatGameDuration(game.duration);
  return label ? ` Typical playthrough: ${label.toLowerCase()}.` : "";
}

function idlePhrase(recency: GameRecency | null | undefined) {
  if (!recency?.known || recency.daysSince === null) return "not played since we started watching";
  const age = formatAge(recency.daysSince);
  return recency.precise ? `untouched for ${age}` : `untouched for about ${age}`;
}

function formatAge(days: number) {
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return days >= 30 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days)}d`;
}
