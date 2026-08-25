/**
 * Parsing for Steam's GetRecentlyPlayedGames response.
 *
 * Separate from lib/steam.ts so it can be tested: the test runner strips types
 * but does not resolve path aliases, and lib/steam.ts is full of them.
 */
export function recentlyPlayedAppIdsFromPayload(payload: unknown): number[] {

  const response = payload && typeof payload === "object" && "response" in payload
    ? (payload as { response?: unknown }).response
    : null;
  const games = response && typeof response === "object" && "games" in response
    ? (response as { games?: unknown }).games
    : null;
  if (!Array.isArray(games)) return [];

  const appIds = new Set<number>();
  for (const item of games) {
    if (!item || typeof item !== "object") continue;
    const appId = Number((item as { appid?: unknown }).appid);
    // Steam includes entries with two weeks of zero playtime; those are not
    // evidence of anything and are dropped.
    const minutes = Number((item as { playtime_2weeks?: unknown }).playtime_2weeks ?? 0);
    if (Number.isFinite(appId) && appId > 0 && minutes > 0) appIds.add(appId);
  }
  return [...appIds];
}
