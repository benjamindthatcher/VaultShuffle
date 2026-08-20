import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteSession } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { recordCompletionClaim, recordCompletionUndone } from "@/lib/completion-events";

const schema = z.object({
  game_id: z.string().uuid(),
  action: z.enum(["claimed", "undone"]),
  source: z.enum(["sweep", "sweep_bulk", "library", "vault", "purge", "details"]).optional(),
  hours_played: z.number().nonnegative().nullable().optional(),
  estimate_minutes: z.number().int().nonnegative().nullable().optional(),
  price_cents: z.number().int().nonnegative().nullable().optional()
});

export async function POST(request: Request) {
  try {
    const { user } = await requireWriteSession();
    const input = schema.parse(await readJsonBody(request));

    if (input.action === "undone") {
      await recordCompletionUndone(user.id, input.game_id);
    } else {
      await recordCompletionClaim(user.id, {
        gameId: input.game_id,
        source: input.source ?? "library",
        hoursPlayed: input.hours_played,
        estimateMinutes: input.estimate_minutes,
        priceCents: input.price_cents
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
