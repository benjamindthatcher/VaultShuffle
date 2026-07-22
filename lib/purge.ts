import type { DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";

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
  const result: PurgeCandidate[] = [];

  for (const game of games) {
    if (
      game.ownership !== "Owned" ||
      game.status === "Completed" ||
      game.status === "Slept" ||
      protectedIds.has(game.id) ||
      recentlyKept.has(game.id)
    ) {
      continue;
    }

    const idle = age(game.lastPlayedLabel, now);
    const duration = context(game);

    if (game.hoursPlayed === 0) {
      result.push({
        game,
        category: "untouched",
        reason: `No recorded Steam playtime.${duration}`
      });
    } else if (game.hoursPlayed < 2 && idle >= 90) {
      result.push({
        game,
        category: "barely-started",
        reason: `Only ${game.hoursPlayed}h played and inactive for ${formatAge(idle)}.${duration}`
      });
    } else if (game.hoursPlayed >= 2 && idle >= 180) {
      result.push({
        game,
        category: "dormant",
        reason: `${game.hoursPlayed}h played, but untouched for ${formatAge(idle)}.${duration}`
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
  const match = label.match(/(\d+)\s*([hdwmy])\s*ago/i);
  if (match) {
    const factors = { h: 1 / 24, d: 1, w: 7, m: 30, y: 365 };
    return Number(match[1]) * factors[match[2].toLowerCase() as keyof typeof factors];
  }
  const timestamp = Date.parse(label.replace(/^Added\s+/i, ""));
  return Number.isFinite(timestamp)
    ? Math.max(0, (now.getTime() - timestamp) / 86400000)
    : 0;
}

function formatAge(days: number) {
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return days >= 30 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days)}d`;
}
