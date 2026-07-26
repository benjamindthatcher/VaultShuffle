import type { GameDurationEstimate } from "@/lib/types";

function positiveMinutes(value?: number | null) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function roundToClosestHour(minutes: number) {
  return Math.max(60, Math.round(minutes / 60) * 60);
}

export function estimatedTimeToBeatMinutes(duration?: GameDurationEstimate | null) {
  const mainStory = positiveMinutes(duration?.mainStoryMinutes);
  const completionist = positiveMinutes(duration?.completionistMinutes);
  if (mainStory && completionist) {
    return roundToClosestHour((mainStory + completionist) / 2);
  }

  const fallback = mainStory
    ?? positiveMinutes(duration?.mainExtrasMinutes)
    ?? completionist;
  return fallback ? roundToClosestHour(fallback) : null;
}

export function getPreferredDurationMinutes(duration?: GameDurationEstimate | null) {
  return estimatedTimeToBeatMinutes(duration);
}

export function completionFromDuration(hoursPlayed: number, duration?: GameDurationEstimate | null) {
  const estimate = estimatedTimeToBeatMinutes(duration);
  if (!estimate || hoursPlayed <= 0) return 0;
  return Math.min(99, Math.max(0, Math.round((hoursPlayed * 60 * 100) / estimate)));
}

export function formatDurationEstimate(minutes: number | null) {
  if (!minutes) return "Not available";
  const hours = minutes / 60;
  return `About ${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)}h`;
}

export function formatGameDuration(duration?: GameDurationEstimate | null) {
  const estimate = estimatedTimeToBeatMinutes(duration);
  return estimate ? `${formatDurationEstimate(estimate)} estimated` : null;
}
