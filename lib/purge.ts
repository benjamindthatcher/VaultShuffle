import type { DemoGame } from "./demo-data.ts";
import { formatGameDuration } from "./game-duration.ts";

export type PurgeCategory = "untouched" | "barely-started" | "dormant";
export type PurgeAction = "keep" | "pin" | "sleep" | "complete";
export type PurgeReview = {
  id: string;
  gameId: string;
  action: PurgeAction;
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
export function isReviewSuperseded(action: PurgeAction, status: DemoGame["status"]) {
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
  now = new Date()
}: {
  games: DemoGame[];
  pinnedIds: string[];
  currentPickId: string | null;
  snoozedIds: string[];
  reviews?: PurgeReview[];
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
      recentlyActioned.has(game.id)
    ) {
      continue;
    }

    const idle = age(game.lastPlayedAt || game.lastPlayedLabel, now);
    const duration = context(game);

    // Recently played, unfinished games remain active and do not need a Purge review.
    if (game.hoursPlayed > 0 && idle < 180) continue;

    if (game.hoursPlayed > 0 && game.completionPercent >= 85) {
      result.push({
        game,
        category: "untouched",
        reason: `${game.completionPercent}% estimated progress suggests you may already have finished this.${duration}`
      });
    } else if (game.hoursPlayed > 0 && game.completionPercent <= 50) {
      result.push({
        game,
        category: "barely-started",
        reason: `${game.hoursPlayed}h played, ${game.completionPercent}% progress and inactive for ${formatAge(idle)}.${duration}`
      });
    } else {
      result.push({
        game,
        category: "dormant",
        reason: game.hoursPlayed === 0
          ? `No recorded Steam playtime.${duration}`
          : `${game.hoursPlayed}h played and inactive for ${formatAge(idle)}.${duration}`
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
