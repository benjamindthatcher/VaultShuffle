import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteSession } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { restoreGameToActive } from "@/lib/games";

const restorePayloadSchema = z.object({
  game_ids: z.array(z.string().uuid()).min(1).max(500)
}).strict();

/**
 * Wake a batch of games in one request.
 *
 * Waking fifty games one PATCH at a time is fifty writes against a budget of a
 * hundred and twenty a minute, so a user asking for something entirely
 * reasonable - "put my slept games back so I can go through them again" - got
 * told they were moving too quickly. The answer is not a larger budget; it is
 * one request for one intent, which is what the flags endpoint already does.
 *
 * Each restore is applied in turn rather than in parallel: the RPC takes a
 * per-user advisory lock, so firing them at once only makes them queue behind
 * each other with fifty connections held open instead of one.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireWriteSession();
    const { game_ids: gameIds } = restorePayloadSchema.parse(await readJsonBody(request));

    let restored = 0;
    const failed: string[] = [];
    for (const gameId of gameIds) {
      try {
        if (await restoreGameToActive(user.id, gameId)) restored += 1;
      } catch {
        // One game that will not wake should not cost the caller the other
        // forty-nine, so the failures are reported rather than thrown.
        failed.push(gameId);
      }
    }

    return NextResponse.json({ restored, failed });
  } catch (error) {
    return jsonError(error);
  }
}
