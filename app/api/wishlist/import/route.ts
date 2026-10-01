import { NextResponse } from "next/server";
import { requireWriteSession } from "@/lib/auth";
import { assertSameOrigin, jsonError, HttpError } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase";
import { importSteamWishlistIds } from "@/lib/wishlist-server";
import { isV2Authority } from "@/lib/database-authority";
import { currentV2Session } from "@/lib/v2/current-session";
import { getV2Runtime } from "@/lib/v2/runtime";
import { SessionRequiredError } from "@/lib/auth";

export async function POST(request:Request) {
  try {
    assertSameOrigin(request);
    const { user } = await requireWriteSession();
    await enforceRateLimit({ bucket: "wishlist_import", identity: `user:${user.id}`, limit: 3, windowSeconds: 300, message: "Please wait a few minutes before importing your Steam wishlist again." });
    const ids = await importSteamWishlistIds(user.steam_id);
    // A single statement is atomic and duplicate-safe. Import never deletes a
    // local save or writes anything back to Steam.
    if (ids.length > 10000) throw new HttpError("This Steam wishlist is too large to import (maximum 10,000 games).", 422);
    if(isV2Authority()) {
      const session=await currentV2Session();
      if(!session||session.user.id!==user.id) throw new SessionRequiredError();
      await (await getV2Runtime()).wishlist.save(session.principal,ids,"steam");
      return NextResponse.json({imported:ids.length},{headers:{"Cache-Control":"private, no-store"}});
    }
    if (ids.length) {
      const { error } = await getSupabaseAdmin().from("user_wishlist").upsert(ids.map((appId) => ({ user_id: user.id, steam_appid: appId, source: "steam" })), { onConflict: "user_id,steam_appid", ignoreDuplicates: true });
      if (error) throw error;
    }
    return NextResponse.json({ imported: ids.length });
  } catch (error) { return jsonError(error); }
}
