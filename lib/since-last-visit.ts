import type { DemoGame } from "./demo-data.ts";
import type { PlaytimeSummary } from "./playtime-summary.ts";

export type VisitRecap = {
  /** ISO day the recap is measured from. */
  since: string;
  minutesPlayed: number;
  gamesFinished: DemoGame[];
  /** True when we fell back to a week because there is no usable last visit. */
  windowed: boolean;
};

/**
 * Anything older than this is not "since you were last here" in any meaningful
 * sense, so the recap falls back to a plain week rather than claiming three
 * months of activity happened while they were away.
 */
const MAX_ABSENCE_DAYS = 30;

/** Nothing worth interrupting someone for. */
const MIN_MINUTES = 20;

export function buildVisitRecap({
  games,
  playtime,
  lastVisitISO,
  now = new Date()
}: {
  games: DemoGame[];
  playtime: PlaytimeSummary;
  lastVisitISO: string | null;
  now?: Date;
}): VisitRecap | null {
  const today = now.toISOString().slice(0, 10);
  const lastVisitDay = lastVisitISO ? lastVisitISO.slice(0, 10) : null;

  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - 7);
  const fallbackDay = windowStart.toISOString().slice(0, 10);

  const tooOld = !lastVisitDay || daysBetween(lastVisitDay, today) > MAX_ABSENCE_DAYS;
  const since = tooOld ? fallbackDay : lastVisitDay;
  const windowed = tooOld;

  // Same-day return: they have already seen whatever there was to see.
  if (!windowed && since >= today) return null;

  const minutesPlayed = playtime.dailyGains
    .filter((entry) => entry.day > since && entry.day <= today)
    .reduce((total, entry) => total + entry.minutes, 0);

  const gamesFinished = games.filter((game) => {
    if (game.status !== "Completed" || !game.completedAt) return false;
    const day = String(game.completedAt).slice(0, 10);
    return day > since && day <= today;
  });

  if (minutesPlayed < MIN_MINUTES && !gamesFinished.length) return null;
  return { since, minutesPlayed, gamesFinished, windowed };
}

function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.round((end - start) / 86_400_000);
}

/** Reads as a sentence rather than a row of numbers. */
export function recapSentence(recap: VisitRecap) {
  const hours = recap.minutesPlayed / 60;
  // Number() drops a trailing .0, so eight hours reads "8h" rather than "8.0h".
  const played = recap.minutesPlayed >= 60
    ? `${hours < 10 ? Number(hours.toFixed(1)) : Math.round(hours)}h played`
    : `${Math.round(recap.minutesPlayed)} minutes played`;

  const finished = recap.gamesFinished.length
    ? `${recap.gamesFinished.length} ${recap.gamesFinished.length === 1 ? "game" : "games"} finished`
    : null;

  const parts = [recap.minutesPlayed >= MIN_MINUTES ? played : null, finished].filter(Boolean);
  return parts.join(" · ");
}
