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
 * percentage of a game that never ends is a number about nothing. What they get
 * instead is pinRunSplit, below.
 */
export function pinProgressBar(game: DemoGame, pin: VaultPin | undefined) {
  if (isEndlessProgress(game)) return null;
  // Marking a game complete is the player stating a fact, and it holds whether
  // or not anyone ever estimated the game's length - the same rule progressLabel
  // applies. Reading completionPercent here instead cost a finished game its
  // dial at the exact moment it had the most to show.
  const finished = game.status === "Completed";
  const totalMinutes = estimatedTimeToBeatMinutes(game.duration);
  if (!totalMinutes) return finished ? { percent: 100, atPin: null } : null;

  const percent = finished
    ? 100
    : Math.max(0, Math.min(100, Math.round(Number(game.completionPercent ?? 0))));
  const hoursAtPin = pin?.hoursAtPin;
  if (hoursAtPin === null || hoursAtPin === undefined) return { percent, atPin: null };

  const atPin = Math.max(0, Math.min(percent, Math.round((hoursAtPin / (totalMinutes / 60)) * 100)));
  return { percent, atPin };
}

/**
 * The same dial, measuring the run rather than the story.
 *
 * For a game with no ending - or no estimate of one - there is no honest
 * percentage to draw, but there is still a measured fact worth showing: the
 * hours on the clock, and how many of them arrived after the pin was made. Both
 * numbers come from Steam rather than from an estimate, so the split means the
 * same thing it does above without inventing a denominator.
 *
 * The dial reads full for anyone who has played at all, which is why the face
 * beside it shows hours rather than a percentage: filling it is not a claim to
 * have finished anything, it is the whole of a run being accounted for.
 */
export function pinRunSplit(game: DemoGame, pin: VaultPin | undefined) {
  const hours = Math.max(0, Number(game.hoursPlayed ?? 0));
  if (hours <= 0) return { percent: 0, atPin: null };

  const hoursAtPin = pin?.hoursAtPin;
  if (hoursAtPin === null || hoursAtPin === undefined) return { percent: 100, atPin: null };
  return { percent: 100, atPin: Math.max(0, Math.min(100, Math.round((hoursAtPin / hours) * 100))) };
}

export type PinInstrument = {
  /** What the dial is measuring, which is what its face has to say. */
  kind: "story" | "run";
  percent: number;
  atPin: number | null;
};

/**
 * The dial every pin gets.
 *
 * A pinned game used to lose the whole instrument whenever its progress could
 * not be stated as a percentage - an endless game, or one HLTB has never timed -
 * so a shelf of three cards came out one card shorter than the others for a
 * reason nothing on screen explained. There is always something true to show:
 * the story where we can measure it, and the run where we cannot.
 */
export function pinInstrument(game: DemoGame, pin: VaultPin | undefined): PinInstrument {
  const story = pinProgressBar(game, pin);
  if (story) return { kind: "story", ...story };
  return { kind: "run", ...pinRunSplit(game, pin) };
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
