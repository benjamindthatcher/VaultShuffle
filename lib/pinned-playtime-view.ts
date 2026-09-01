import type { DemoGame } from "./demo-data.ts";
import { gameProgress } from "./game-classification.ts";
import { deriveSessionFits } from "./vault-matching.ts";

/** Merge only Steam time evidence, never a stale copy of the player's edits. */
export function mergePinnedPlaytime(current: DemoGame[], refreshed: DemoGame[]): DemoGame[] {
  const byId = new Map(refreshed.map((game) => [game.id, game]));
  return current.map((game) => {
    const next = byId.get(game.id);
    if (!next || next.hoursPlayed < game.hoursPlayed) return game;
    const completionPercent = gameProgress({
      title: game.title,
      genre: game.genres.join(", "),
      status: game.status,
      hours_played: next.hoursPlayed,
      completion_percentage: game.completionPercent,
      main_story_minutes: game.duration?.mainStoryMinutes,
      main_extras_minutes: game.duration?.mainExtrasMinutes,
      completionist_minutes: game.duration?.completionistMinutes,
      duration_kind: game.duration
        ? game.duration.endless ? "endless" : "finite"
        : undefined,
    });
    const newerRecency = next.recency.known && (!game.recency.known || (
      next.recency.daysSinceAtMost !== null &&
      (game.recency.daysSinceAtMost === null || next.recency.daysSinceAtMost <= game.recency.daysSinceAtMost)
    ));
    const newerExact = next.lastPlayedAt && (!game.lastPlayedAt || Date.parse(next.lastPlayedAt) > Date.parse(game.lastPlayedAt));
    return {
      ...game,
      hoursPlayed: next.hoursPlayed,
      completionPercent,
      lastPlayedAt: newerExact ? next.lastPlayedAt : game.lastPlayedAt,
      lastPlayedLabel: newerRecency ? next.lastPlayedLabel : game.lastPlayedLabel,
      recency: newerRecency ? next.recency : game.recency,
      sessionFit: deriveSessionFits({
        duration: game.duration,
        completionPercent,
        endless: Boolean(game.duration?.endless),
        sessionability: game.sessionability
      }),
    };
  });
}
