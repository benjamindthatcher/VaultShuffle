import type { DemoGame } from "./demo-data.ts";

/**
 * What VaultShuffle can actually do for this account.
 *
 * Steam hands out three different things independently: the list of games you
 * own, how long you have played each one, and when you last played it. Any of
 * them can be missing, and they fail in different ways for different accounts.
 *
 * Treating them as capabilities rather than as warning-banner inputs is the
 * point. Read ad-hoc, a feature that wants progress will happily read a missing
 * playtime as zero, and one that wants recency will read a missing date as
 * "never" - which is exactly how Purge came to describe every undated game as
 * untouched for nine years. A feature that declares what it needs cannot make
 * that mistake by accident.
 */

export type SteamCapabilities = {
  /** We have their real library, rather than a preview catalogue. */
  canUsePersonalLibrary: boolean;
  /** Playtime is visible, so progress and completion mean something. */
  canUseProgress: boolean;
  /** We have some evidence of when things were played. See lib/recency.ts. */
  canUseRecency: boolean;
  /** Enough nights observed to talk about streaks and recaps. */
  canUseHistory: boolean;
};

export const NO_STEAM_CAPABILITIES: SteamCapabilities = {
  canUsePersonalLibrary: false,
  canUseProgress: false,
  canUseRecency: false,
  canUseHistory: false
};

/**
 * A handful of games with evidence is enough to call recency usable. Requiring
 * all of them would mean one undated game disabled the feature for everyone,
 * and requiring one would mean a single stale row enabled it for nobody's
 * benefit.
 */
const RECENCY_EVIDENCE_FLOOR = 3;

/** Two observations is the minimum that can describe a change over time. */
const HISTORY_DAYS_FLOOR = 2;

export function steamCapabilities({
  isLive,
  games,
  playtimeVisible,
  daysTracked
}: {
  isLive: boolean;
  games: DemoGame[];
  playtimeVisible: boolean;
  daysTracked: number;
}): SteamCapabilities {
  if (!isLive || !games.length) return NO_STEAM_CAPABILITIES;

  const owned = games.filter((game) => game.ownership === "Owned");
  if (!owned.length) return NO_STEAM_CAPABILITIES;

  // Playtime being visible is what Steam reports; some playtime actually
  // existing is what makes it useful. A brand new account has neither and needs
  // to be treated the same way as a private one, because the product can do
  // nothing different for either.
  const hasPlaytime = owned.some((game) => game.hoursPlayed > 0);
  const withRecency = owned.filter((game) => game.recency?.known).length;

  return {
    canUsePersonalLibrary: true,
    canUseProgress: playtimeVisible && hasPlaytime,
    canUseRecency: withRecency >= Math.min(RECENCY_EVIDENCE_FLOOR, owned.length),
    canUseHistory: daysTracked >= HISTORY_DAYS_FLOOR
  };
}

/**
 * What each feature needs to say anything true. Written down so a new feature
 * has to state its requirements rather than discovering them from a bug report.
 */
export const FEATURE_REQUIREMENTS = {
  quickDraw: ["canUsePersonalLibrary"],
  vaultMood: [],
  somethingNew: ["canUsePersonalLibrary", "canUseProgress"],
  finishSomething: ["canUsePersonalLibrary", "canUseProgress"],
  recentlyPlayedShelf: ["canUsePersonalLibrary", "canUseRecency"],
  fallenOffShelf: ["canUsePersonalLibrary", "canUseRecency"],
  purgeDormancy: ["canUsePersonalLibrary", "canUseRecency"],
  playStreak: ["canUsePersonalLibrary", "canUseHistory"],
  visitRecap: ["canUsePersonalLibrary", "canUseHistory"]
} as const satisfies Record<string, ReadonlyArray<keyof SteamCapabilities>>;

export type SteamFeature = keyof typeof FEATURE_REQUIREMENTS;

export function featureAvailable(feature: SteamFeature, capabilities: SteamCapabilities): boolean {
  return FEATURE_REQUIREMENTS[feature].every((requirement) => capabilities[requirement]);
}
