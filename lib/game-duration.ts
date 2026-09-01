import type { GameDurationEstimate } from "./types.ts";

function positiveMinutes(value?: number | null) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function roundToClosestHour(minutes: number) {
  return Math.max(60, Math.round(minutes / 60) * 60);
}

export function estimatedTimeToBeatMinutes(duration?: GameDurationEstimate | null) {
  const estimates = [
    positiveMinutes(duration?.mainStoryMinutes),
    positiveMinutes(duration?.mainExtrasMinutes),
    positiveMinutes(duration?.completionistMinutes)
  ].filter((minutes): minutes is number => minutes !== null);

  if (!estimates.length) return null;
  return roundToClosestHour(estimates.reduce((total, minutes) => total + minutes, 0) / estimates.length);
}

export function getPreferredDurationMinutes(duration?: GameDurationEstimate | null) {
  return estimatedTimeToBeatMinutes(duration);
}

/**
 * Hours played against the estimated playthrough, taken literally.
 *
 * It used to clamp at 99, so someone 250 hours into a 27-hour game was told
 * they were "99% through - the ending is genuinely in reach". Reaching the
 * estimate now reads as 100%, which is what the numbers actually say. Whether
 * the game is finished is a separate question, and a more forgiving one: see
 * FINISHED_RATIO in lib/completion-check.ts.
 */
export function completionFromDuration(hoursPlayed: number, duration?: GameDurationEstimate | null) {
  if (duration?.endless) return 99;
  const estimate = estimatedTimeToBeatMinutes(duration);
  if (!estimate || hoursPlayed <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((hoursPlayed * 60 * 100) / estimate)));
}

export function formatDurationEstimate(minutes: number | null) {
  if (!minutes) return "Not available";
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)}h`;
}

export function formatGameDuration(duration?: GameDurationEstimate | null) {
  if (duration?.endless) return "Endless";
  const estimate = estimatedTimeToBeatMinutes(duration);
  return estimate ? `${formatDurationEstimate(estimate)} estimated` : null;
}

/**
 * How much of a game is left, from its estimate and how far through it is.
 *
 * "Current estimate" named a number without giving it, on the one card whose
 * job is to show someone how a game they committed to is going. This is the
 * number: what is actually still ahead of them.
 *
 * Null whenever it cannot be said honestly - an endless game has no end to be
 * short of, an unestimated one has nothing to subtract from, and a game at or
 * past its estimate has nothing left to promise.
 */
export function formatRemainingDuration(duration: GameDurationEstimate | null | undefined, completionPercent: number) {
  if (duration?.endless) return null;
  const total = estimatedTimeToBeatMinutes(duration);
  if (!total) return null;

  const done = Math.min(100, Math.max(0, Number(completionPercent) || 0));
  const remaining = total * (1 - done / 100);
  // Under a few minutes there is no useful number left to give, and rounding
  // would print "0h left" on something all but finished.
  if (remaining < 6) return null;
  return `~${formatDurationEstimate(remaining)} left`;
}
