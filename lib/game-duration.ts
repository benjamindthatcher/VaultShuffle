import type { GameDurationEstimate } from "@/lib/types";

export function estimatedTimeToBeatMinutes(duration?: GameDurationEstimate | null) {
  const providerEstimates = [
    duration?.mainStoryMinutes,
    duration?.mainExtrasMinutes,
    duration?.completionistMinutes
  ].filter((value): value is number => Number.isFinite(value) && Number(value) > 0);

  if (Number(duration?.userEstimateMinutes) > 0) return Number(duration?.userEstimateMinutes);
  return providerEstimates.length ? Math.min(...providerEstimates) : null;
}

export function getPreferredDurationMinutes(duration?: GameDurationEstimate | null) {
  if (Number(duration?.userEstimateMinutes) > 0) return Number(duration?.userEstimateMinutes);
  return duration?.mainStoryMinutes ?? duration?.mainExtrasMinutes ?? duration?.completionistMinutes ?? null;
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
