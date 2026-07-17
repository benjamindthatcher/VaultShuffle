import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";

const eventSchema = z.object({
  draw_id: z.string().uuid(),
  event_type: z.enum([
    "opened_on_steam",
    "pinned",
    "unpinned",
    "drew_again",
    "hidden_for_session",
    "snoozed_7_days",
    "snoozed_30_days",
    "slept",
    "marked_completed",
    "restored"
  ])
});

export async function POST(request: Request) {
  try {
    const { user } = await requireSession();
    const input = eventSchema.parse(await readJsonBody(request));
    const supabase = getSupabaseAdmin();
    const { data: draw, error: drawError } = await supabase
      .from("vault_draws")
      .select("id")
      .eq("id", input.draw_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (drawError) throw drawError;
    if (!draw) return NextResponse.json({ error: "Draw not found." }, { status: 404 });

    const { data, error } = await supabase
      .from("vault_draw_events")
      .insert({ user_id: user.id, draw_id: input.draw_id, event_type: input.event_type })
      .select("id, draw_id, event_type, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json({
      event: {
        id: data.id,
        drawId: data.draw_id,
        eventType: data.event_type,
        createdAt: data.created_at
      }
    }, { status: 201 });
  } catch (error) {
    return jsonError(error, 500);
  }
}
