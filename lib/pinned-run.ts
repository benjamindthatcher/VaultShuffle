import { pinProgressBar, pinProgressHours } from "./completion-celebration.ts";
import type { DemoGame } from "./demo-data.ts";
import { formatRemainingDuration } from "./game-duration.ts";
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
  totalPlaytimeLabel: string;
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

  let headline: string;
  let message: string;
  if (game.status === "Completed") {
    headline = "Commitment complete";
    message = "You picked it. You played it. You finished it.";
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
    remainingLabel: formatRemainingDuration(game.duration, progress?.percent ?? game.completionPercent),
    pinnedLabel: pin?.pinnedAt ? `Pinned ${formatPinnedDate(pin.pinnedAt)}` : "Pinned to Playing next",
    totalPlaytimeLabel: `${formatTrackedHours(Math.max(0, Number(game.hoursPlayed) || 0))} total playtime`,
  };
}

function formatPinnedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}
