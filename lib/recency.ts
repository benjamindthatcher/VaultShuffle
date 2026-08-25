/**
 * One definition of "when was this last played", for every feature that asks.
 *
 * Steam does not reliably tell third-party apps when a game was last played.
 * GetOwnedGames returns rtime_last_played for the account behind the API key,
 * but ordinary users' libraries come back without it even when their library and
 * lifetime playtime are public. So exact timestamps are treated as a bonus, and
 * recency is inferred from evidence we can actually get:
 *
 *   1. steam_exact              - Steam gave us a real timestamp. Rare, precise.
 *   2. observed_playtime_change - cumulative playtime rose between two of our own
 *                                 observations, so it was played in between.
 *   3. steam_recent_window      - Steam's recently-played list included it, which
 *                                 means "within the last two weeks" and no more.
 *
 * The rule that governs all of it: no evidence means UNKNOWN. Unknown is not
 * "never", not "years ago", and not Infinity. Purge used to read a missing
 * timestamp as infinitely old, which made every game with no play history look
 * maximally abandoned.
 */

/** Steam's recently-played list covers the previous two weeks. */
export const STEAM_RECENT_WINDOW_DAYS = 14;

export type RecencySource = "steam_exact" | "observed_playtime_change" | "steam_recent_window";

export type RecencyEvidence = {
  lastObservedPlayedAt?: string | Date | null;
  recencySource?: RecencySource | string | null;
  recencyEvidenceAt?: string | Date | null;
};

export type GameRecency = {
  /** Whether we have any evidence at all. Everything else is meaningless if false. */
  known: boolean;
  source: RecencySource | null;
  /** True when we can name a day. Window evidence cannot. */
  precise: boolean;
  /**
   * Days since we believe it was last played, or null when unknown.
   * Never Infinity - callers must handle null deliberately.
   */
  daysSince: number | null;
  /**
   * The most days it could have been, given the width of the evidence. Equal to
   * daysSince for precise evidence. Use where being wrong in the "too old"
   * direction is costly, such as deciding something is abandoned.
   */
  daysSinceAtMost: number | null;
  /** Human wording that never claims more precision than we hold. */
  label: string | null;
};

export const UNKNOWN_RECENCY: GameRecency = {
  known: false,
  source: null,
  precise: false,
  daysSince: null,
  daysSinceAtMost: null,
  label: null
};

const DAY_MS = 86400000;

function toTime(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

function daysBetween(from: number, to: number) {
  return Math.max(0, (to - from) / DAY_MS);
}

export function describeRecency(evidence: RecencyEvidence | null | undefined, now: Date = new Date()): GameRecency {
  if (!evidence) return UNKNOWN_RECENCY;
  const source = evidence.recencySource as RecencySource | null;
  const nowTime = now.getTime();

  if (source === "steam_exact" || source === "observed_playtime_change") {
    const playedAt = toTime(evidence.lastObservedPlayedAt);
    if (playedAt === null) return UNKNOWN_RECENCY;
    const daysSince = daysBetween(playedAt, nowTime);
    return {
      known: true,
      source,
      precise: true,
      daysSince,
      daysSinceAtMost: daysSince,
      label: preciseLabel(daysSince)
    };
  }

  if (source === "steam_recent_window") {
    // Steam told us, at recencyEvidenceAt, that the game had been played at some
    // point in the two weeks before that. The activity is therefore somewhere in
    // [evidenceAt - 14d, evidenceAt]. We know the shape of the window; we do not
    // know where in it the session fell, and must not pretend otherwise.
    const evidenceAt = toTime(evidence.recencyEvidenceAt);
    if (evidenceAt === null) return UNKNOWN_RECENCY;
    const daysSince = daysBetween(evidenceAt, nowTime);
    const daysSinceAtMost = daysSince + STEAM_RECENT_WINDOW_DAYS;
    return {
      known: true,
      source,
      precise: false,
      daysSince,
      daysSinceAtMost,
      label: windowLabel(daysSince)
    };
  }

  return UNKNOWN_RECENCY;
}

function preciseLabel(daysSince: number) {
  const days = Math.floor(daysSince);
  if (days <= 0) return "Played today";
  if (days === 1) return "Played yesterday";
  if (days < 7) return `Played ${days} days ago`;
  return `Played ${approximateAge(daysSince)} ago`;
}

function windowLabel(daysSince: number) {
  // Within the window itself, "recently" is the whole truth and reads better
  // than a number we would be inventing.
  if (daysSince <= STEAM_RECENT_WINDOW_DAYS) return "Played recently";
  return `Played about ${approximateAge(daysSince)} ago`;
}

export function approximateAge(days: number) {
  if (days < 14) return `${Math.max(1, Math.round(days))} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.max(1, Math.round(days / 30))} months`;
  const years = days / 365;
  return years < 1.5 ? "a year" : `${Math.round(years)} years`;
}

/**
 * Whether the evidence supports calling a game abandoned after `days`.
 *
 * Deliberately requires evidence. Something we have never observed is not
 * abandoned - it is unobserved, and the honest answer is to leave it alone.
 * Uses the conservative end of a window so a two-week uncertainty cannot tip a
 * game over a threshold it has not actually crossed.
 */
export function idleForAtLeast(recency: GameRecency | null | undefined, days: number): boolean {
  if (!recency?.known || recency.daysSince === null) return false;
  return recency.daysSince >= days;
}

/**
 * Whether the evidence supports calling a game recently played within `days`.
 * Uses the conservative end for the same reason, in the opposite direction.
 */
export function playedWithin(recency: GameRecency | null | undefined, days: number): boolean {
  if (!recency?.known || recency.daysSinceAtMost === null) return false;
  return recency.daysSinceAtMost <= days;
}

/**
 * Sort key for "most recently played first". Unknown sorts last rather than
 * first or oldest, because we are not claiming either.
 */
export function recencySortKey(recency: GameRecency | null | undefined): number {
  return recency?.daysSince ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Which of two observations should be kept.
 *
 * Precise evidence wins over a window covering the same ground, and newer
 * activity wins over older. A two-week-old window observation must not overwrite
 * a playtime rise we watched happen yesterday.
 */
export function strongerEvidence(
  current: RecencyEvidence | null | undefined,
  incoming: RecencyEvidence,
  now: Date = new Date()
): RecencyEvidence {
  const currentRecency = describeRecency(current, now);
  const incomingRecency = describeRecency(incoming, now);
  if (!incomingRecency.known) return current ?? incoming;
  if (!currentRecency.known) return incoming;

  // Later implied activity wins outright.
  if (incomingRecency.daysSince! < currentRecency.daysSince! - 0.0001) return incoming;
  if (currentRecency.daysSince! < incomingRecency.daysSince! - 0.0001) return current!;

  // Same moment: prefer the one that can name a day.
  if (incomingRecency.precise && !currentRecency.precise) return incoming;
  return current!;
}
