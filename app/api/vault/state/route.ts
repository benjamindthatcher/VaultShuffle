import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, requireWriteSession, unauthorizedResponse } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { getVaultState, recordVaultAction } from "@/lib/vault-state";

const vaultActionSchema = z.object({
  action: z.enum(["pinned", "unpinned", "snoozed", "unsnoozed"]),
  game_id: z.string().uuid(),
  context: z.record(z.string().max(80), z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.string().max(80)).max(20)])).optional().default({})
}).strict();

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json(await getVaultState(user.id));
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) {
      return unauthorizedResponse();
    }
    return jsonError(error, 500);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireWriteSession();
    const payload = vaultActionSchema.parse(await readJsonBody(request));
    return NextResponse.json(await recordVaultAction(user.id, payload.action, payload.game_id, payload.context));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes("sign-in") ? 401 : 400);
  }
}
