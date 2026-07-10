import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { getVaultState, recordVaultAction } from "@/lib/vault-state";

const vaultActionSchema = z.object({
  action: z.enum(["drawn", "pinned", "unpinned", "snoozed", "unsnoozed"]),
  game_id: z.string().uuid(),
  context: z.record(z.string(), z.unknown()).optional().default({})
});

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json(await getVaultState(user.id));
  } catch {
    return unauthorizedResponse();
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireSession();
    const payload = vaultActionSchema.parse(await request.json());
    return NextResponse.json(await recordVaultAction(user.id, payload.action, payload.game_id, payload.context));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes("sign-in") ? 401 : 400);
  }
}
