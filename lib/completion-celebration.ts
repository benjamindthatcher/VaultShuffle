import type { DemoGame } from "./demo-data.ts";
import type { VaultPin } from "./vault-state.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";
import { isEndlessProgress } from "./progress-display.ts";

export type CompletionMilestone = {
  headline: string;
  spectacle: "standard" | "big";
};

/** Hours put in since the game was pinned, or null when there is nothing to compare against. */
export function pinProgressHours(game: DemoGame, pin: VaultPin | undefined) {
  if (!pin || pin.hoursAtPin === null || pin.hoursAtPin === undefined) return null;
  return Math.max(0, Number(game.hoursPlayed ?? 0) - pin.hoursAtPin);
}

/**
 * The bar under a pin: how far through the game you are, and how much of that
 * you did after pinning it.
 *
 * The split is the whole point. A pin says "this is what I'm playing next", and
 * the part of the bar earned since making that promise is the only part that
 * says whether you kept it. Without it a well-worn game looks like progress you
 * have just made.
 *
 * Endless games get no bar. There are no credits to measure against, and a
 * percentage of a game that never ends is a number about nothing.
 */
export function pinProgressBar(game: DemoGame, pin: VaultPin | undefined) {
  if (game.status !== "Completed" && isEndlessProgress(game)) return null;
  const totalMinutes = estimatedTimeToBeatMinutes(game.duration);
  if (!totalMinutes) return null;

  const percent = Math.max(0, Math.min(100, Math.round(Number(game.completionPercent ?? 0))));
  const hoursAtPin = pin?.hoursAtPin;
  if (hoursAtPin === null || hoursAtPin === undefined) return { percent, atPin: null };

  const atPin = Math.max(0, Math.min(percent, Math.round((hoursAtPin / (totalMinutes / 60)) * 100)));
  return { percent, atPin };
}

/**
 * What makes this completion worth marking.
 *
 * Escalates rather than firing the same animation every time, because a
 * celebration that never varies stops registering by the third game in a
 * session. Finishing something you committed to gets the biggest treatment:
 * that is the whole roll → pin → play → finish loop closing.
 */
export function completionMilestone(
  game: DemoGame,
  completedCount: number,
  pin: VaultPin | undefined
): CompletionMilestone {
  const gained = pinProgressHours(game, pin);
  if (gained !== null && gained > 0.1) {
    return { headline: "You called it, and you finished it", spectacle: "big" };
  }
  if (completedCount === 1) return { headline: "First one down", spectacle: "big" };
  if (completedCount % 10 === 0) return { headline: `${completedCount} games finished`, spectacle: "big" };
  if (completedCount % 5 === 0) return { headline: `${completedCount} down`, spectacle: "standard" };
  return { headline: "Another one finished", spectacle: "standard" };
}
