import type { DemoGame } from "./demo-data.ts";

export function completionHistory(games: DemoGame[]) {
  return games.filter((game) => game.status === "Completed").sort((left, right) => {
    const date = (value: string | null | undefined) => {
      const time = value ? Date.parse(value) : NaN;
      return Number.isFinite(time) ? time : 0;
    };
    return date(right.completedAt) - date(left.completedAt) || left.title.localeCompare(right.title);
  });
}

export function completionMetrics(game: DemoGame) {
  const shared = game.accessSource === "family";
  const hours = !shared && game.playtimeKnown !== false && Number.isFinite(game.hoursPlayed) && game.hoursPlayed >= 0 ? game.hoursPlayed : null;
  const price = shared ? null : game.isFree ? 0 : game.priceInitial;
  const cents = price != null && Number.isFinite(price) && price >= 0 ? price : null;
  const centsPerHour = hours !== null && hours > 0 && cents !== null ? Math.round(cents / hours) : null;
  return { hours, cents, centsPerHour };
}
