import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, requireWriteSession } from "@/lib/auth";
import { assertSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";
import { listWishlistRows, steamWishlistGame, wishlistGames } from "@/lib/wishlist-server";
import { WISHLIST_PAGE_SIZE } from "@/lib/wishlist";
import { isV2Authority } from "@/lib/database-authority";
import { currentV2Session } from "@/lib/v2/current-session";
import { getV2Runtime } from "@/lib/v2/runtime";
import { SessionRequiredError } from "@/lib/auth";

const appSchema = z.object({ appId: z.number().int().min(1).max(4294967295) });

export async function GET(request: Request) {
  try {
    const { user } = await requireSession();
    const offset = z.coerce.number().int().min(0).max(100000).parse(new URL(request.url).searchParams.get("offset") ?? 0);
    if(isV2Authority()) {
      const session=await currentV2Session();
      if(!session||session.user.id!==user.id) throw new SessionRequiredError();
      const page=await (await getV2Runtime()).wishlist.list(session.principal,offset);
      const games=await wishlistGames(page.items.map(item=>item.appId));
      return NextResponse.json({games:games.map((game,i)=>({...game,source:page.items[i].source,addedAt:page.items[i].addedAt})),appIds:page.appIds,total:page.total}, {headers:{"Cache-Control":"private, no-store"}});
    }
    const rows = await listWishlistRows(user.id);
    const page = rows.slice(offset, offset + WISHLIST_PAGE_SIZE);
    const games = await wishlistGames(page.map((row) => Number(row.steam_appid)));
    return NextResponse.json({ games: games.map((game, i) => ({ ...game, source: page[i].source, addedAt: page[i].added_at })), appIds: rows.map((row) => Number(row.steam_appid)), total: rows.length });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { user } = await requireWriteSession();
    const { appId } = appSchema.parse(await readJsonBody(request));
    // Validate against Steam, never trust a submitted title or image URL.
    const game = await steamWishlistGame(appId);
    if(isV2Authority()) {
      const session=await currentV2Session();
      if(!session||session.user.id!==user.id) throw new SessionRequiredError();
      await (await getV2Runtime()).wishlist.save(session.principal,[appId],"local");
      return NextResponse.json({game},{headers:{"Cache-Control":"private, no-store"}});
    }
    const { error } = await getSupabaseAdmin().from("user_wishlist").upsert({ user_id: user.id, steam_appid: appId, source: "local" }, { onConflict: "user_id,steam_appid", ignoreDuplicates: true });
    if (error) throw error;
    return NextResponse.json({ game });
  } catch (error) { return jsonError(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const { user } = await requireWriteSession();
    const { appId } = appSchema.parse(await readJsonBody(request));
    if(isV2Authority()) {
      const session=await currentV2Session();
      if(!session||session.user.id!==user.id) throw new SessionRequiredError();
      await (await getV2Runtime()).wishlist.remove(session.principal,appId);
      return NextResponse.json({ok:true},{headers:{"Cache-Control":"private, no-store"}});
    }
    const { error } = await getSupabaseAdmin().from("user_wishlist").delete().eq("user_id", user.id).eq("steam_appid", appId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(error); }
}
