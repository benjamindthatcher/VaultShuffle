import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteSession } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { patchGame } from "@/lib/games";
import { recordCompletionClaim } from "@/lib/completion-events";

const completionBatchSchema = z.object({
  action: z.enum(["claimed", "dismissed"]),
  games: z.array(z.object({
    id: z.string().uuid(),
    // The dismissal records playtime so the sweep asks again after another real
    // session rather than on the next page load; the claim carries it, and the
    // estimate and price, for the ledger row.
    hours_played: z.coerce.number().min(0).optional(),
    estimate_minutes: z.number().int().nonnegative().nullable().optional(),
    price_cents: z.number().int().nonnegative().nullable().optional()
  })).min(1).max(500)
}).strict();

/**
 * Settle a batch of completion suggestions in one request.
 *
 * The sweep's select-all is one intent, and it was being sent as one write per
 * game. A hundred and twenty writes a minute is the budget, so somebody with a
 * long sweep - exactly the person the bulk button exists for - was told they
 * were moving too quickly halfway through their own sweep. Waking games hit this
 * first and was fixed the same way; this is the other half of it.
 *
 * Applied in turn rather than in parallel, matching /api/games/restore: these
 * are writes to the same user's rows, and firing five hundred at once only holds
 * five hundred connections open to do the same work.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireWriteSession();
    const { action, games } = completionBatchSchema.parse(await readJsonBody(request, 64 * 1024));

    const now = new Date().toISOString();
    let updated = 0;
    const failed: string[] = [];

    for (const game of games) {
      try {
        const patch = action === "claimed"
          ? { status: "Completed" as const, completed_at: now, slept_at: null }
          : {
            completion_suggestion_dismissed_at: now,
            completion_suggestion_dismissed_playtime: game.hours_played ?? 0
          };
        if (!(await patchGame(user.id, game.id, patch))) continue;
        updated += 1;

        // The ledger row goes in the same request. Claiming used to send a
        // second write per game to /api/completions, so a bulk sweep cost two
        // writes a game against the same budget - the reason a long sweep ran
        // out halfway through.
        if (action === "claimed") {
          await recordCompletionClaim(user.id, {
            gameId: game.id,
            source: "sweep_bulk",
            hoursPlayed: game.hours_played ?? null,
            estimateMinutes: game.estimate_minutes ?? null,
            priceCents: game.price_cents ?? null
          }).catch(() => undefined);
        }
      } catch {
        // One row that will not take should not cost the caller the rest of the
        // sweep, so failures are reported rather than thrown.
        failed.push(game.id);
      }
    }

    return NextResponse.json({ updated, failed });
  } catch (error) {
    return jsonError(error);
  }
}
