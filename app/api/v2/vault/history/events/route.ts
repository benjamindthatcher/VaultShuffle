import { z } from "zod";
import { v2Write, v2JsonBody } from "@/lib/v2/http/request";
import { InvalidPageQueryError } from "@/lib/v2/repositories/page-errors";
export const runtime = "nodejs";
const event = z.object({ draw_id:z.string().uuid(),request_key:z.string().uuid(),event_type:z.enum([
  "opened_on_steam","play_now_intent","liked","disliked","reroll_too_long","reroll_wrong_mood",
  "reroll_played_enough","reroll_not_interested","reroll_not_tonight","pinned","unpinned","drew_again",
  "hidden_for_session","snoozed_7_days","snoozed_30_days","slept","marked_completed","restored",
]) }).strict();
export async function POST(request: Request) {
  return v2Write(request, async (services, principal) => {
    const parsed = event.safeParse(await v2JsonBody(request));
    if (!parsed.success) throw new InvalidPageQueryError();
    return services.vault.event(principal, parsed.data.draw_id, parsed.data.event_type, parsed.data.request_key);
  });
}
