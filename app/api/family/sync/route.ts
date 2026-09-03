import { NextResponse } from "next/server";
import { requireWriteSession } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { assertFamilySharingEnabled } from "@/lib/family-flag";
import { recheckFamilyLibrary } from "@/lib/family-members";
import { familyError } from "../route";

export const maxDuration = 60;

/**
 * Re-decide what the family shelves contribute, without asking Steam anything.
 *
 * Every member's candidate list is already stored, so this is purely a catalogue
 * question: which of the games we could not judge last time can we judge now.
 * That is the whole point of holding the candidates - a title with no categories
 * yet is unjudgeable today and answerable next week, and re-reading six public
 * libraries to find that out would be absurd.
 */
export async function POST(request: Request) {
  const diagnostics = requestDiagnostics(request, "family_library_recheck");
  try {
    assertFamilySharingEnabled();
    assertSameOrigin(request);
    const { user } = await requireWriteSession();
    diagnostics.account(user.id, user.account_type);

    await enforceRateLimit({
      bucket: "family_library_recheck",
      identity: `user:${user.id}`,
      limit: 6,
      windowSeconds: 60 * 60,
      message: "Your family library was re-checked recently. Catalogue details fill in over hours, not seconds."
    });

    const counts = await recheckFamilyLibrary(user.id);
    return diagnostics.response(NextResponse.json({ ok: true, counts }));
  } catch (error) {
    return familyError(error, diagnostics);
  }
}
