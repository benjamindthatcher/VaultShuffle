import { pinProgressBar, pinProgressHours } from "./completion-celebration.ts";
import type { DemoGame } from "./demo-data.ts";
import { formatRemainingDuration } from "./game-duration.ts";
import { playtimeIsUnknown } from "./family-sharing.ts";
import type { VaultPin } from "./vault-state.ts";

export type PinnedRunSummary = {
  headline: string;
  message: string;
  trackedHours: number | null;
  trackedHoursLabel: string | null;
  percent: number | null;
  beforePercent: number | null;
  earnedPercent: number | null;
  remainingLabel: string | null;
  pinnedLabel: string;
  /** Null when there is no playtime to total, rather than a confident "0h". */
  totalPlaytimeLabel: string | null;
  /** Whose library it came from, when the pinned game is not the player's own. */
  sharedFrom: string | null;
};

/** A compact hour label for the celebratory pin UI, without pretending 0.4h is 0h. */
export function formatTrackedHours(hours: number) {
  if (hours < 1) return `${hours.toFixed(1).replace(/\.0$/, "")}h`;
  if (hours < 10) return `${hours.toFixed(1).replace(/\.0$/, "")}h`;
  return `${Math.round(hours)}h`;
}

/**
 * Turns the pin baseline into language the player can trust.
 *
 * Total completion and progress earned after pinning are deliberately separate:
 * a game can be 50% complete and still have had no play since it was pinned.
 */
export function buildPinnedRunSummary(game: DemoGame, pin: VaultPin | undefined): PinnedRunSummary {
  const progress = pinProgressBar(game, pin);
  const trackedHours = pinProgressHours(game, pin);
  const earnedPercent = progress?.atPin === null || progress?.atPin === undefined
    ? null
    : Math.max(0, progress.percent - progress.atPin);

  const shared = playtimeIsUnknown(game);

  let headline: string;
  let message: string;
  if (game.status === "Completed") {
    headline = "Commitment complete";
    message = "You picked it. You played it. You finished it.";
  } else if (shared) {
    // The pin still means what it always meant - this is what I am playing next.
    // What it cannot do is measure the run, because Steam reports the owner's
    // hours and not yours. Saying so is better than a dial reading 0% and a
    // headline reading "No play since pinning", which is what this showed
    // before: a made-up accusation sitting next to the words "Not available".
    headline = "Pinned from the family shelf";
    message = "Steam only reports the owner's hours, so this run is not tracked.";
  } else if (trackedHours === null) {
    headline = "Pinned and ready";
    message = "Pin tracking starts from your next playtime check.";
  } else if (trackedHours > 0.1) {
    headline = `${formatTrackedHours(trackedHours)} played since pinning`;
    message = "That promise is paying off. Keep the run moving.";
  } else {
    headline = "No play since pinning";
    message = "A good choice. Ready when you are.";
  }

  return {
    headline,
    message,
    trackedHours,
    trackedHoursLabel: trackedHours === null ? null : `${formatTrackedHours(trackedHours)} since pinning`,
    percent: progress?.percent ?? null,
    beforePercent: progress?.atPin ?? null,
    earnedPercent,
    // "99h left" on a shared game would imply we know none of it is done. The
    // length is still worth showing, but as the game's length, not as what is
    // left of it - so the caller falls back to the plain estimate.
    remainingLabel: shared ? null : formatRemainingDuration(game.duration, progress?.percent ?? game.completionPercent),
    pinnedLabel: pin?.pinnedAt ? `Pinned ${formatPinnedDate(pin.pinnedAt)}` : "Pinned to Playing next",
    totalPlaytimeLabel: shared ? null : `${formatTrackedHours(Math.max(0, Number(game.hoursPlayed) || 0))} total playtime`,
    sharedFrom: shared ? (game.familyOwnerName?.trim() || "a family member") : null
  };
}

function formatPinnedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}
