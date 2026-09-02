import { NextResponse } from "next/server";
import { requireWriteSession } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { assertFamilySharingEnabled } from "@/lib/family-flag";
import { removeFamilyMember } from "@/lib/family-members";
import { familyError } from "../route";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Stop borrowing from one person.
 *
 * Games another remaining member also shares stay put - access has not gone,
 * only one route to it. Anything the player has actually written a note on or
 * marked finished is retired rather than deleted, so losing access never
 * destroys their own record of having played it.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const diagnostics = requestDiagnostics(request, "family_member_remove");
  try {
    assertFamilySharingEnabled();
    assertSameOrigin(request);
    const [{ user }, { id }] = await Promise.all([requireWriteSession(), context.params]);
    diagnostics.account(user.id, user.account_type);
    const result = await removeFamilyMember(user.id, id);
    diagnostics.event("succeeded", { removed: result.removed, retained: result.retained, status: 200 });
    return diagnostics.response(NextResponse.json({ ok: true, ...result }));
  } catch (error) {
    return familyError(error, diagnostics);
  }
}
