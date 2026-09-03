import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, requireWriteSession, SessionRequiredError, unauthorizedResponse } from "@/lib/auth";
import { assertSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { assertFamilySharingEnabled, FamilyDisabledError } from "@/lib/family-flag";
import { addFamilyMember, FamilyMemberError, listFamilyMembers } from "@/lib/family-members";
import { describeFamilyImport, MAX_FAMILY_MEMBERS } from "@/lib/family-sharing";
import { SteamProfileInputError } from "@/lib/steam-profile-input";

/** Reading a whole public Steam library takes a moment, and adding one is rare. */
export const maxDuration = 60;

const addSchema = z.object({
  profile: z.string().trim().min(2, "Enter a Steam profile URL or 17-digit Steam ID.").max(300)
}).strict();

export async function GET(request: Request) {
  const diagnostics = requestDiagnostics(request, "family_members_list");
  try {
    assertFamilySharingEnabled();
    const { user } = await requireSession();
    diagnostics.account(user.id, user.account_type);
    return diagnostics.response(NextResponse.json({
      enabled: true,
      max_members: MAX_FAMILY_MEMBERS,
      members: await listFamilyMembers(user.id)
    }));
  } catch (error) {
    return familyError(error, diagnostics);
  }
}

export async function POST(request: Request) {
  const diagnostics = requestDiagnostics(request, "family_member_add");
  try {
    assertFamilySharingEnabled();
    diagnostics.stage("session_check");
    assertSameOrigin(request);
    const { user } = await requireWriteSession();
    diagnostics.account(user.id, user.account_type);

    // Each add reads a whole public library from Steam. Loose enough to correct
    // a typo several times over, tight enough that this cannot become a way to
    // walk Steam's API through our key.
    diagnostics.stage("rate_limit");
    await enforceRateLimit({
      bucket: "family_member_add",
      identity: `user:${user.id}`,
      limit: 12,
      windowSeconds: 60 * 60,
      message: "Several family members were checked recently. Please wait a little before adding another."
    });

    const input = addSchema.parse(await readJsonBody(request, 4 * 1024));
    diagnostics.stage("steam_profile_and_library");
    const { member, counts, truncated } = await addFamilyMember(user.id, user.steam_id, input.profile);

    // A shelf big enough to hit the cap is told about it. Silently reading the
    // first five thousand and reporting that as the whole library would be the
    // one number on this screen that was simply untrue.
    const summary = describeFamilyImport(counts, member?.displayName ?? "That profile")
      + (truncated ? ` Their library is larger than we read — ${truncated} more games were not checked.` : "");
    return diagnostics.response(NextResponse.json({ ok: true, member, counts, truncated, summary }));
  } catch (error) {
    return familyError(error, diagnostics);
  }
}

/**
 * One place that turns every family failure into a status and a code.
 *
 * The browser has to be able to tell "that profile is private" from "you have
 * reached the limit" without reading the sentence, which is exactly the mistake
 * the Steam import made before it grew a code.
 */
export function familyError(error: unknown, diagnostics: ReturnType<typeof requestDiagnostics>) {
  if (error instanceof FamilyDisabledError) {
    // A 404, not a 403. A feature that is not switched on should not confirm it
    // exists to anyone poking at routes.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (error instanceof SessionRequiredError) return unauthorizedResponse();
  if (error instanceof SteamProfileInputError) {
    diagnostics.event("failed", { status: 400, error_code: error.code }, error);
    return diagnostics.response(NextResponse.json({ error: error.message, code: error.code }, { status: 400 }));
  }
  if (error instanceof FamilyMemberError) {
    const status = error.code === "limit_reached" || error.code === "already_added" || error.code === "is_self"
      ? 409
      : error.code === "not_found"
        ? 404
        : error.code === "steam_unavailable"
          ? 502
          : 400;
    diagnostics.event("failed", { status, error_code: error.code }, error);
    return diagnostics.response(NextResponse.json({ error: error.message, code: error.code }, { status }));
  }
  return jsonError(error, 500, diagnostics);
}
