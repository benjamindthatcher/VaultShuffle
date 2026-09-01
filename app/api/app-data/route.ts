import { after, NextResponse } from "next/server";
import { listCollectionsWithMemberships } from "@/lib/collections";
import { listGames } from "@/lib/games";
import { getSessionPayload } from "@/lib/session-payload";
import { getVaultState } from "@/lib/vault-state";
import { listGamePreferenceGlobals, listGenrePreferences, listGenrePreferenceGlobals } from "@/lib/genre-preference-worker";
import { getPlaytimeSummary } from "@/lib/playtime-snapshots";
import { refreshCurrentManualSessionCookie } from "@/lib/auth";
import { retryPendingPostHogAccountProfileMerges } from "@/lib/posthog-server";
import { requestDiagnostics, reportServiceWarning } from "@/lib/diagnostics-server";

async function jsonWithSessionRefresh(body: unknown, init?: ResponseInit) {
  return refreshCurrentManualSessionCookie(NextResponse.json(body, init));
}

export async function GET(request: Request) {
  const diagnostics = requestDiagnostics(request, "app_bootstrap");
  diagnostics.stage("session_check");
  const session = await getSessionPayload();
  diagnostics.account(session.user_id, session.account_type);

  if (session.account_type === "steam" && session.user_id) {
    const accountId = session.user_id;
    after(async () => {
      try {
        await retryPendingPostHogAccountProfileMerges(accountId);
      } catch (error) {
        reportServiceWarning(error, "account_analytics_merge", "retry_delivery");
      }
    });
  }

  // A guest bootstrap is just this session object - a couple of hundred bytes.
  // The preview pool it used to carry was a megabyte and a half of the same
  // games for everybody, rebuilt per visitor because nothing under /api can be
  // publicly cached. It now lives at /guest-catalogue, which the CDN serves.
  if (!session.logged_in || !session.user_id) {
    return jsonWithSessionRefresh({ session });
  }

  try {
    diagnostics.stage("load_account_data");
    const [games, { collections, memberships }, vaultState, genrePreferences, genrePreferenceGlobals, playtime] = await Promise.all([
      listGames(session.user_id),
      listCollectionsWithMemberships(session.user_id, { includeSmartCounts: false }),
      getVaultState(session.user_id),
      listGenrePreferences(session.user_id),
      listGenrePreferenceGlobals(),
      getPlaytimeSummary(session.user_id)
    ]);

    // After the games, because it is scoped to the ones this account owns.
    const gamePreferences = await listGamePreferenceGlobals(
      games.map((game) => Number(game.steam_appid))
    );

    return jsonWithSessionRefresh({
      session,
      games,
      collections,
      memberships,
      vaultState,
      genrePreferences,
      genrePreferenceGlobals,
      gamePreferences,
      playtime
    });
  } catch (error) {
    diagnostics.event("failed", { status: 503 }, error);
    return diagnostics.response(await jsonWithSessionRefresh(
      { error: "Your VaultShuffle data could not be loaded.", session, data_error: true },
      { status: 503 }
    ));
  }
}
