import { parseSteamWishlist } from "./wishlist.ts";

export class SteamWishlistError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "SteamWishlistError"; this.status = status; }
}

/** Public server-side import. OpenID identifies a user; it does not grant a
 * website permission to read that user's private Steam wishlist. */
export async function fetchSteamWishlistIds(steamId: string, request: typeof fetch = fetch): Promise<number[]> {
  if (!/^\d{17}$/.test(steamId)) throw new SteamWishlistError("Reconnect your Steam profile before importing its wishlist.", 422);
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await request(`https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    } catch {
      if (attempt === 0) continue;
      throw new SteamWishlistError("Steam did not respond in time. Your saved games are safe; try importing again shortly.", 502);
    }
    const result = response.headers.get("x-eresult");
    if ([401, 403].includes(response.status) || result === "15") throw new SteamWishlistError("Steam cannot share this wishlist. Set both My profile and Game details to Public in Steam’s Privacy Settings, then retry. Signing in here does not unlock a private wishlist.", 422);
    if (response.status === 429 || result === "84") throw new SteamWishlistError("Steam is limiting wishlist requests. Wait a few minutes, then retry. Your saved games have not changed.", 429);
    if (!response.ok || (result && result !== "1")) {
      if (attempt === 0 && (response.status >= 500 || result === "2")) continue;
      throw new SteamWishlistError("Steam could not provide your wishlist right now. Please retry later; your saved games have not changed.", 502);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new SteamWishlistError("Steam returned an unreadable wishlist. Please retry later; your saved games have not changed.", 502); }
    try { return parseSteamWishlist(payload, result); }
    catch { throw new SteamWishlistError("Steam returned an incomplete or inaccessible wishlist. Check your Steam privacy settings and retry. Your saved games have not changed.", 422); }
  }
  throw new SteamWishlistError("Steam is unavailable. Please retry shortly.", 502);
}
