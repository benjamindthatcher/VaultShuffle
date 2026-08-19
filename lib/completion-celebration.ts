import type { DemoGame } from "./demo-data.ts";
import type { VaultPin } from "./vault-state.ts";

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
