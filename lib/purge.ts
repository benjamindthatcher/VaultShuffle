import type { DemoGame } from "./demo-data.ts";
import { formatGameDuration } from "./game-duration.ts";

export type PurgeCategory = "untouched" | "stalled" | "dormant";

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
  category: PurgeCategory;
  reviewedAt: string;
};
export type PurgeCandidate = {
  game: DemoGame;
  category: PurgeCategory;
  reason: string;
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
    if (
      game.ownership !== "Owned" ||
      game.status === "Completed" ||
      game.status === "Slept" ||
      protectedIds.has(game.id) ||
      recentlyKept.has(game.id) ||
      recentlyActioned.has(game.id) ||
      likelyFinishedIds?.has(game.id)
    ) {
      continue;
    }

    const idle = age(game.lastPlayedAt || game.lastPlayedLabel, now);
    const duration = context(game);

    // Recently played, unfinished games remain active and do not need a Purge review.
    if (game.hoursPlayed > 0 && idle < 180) continue;

    // "untouched" now means what it says. It previously labelled games at 85%+
    // progress — the opposite of untouched — which is exactly the confusion that
    // hid the completion question inside a pruning tool.
    if (game.hoursPlayed === 0) {
      result.push({
        game,
        category: "untouched",
        reason: `Never opened.${duration}`
      });
    } else if (game.completionPercent <= 50) {
      result.push({
        game,
        category: "stalled",
        reason: `${game.hoursPlayed}h played, ${game.completionPercent}% progress, untouched for ${formatAge(idle)}.${duration}`
      });
    } else {
      result.push({
        game,
        category: "dormant",
        reason: `${game.hoursPlayed}h played, ${game.completionPercent}% progress, untouched for ${formatAge(idle)}.${duration}`
      });
    }
  }

  return result;
}

function context(game: DemoGame) {
  const label = formatGameDuration(game.duration);
  return label ? ` Typical playthrough: ${label.toLowerCase()}.` : "";
}

function age(label: string, now: Date) {
  if (!label || label === "Not played recently") return Number.POSITIVE_INFINITY;
  const match = label.match(/(\d+)\s*([hdwmy])\s*ago/i);
  if (match) {
    const factors = { h: 1 / 24, d: 1, w: 7, m: 30, y: 365 };
    return Number(match[1]) * factors[match[2].toLowerCase() as keyof typeof factors];
  }
  const timestamp = Date.parse(label.replace(/^Added\s+/i, ""));
  return Number.isFinite(timestamp)
    ? Math.max(0, (now.getTime() - timestamp) / 86400000)
    : Number.POSITIVE_INFINITY;
}

function formatAge(days: number) {
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return days >= 30 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days)}d`;
}
