import type { DemoGame } from "./demo-data";

// The interactive guest dashboard is available only in the development build.
// Its filters and summary use the same catalogue game state as the guest Library.
export const LOCAL_DASHBOARD_PREVIEW = process.env.NODE_ENV === "development";

/** Seed editable guest state so the signed-in dashboard sections can be reviewed. */
export function seedDashboardPreview(games: DemoGame[]): DemoGame[] {
  if (!LOCAL_DASHBOARD_PREVIEW) return games;
  let sampleIndex = 0;
  return games.map((game) => {
    if (!game.priceInitial || sampleIndex >= 8) return game;
    const index = sampleIndex++;
    const completed = index < 4;
    return {
      ...game,
      hoursPlayed: [120, 64, 42, 28, 180, 90, 12, 6][index],
      status: completed ? "Completed" : "In Progress",
      completionPercent: completed ? 100 : 20,
      completedAt: completed ? `2026-09-${24 - index}T12:00:00.000Z` : null
    };
  });
}
