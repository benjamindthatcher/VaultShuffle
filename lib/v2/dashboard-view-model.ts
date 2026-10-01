import type { BacklogOverviewStats } from "../backlog-stats.ts";
import type { DashboardPayload } from "./repositories/dashboard-core.ts";

/** Whole-library totals come from SQL, never the bounded client entity cache. */
export function dashboardStats(payload: DashboardPayload): BacklogOverviewStats {
  const a=payload.aggregates,best=payload.bestValueGames[0],latest=payload.recentCompletions[0];
  return {currency:payload.currency,totalGames:a.ownedGames,completedGames:a.completedGames,completedPercent:a.completedPercent,
    libraryValueCents:a.libraryValueCents,completedValueCents:a.completedValueCents,
    valueCompletedPercent:a.libraryValueCents===null||a.completedValueCents===null?null:a.libraryValueCents>0?Math.round(a.completedValueCents*100/a.libraryValueCents):0,
    totalHours:a.ownedGames>0 && a.knownPlaytimeGames===0 ? null : Math.round(a.totalMinutes/60),
    hoursCoverage:a.knownPlaytimeGames<a.ownedGames ? `across ${a.knownPlaytimeGames} games with playtime` : "across the whole library",unplayedGames:a.unplayedGames,unplayedValueCents:a.unplayedValueCents,
    pricedGames:a.pricedGames,familyGames:a.familyGames,
    bestValue:best?{title:best.game.title,hours:Number(best.game.playtimeMinutes)/60,cents:best.cents,centsPerHour:best.centsPerHour}:null,
    latestCompletion:latest?.completedAt?{title:latest.title,completedAt:latest.completedAt}:null};
}
