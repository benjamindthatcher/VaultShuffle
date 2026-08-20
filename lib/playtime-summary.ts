export type PlaytimeSnapshot = { capturedOn: string; totalMinutes: number };

export type PlaytimeSummary = {
  /** Consecutive days up to today with any playtime gained. */
  streakDays: number;
  minutesLast7Days: number;
  minutesLast30Days: number;
  /** Days of history available, so the UI can avoid claiming a streak it cannot see. */
  daysTracked: number;
};

/**
 * Pure so it can be reasoned about and tested without a database.
 *
 * Snapshots arrive newest first. A day counts toward the streak when its total is
 * higher than the day before it, which is the only way a running total can show
 * that time was actually played rather than merely recorded again.
 */
export function summarisePlaytime(snapshots: PlaytimeSnapshot[], today = new Date()): PlaytimeSummary {
  if (snapshots.length < 2) {
    return { streakDays: 0, minutesLast7Days: 0, minutesLast30Days: 0, daysTracked: snapshots.length };
  }

  const gainedByDay = new Map<string, number>();
  for (let index = 0; index < snapshots.length - 1; index += 1) {
    const gained = snapshots[index].totalMinutes - snapshots[index + 1].totalMinutes;
    gainedByDay.set(snapshots[index].capturedOn, Math.max(0, gained));
  }

  const dayKey = (offset: number) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    return date.toISOString().slice(0, 10);
  };

  // Yesterday may legitimately be the newest complete day, so a streak is allowed
  // to start there rather than being broken by today not having landed yet.
  let streakDays = 0;
  let offset = (gainedByDay.get(dayKey(0)) ?? 0) > 0 ? 0 : 1;
  while ((gainedByDay.get(dayKey(offset)) ?? 0) > 0) {
    streakDays += 1;
    offset += 1;
  }

  const sumWithin = (days: number) => {
    let total = 0;
    for (let index = 0; index < days; index += 1) total += gainedByDay.get(dayKey(index)) ?? 0;
    return total;
  };

  return {
    streakDays,
    minutesLast7Days: sumWithin(7),
    minutesLast30Days: sumWithin(30),
    daysTracked: snapshots.length
  };
}
