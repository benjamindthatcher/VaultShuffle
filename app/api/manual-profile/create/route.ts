import { NextResponse } from "next/server";
import { z } from "zod";
import {
  attachSessionCookie,
  createManualProfileSession,
  getCurrentSession,
} from "@/lib/auth";
import { assertSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import {
  ManualSteamProfileError,
  verifyManualSteamProfileLookup,
} from "@/lib/manual-steam-profile";
import { enforceRateLimit, requestFingerprint } from "@/lib/rate-limit";

const STEAM_IMPORT_COOKIE = "vault_steam_import";
const requestSchema = z.object({
  lookup_token: z.string().min(40).max(5000),
  display_name: z.string().trim().min(1, "Choose a name for your Vault.").max(80),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const currentSession = await getCurrentSession();
    if (currentSession) {
      return NextResponse.json(
        { error: "You already have a VaultShuffle profile in this browser.", code: "session_exists" },
        { status: 409 },
      );
    }

    await enforceRateLimit({
      bucket: "manual_profile_create",
      identity: requestFingerprint(request),
      limit: 6,
      windowSeconds: 60 * 60,
      message: "Several profiles were created from this connection recently. Please wait before creating another.",
    });

    const input = requestSchema.parse(await readJsonBody(request, 8 * 1024));
    const lookup = verifyManualSteamProfileLookup(input.lookup_token);
    const { token, user } = await createManualProfileSession({
      steamId: lookup.steamId,
      profileUrl: lookup.profileUrl,
      displayName: input.display_name,
      steamDisplayName: lookup.displayName,
      avatarUrl: lookup.avatarUrl,
    });

    const response = NextResponse.json({
      ok: true,
      redirect_to: "/dashboard",
      account: {
        id: user.id,
        steam_id: user.steam_id,
        account_type: user.account_type,
        identity_verified: false,
        display_name: user.display_name,
        steam_display_name: lookup.displayName,
        avatar_url: user.avatar_url,
        game_count: lookup.gameCount,
        input_type: lookup.inputType,
      },
    });
    response.cookies.set({
      name: STEAM_IMPORT_COOKIE,
      value: "1",
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 5 * 60,
    });
    return attachSessionCookie(response, token);
  } catch (error) {
    if (error instanceof ManualSteamProfileError) {
      const status = error.code === "lookup_expired" || error.code === "invalid_lookup" ? 400 : 502;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return jsonError(error, 500);
  }
}
