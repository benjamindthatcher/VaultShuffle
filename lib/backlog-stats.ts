import type { DemoGame } from "./demo-data.ts";
import { isFamilyAccess } from "./family-sharing.ts";

/**
 * What a backlog is worth, and how much of it you have actually got value out of.
 *
 * Prices are Steam's current store prices, in cents, and are NOT what anyone paid —
 * most libraries are bought in sales, so this is the shelf price of what you own
 * rather than a spending figure. Every label built from these numbers says so;
 * quietly presenting it as "what your backlog cost you" would overstate it for
 * essentially everybody.
 */

export type BestValueGame = {
  title: string;
  hours: number;
  cents: number;
  /** Cents spent per hour played. Lower is better value. */
  centsPerHour: number;
};

export type BacklogStats = {
  currency: string;
  totalGames: number;
  completedGames: number;
  /** 0-100, share of owned games marked Completed. */
  completedPercent: number;
  libraryValueCents: number;
  completedValueCents: number;
  /** 0-100, share of the library's value you have actually finished. */
  valueCompletedPercent: number;
  totalHours: number;
  unplayedGames: number;
  unplayedValueCents: number;
  bestValue: BestValueGame | null;
  latestCompletion: { title: string; completedAt: string } | null;
  /** How many owned games we have a price for, so the UI can be honest about gaps. */
  pricedGames: number;
  /**
   * Games reachable through Steam Families, counted but deliberately excluded
   * from every figure above. Nobody paid for them, so they cannot be part of
   * what a shelf is worth, and their playtime is somebody else's or unknown, so
   * they cannot be part of what has been got out of it. Reported separately so
   * the dashboard can say why the count differs from the Library's.
   */
  familyGames: number;
};

const EMPTY: BacklogStats = {
  currency: "USD",
  totalGames: 0,
  completedGames: 0,
  completedPercent: 0,
  libraryValueCents: 0,
  completedValueCents: 0,
  valueCompletedPercent: 0,
  totalHours: 0,
  unplayedGames: 0,
  unplayedValueCents: 0,
  bestValue: null,
  latestCompletion: null,
  pricedGames: 0,
  familyGames: 0
};

/** Regular store price, ignoring whatever today's discount happens to be. */
function priceCents(game: DemoGame) {
  if (game.isFree) return 0;
  const initial = Number(game.priceInitial ?? 0);
  if (Number.isFinite(initial) && initial > 0) return Math.round(initial);
  const final = Number(game.priceFinal ?? 0);
  return Number.isFinite(final) && final > 0 ? Math.round(final) : 0;
}

export function buildBacklogStats(games: DemoGame[], currency = "USD"): BacklogStats {
  // Owned means owned here, not "on the shelf". Every number below is either
  // money or time-against-money, and a family game contributes neither: nobody
  // paid for it, and on an inferred row a zero-hour figure means "never told"
  // rather than "never played". See lib/family-sharing.ts.
  const owned = games.filter((game) => game.ownership === "Owned" && !isFamilyAccess(game.accessSource));
  const familyGames = games.filter((game) => isFamilyAccess(game.accessSource)).length;
  if (!owned.length) return { ...EMPTY, currency, familyGames };

  let libraryValueCents = 0;
  let completedValueCents = 0;
  let totalHours = 0;
  let completedGames = 0;
  let unplayedGames = 0;
  let unplayedValueCents = 0;
  let pricedGames = 0;
  let bestValue: BestValueGame | null = null;
  let latestCompletion: { title: string; completedAt: string } | null = null;

  for (const game of owned) {
    const cents = priceCents(game);
    const hours = Math.max(0, Number(game.hoursPlayed ?? 0));
    if (cents > 0) pricedGames += 1;

    libraryValueCents += cents;
    totalHours += hours;

    if (game.status === "Completed") {
      completedGames += 1;
      completedValueCents += cents;
      const completedAt = game.completedAt ?? null;
      if (completedAt && (!latestCompletion || completedAt > latestCompletion.completedAt)) {
        latestCompletion = { title: game.title, completedAt };
      }
    }

    if (hours <= 0) {
      unplayedGames += 1;
      unplayedValueCents += cents;
    }

    // Needs a real price and real time on it: an hour in a free game is not a
    // bargain, and 6 minutes in a £40 game is not a scandal worth headlining.
    if (cents > 0 && hours >= 1) {
      const centsPerHour = cents / hours;
      if (!bestValue || centsPerHour < bestValue.centsPerHour) {
        bestValue = { title: game.title, hours, cents, centsPerHour };
      }
    }
  }

  return {
    currency,
    totalGames: owned.length,
    completedGames,
    completedPercent: percent(completedGames, owned.length),
    libraryValueCents,
    completedValueCents,
    valueCompletedPercent: percent(completedValueCents, libraryValueCents),
    totalHours: Math.round(totalHours),
    unplayedGames,
    unplayedValueCents,
    bestValue,
    latestCompletion,
    pricedGames,
    familyGames
  };
}

function percent(part: number, whole: number) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

export function formatMoney(cents: number, currency = "USD") {
  const amount = (cents || 0) / 100;
  try {
    // Prices are USD (the catalogue enforces it), so format in the currency's own
    // locale — en-GB renders USD as the rather graceless "US$2,113".
    return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2
    }).format(amount);
  } catch {
    return `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;
  }
}

export function formatHours(hours: number) {
  if (hours >= 1000) return `${(hours / 1000).toFixed(1)}k`;
  return String(Math.round(hours));
}

/** "£1.20 an hour" reads better than a rate nobody can picture. */
export function formatValueRate(best: BestValueGame, currency = "USD") {
  return `${formatMoney(Math.round(best.centsPerHour), currency)} an hour`;
}
