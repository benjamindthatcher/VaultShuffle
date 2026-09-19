import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  attachSessionCookie,
  createManualProfileSession,
} from "@/lib/auth";
import { assertSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import {
  ManualSteamProfileError,
  verifyManualSteamProfileLookup,
} from "@/lib/manual-steam-profile";
import { enforceRateLimit, requestFingerprint } from "@/lib/rate-limit";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { steamSetupCache } from "@/lib/steam-setup-cache";
import { deleteLibrarySnapshot, readLibrarySnapshot } from "@/lib/steam-library-snapshot";
import { stageSteamImport } from "@/lib/steam-import-jobs";

const STEAM_IMPORT_COOKIE = "vault_steam_import";
const requestSchema = z.object({
  lookup_token: z.string().min(40).max(5000),
  display_name: z.string().trim().min(1, "Choose a name for your Vault.").max(80),
}).strict();

export async function POST(request: Request) {
  const diagnostics = requestDiagnostics(request, "manual_profile_create");
  try {
    assertSameOrigin(request);
    diagnostics.stage("validation_and_rate_limit");
    await enforceRateLimit({
      bucket: "manual_profile_create",
      identity: requestFingerprint(request),
      limit: 6,
      windowSeconds: 60 * 60,
      message: "Several public-profile sign-ins came from this connection recently. Please wait before trying again.",
    });

    const input = requestSchema.parse(await readJsonBody(request, 8 * 1024));
    const lookup = verifyManualSteamProfileLookup(input.lookup_token);
    diagnostics.stage("account_and_session_create");
    const { token, user, resumed } = await createManualProfileSession({
      steamId: lookup.steamId,
      profileUrl: lookup.profileUrl,
      displayName: input.display_name,
      steamDisplayName: lookup.displayName,
      avatarUrl: lookup.avatarUrl,
    });

    diagnostics.account(user.id, "manual");
    // The account/session step has succeeded. Cache/staging trouble on a new
    // profile must not hide its cookie and invite an accidental second attempt.
    if (!resumed) {
      diagnostics.stage("setup_library_handoff");
      try {
        const cache = steamSetupCache();
        const games = await readLibrarySnapshot(cache, lookup.snapshotId, lookup.steamId);
        if (games) {
          await stageSteamImport(user.id, games);
          if (lookup.snapshotId) after(() => deleteLibrarySnapshot(cache, lookup.snapshotId!, games.length).catch(() => undefined));
          // The one success worth reporting on this route: without it a cache
          // hit is invisible and only misses are counted, so there is no hit
          // rate to read. Manual profile creation runs ~150 times a month.
          diagnostics.event("succeeded", { cache_result: "hit", game_count: games.length });
        } else diagnostics.event("warning", { cache_result: "miss" });
      } catch (error) {
        diagnostics.event("warning", { cache_result: "handoff_failed" }, error);
      }
    }
    diagnostics.stage("session_cookie_and_redirect");

    const response = NextResponse.json({
      ok: true,
      redirect_to: "/dashboard",
      sign_in_mode: resumed ? "resumed" : "created",
      account: {
        id: user.id,
        steam_id: user.steam_id,
        account_type: user.account_type,
        identity_verified: false,
        display_name: user.display_name,
        steam_display_name: user.steam_display_name ?? lookup.displayName,
        avatar_url: user.avatar_url,
        game_count: lookup.gameCount,
        input_type: lookup.inputType,
      },
    });
    if (!resumed) {
      response.cookies.set({
        name: STEAM_IMPORT_COOKIE,
        value: "1",
        httpOnly: false,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 5 * 60,
      });
    }
    return diagnostics.response(attachSessionCookie(response, token));
  } catch (error) {
    if (error instanceof ManualSteamProfileError) {
      const status = error.code === "lookup_expired" || error.code === "invalid_lookup" ? 400 : 502;
      diagnostics.event("failed", { status }, error);
      return diagnostics.response(NextResponse.json({ error: error.message, code: error.code }, { status }));
    }
    return jsonError(error, 500, diagnostics);
  }
}
