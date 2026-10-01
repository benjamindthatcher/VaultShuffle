import { v2Read, v2Write, v2JsonBody } from "@/lib/v2/http/request";
import { libraryGameId } from "@/lib/v2/http/library-query";
import { gameChange } from "@/lib/v2/http/game-change";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return v2Read((services, principal) => services.library.detail(principal, libraryGameId(id)));
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return v2Write(request,async (services,principal) => {
    const gameId = libraryGameId(id);
    const change = gameChange(await v2JsonBody(request));
    let receipt;
    if ("action" in change) receipt = await services.mutations.decideWithVersion(principal,gameId,change.action,change.request_key,change.surface);
    else if ("restore_decision" in change) {
      const previous=change.restore_decision;
      receipt=await services.mutations.restoreDecision(principal,gameId,{status:previous.status,completedAt:previous.completed_at,expectedVersion:previous.expected_version});
    } else if ("dismiss_completion" in change) await services.mutations.dismissCompletion(principal,gameId,change.dismiss_completion);
    else if ("progress" in change) await services.mutations.progress(principal,gameId,change.progress);
    else await services.mutations.notes(principal,gameId,change.notes);
    const card=await services.library.detail(principal,gameId);
    return card ? {...card,...(receipt?{mutationVersion:receipt.mutationVersion}:{})} : null;
  });
}
