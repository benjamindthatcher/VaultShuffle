import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { recordVaultAction } from "@/lib/vault-state";
import { jsonError, readJsonBody } from "@/lib/http";

const drawSchema = z.object({
  game_id: z.string().uuid(), steam_app_id: z.number().int().positive(),
  session: z.enum(["short", "evening", "weekend"]), mood: z.enum(["brain-off", "chill", "intense"]), goal: z.enum(["new", "finish", "surprise"]),
  collection_id: z.string().nullable(), selected_genres: z.array(z.string()).max(3), eligible_pool_count: z.number().int().nonnegative(), reroll_index: z.number().int().nonnegative()
});

export async function GET() {
  try {
    const { user } = await requireSession();
    const supabase = getSupabaseAdmin();
    const { data: draws, error } = await supabase.from("vault_draws").select("id, steam_appid, drawn_at, session, mood, goal, collection_id, selected_genres, eligible_pool_count, reroll_index").eq("user_id", user.id).order("drawn_at", { ascending: false }).limit(50);
    if (error) throw error;
    const ids = (draws ?? []).map((draw) => draw.id);
    const { data: events, error: eventError } = ids.length ? await supabase.from("vault_draw_events").select("id, draw_id, event_type, created_at").eq("user_id", user.id).in("draw_id", ids).order("created_at", { ascending: false }) : { data: [], error: null };
    if (eventError) throw eventError;
    return NextResponse.json({ draws: (draws ?? []).map((draw) => ({ id: draw.id, steamAppId: Number(draw.steam_appid), drawnAt: draw.drawn_at, session: draw.session, mood: draw.mood, goal: draw.goal, collectionId: draw.collection_id, selectedGenres: draw.selected_genres ?? [], eligiblePoolCount: draw.eligible_pool_count, rerollIndex: draw.reroll_index, events: (events ?? []).filter((event) => event.draw_id === draw.id).map((event) => ({ id: event.id, drawId: event.draw_id, eventType: event.event_type, createdAt: event.created_at })) })) });
  } catch (error) { if (error instanceof Error && error.message.includes("sign-in")) return unauthorizedResponse(); return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireSession();
    const input = drawSchema.parse(await readJsonBody(request));
    const state = await recordVaultAction(user.id, "drawn", input.game_id, { session: input.session, mood: input.mood, goal: input.goal, collection_id: input.collection_id, genres: input.selected_genres });
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("vault_draws").insert({ user_id: user.id, steam_appid: input.steam_app_id, session: input.session, mood: input.mood, goal: input.goal, collection_id: input.collection_id, selected_genres: input.selected_genres, eligible_pool_count: input.eligible_pool_count, reroll_index: input.reroll_index }).select("id, drawn_at").single();
    if (error) throw error;
    return NextResponse.json({ state, draw: { id: data.id, steamAppId: input.steam_app_id, drawnAt: data.drawn_at, session: input.session, mood: input.mood, goal: input.goal, collectionId: input.collection_id, selectedGenres: input.selected_genres, eligiblePoolCount: input.eligible_pool_count, rerollIndex: input.reroll_index, events: [] } }, { status: 201 });
  } catch (error) { return jsonError(error, error instanceof Error && error.message.includes("sign-in") ? 401 : 400); }
}

export async function DELETE() {
  try { const { user } = await requireSession(); const { error } = await getSupabaseAdmin().from("vault_draws").delete().eq("user_id", user.id); if (error) throw error; return NextResponse.json({ ok: true }); }
  catch (error) { return jsonError(error, error instanceof Error && error.message.includes("sign-in") ? 401 : 400); }
}
