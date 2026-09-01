import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import {
  lookupManualSteamProfile,
  ManualSteamProfileError,
  signManualSteamProfileLookup,
} from "@/lib/manual-steam-profile";
import { enforceRateLimit, requestFingerprint } from "@/lib/rate-limit";
import { SteamProfileInputError } from "@/lib/steam-profile-input";
import { requestDiagnostics } from "@/lib/diagnostics-server";

const requestSchema = z.object({
  profile: z.string().trim().min(1, "Enter a Steam profile URL or ID.").max(300),
}).strict();

export async function POST(request: Request) {
  const diagnostics = requestDiagnostics(request, "manual_profile_lookup");
  diagnostics.event("started");
  try {
    diagnostics.stage("validation_and_rate_limit");
    assertSameOrigin(request);
    await enforceRateLimit({
      bucket: "manual_profile_lookup",
      identity: requestFingerprint(request),
      limit: 20,
      windowSeconds: 10 * 60,
      message: "Too many Steam profiles were checked from this connection. Please wait before trying again.",
    });
    const input = requestSchema.parse(await readJsonBody(request, 1024));
    diagnostics.stage("steam_lookup");
    const profile = await lookupManualSteamProfile(input.profile, diagnostics);
    diagnostics.event("succeeded", { game_count: profile.gameCount });
    return diagnostics.response(NextResponse.json(
      {
        profile: {
          display_name: profile.displayName,
          avatar_url: profile.avatarUrl,
          game_count: profile.gameCount,
          input_type: profile.inputType,
        },
        lookup_token: signManualSteamProfileLookup(profile),
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    ));
  } catch (error) {
    if (error instanceof SteamProfileInputError) {
      diagnostics.event("failed", { status: 400 }, error);
      return diagnostics.response(NextResponse.json({ error: error.message, code: error.code }, { status: 400 }));
    }
    if (error instanceof ManualSteamProfileError) {
      const status = error.code === "profile_not_found"
        ? 404
        : ["library_private", "library_empty", "library_unavailable"].includes(error.code)
          ? 409
          : 502;
      diagnostics.event("failed", { status }, error);
      return diagnostics.response(NextResponse.json({ error: error.message, code: error.code }, { status }));
    }
    return jsonError(error, 502, diagnostics);
  }
}
