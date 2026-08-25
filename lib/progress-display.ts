import type { GameDurationEstimate } from "./types.ts";

/**
 * An endless game has no credits to reach, so a percentage of it is a number
 * about nothing. It used to read 99%, which looks like "nearly done" for a game
 * that is never done.
 */
export const ENDLESS_PROGRESS_SYMBOL = "∞";

type ProgressLike = {
  status?: string | null;
  completionPercent?: number | null;
  duration?: GameDurationEstimate | null;
};

/**
 * How far through a game the player is, worded honestly.
 *
 * Progress is inferred from hours played against an estimated playthrough
 * length - Steam does not report it - so everything except an explicit
 * completion is marked as an estimate. Forty hours of side quests in a
 * fifty-hour RPG is not eighty percent of the story.
 *
 * Marking an endless game complete is still allowed, and still reads 100%: that
 * is the player stating a fact rather than the app inferring one.
 */
export function progressLabel(game: ProgressLike): string {
  if (game.status === "Completed") return "100%";
  if (game.duration?.endless) return ENDLESS_PROGRESS_SYMBOL;
  return `${Math.max(0, Math.round(Number(game.completionPercent ?? 0)))}% est`;
}

/** The same judgement, for callers that need to lay the symbol out differently. */
export function isEndlessProgress(game: ProgressLike): boolean {
  return game.status !== "Completed" && Boolean(game.duration?.endless);
}
