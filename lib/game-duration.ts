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

export function completionFromDuration(hoursPlayed: number, duration?: GameDurationEstimate | null) {
  if (duration?.endless) return 99;
  const estimate = estimatedTimeToBeatMinutes(duration);
  if (!estimate || hoursPlayed <= 0) return 0;
  return Math.min(99, Math.max(0, Math.round((hoursPlayed * 60 * 100) / estimate)));
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
