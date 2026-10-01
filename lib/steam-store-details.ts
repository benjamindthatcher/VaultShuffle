import type { GamePayload } from "./types.ts";
import { steamImageUrl } from "./images.ts";
import { normaliseSteamGenreLabel } from "./genres.ts";

export type SteamAppDetails = Partial<GamePayload> & {
  steam_type?: string;
  /**
   * Set by Steam on a demo or a DLC to name the app it belongs to. It is the
   * only field that catches content whose own type has drifted - the RACE 07
   * expansion SKUs are typed `game` in Steam's PICS record and still cannot
   * launch without RACE 07.
   */
  full_game_appid?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  categories?: string[];
  short_description?: string;
  release_date?: string | null;
  review_score_desc?: string;
  review_total?: number;
  review_positive?: number;
  price_currency?: string;
  price_initial?: number;
  price_final?: number;
  discount_percent?: number;
  is_free?: boolean;
  platform_windows?: boolean;
  platform_mac?: boolean;
  platform_linux?: boolean;
};

export function steamDetailPayload(appid: string, data: Record<string, unknown>): SteamAppDetails {
  const headerImage = String(data.header_image ?? "").trim();
  const price = data.price_overview && typeof data.price_overview === "object"
    ? data.price_overview as Record<string, unknown>
    : null;
  const fullGame = data.fullgame && typeof data.fullgame === "object"
    ? data.fullgame as Record<string, unknown>
    : null;
  // Some legacy store pages point `fullgame` at themselves (Full Pipe, 4600).
  // A self-reference says nothing about belonging to a parent app.
  const fullGameAppId = String(fullGame?.appid ?? "").trim();
  const parentAppId = fullGameAppId && fullGameAppId !== String(appid) ? fullGameAppId : "";
  return {
    steam_type: String(data.type ?? "").trim().toLowerCase() || undefined,
    full_game_appid: parentAppId || undefined,
    title: String(data.name ?? "").trim() || undefined,
    genre: steamGenreLabel(data, String(data.name ?? "")) || undefined,
    store: "Steam",
    notes: "",
    steam_appid: appid,
    capsule_url: steamImageUrl(appid, "capsule"),
    header_url: headerImage || steamImageUrl(appid, "header"),
    price_currency: cleanCurrency(price?.currency),
    price_initial: cleanMinorUnits(price?.initial),
    price_final: cleanMinorUnits(price?.final),
    discount_percent: clamp(Math.round(Number(price?.discount_percent || 0)), 0, 100),
    is_free: Boolean(data.is_free),
    // Steam already tells us this on the call we are making; it costs nothing.
    platform_windows: Boolean((data.platforms as Record<string, unknown> | undefined)?.windows),
    platform_mac: Boolean((data.platforms as Record<string, unknown> | undefined)?.mac),
    platform_linux: Boolean((data.platforms as Record<string, unknown> | undefined)?.linux),
    developers: stringList(data.developers),
    publishers: stringList(data.publishers),
    genres: descriptionList(data.genres),
    categories: descriptionList(data.categories),
    short_description: String(data.short_description ?? "").trim() || undefined,
    release_date: steamReleaseDate(data.release_date)
  };
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}
function descriptionList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : String((item as Record<string, unknown>)?.description ?? ""))
    .map((item) => item.trim()).filter(Boolean);
}
function steamReleaseDate(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const raw = String((value as Record<string, unknown>).date ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function cleanCurrency(value: unknown) {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function cleanMinorUnits(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : undefined;
}


function steamGenreLabel(item: Record<string, unknown>, title = "") {
  const genreList = Array.isArray(item.genres) ? item.genres : [];
  const genres = genreList
    .map((genre) => (typeof genre === "string" ? genre : String((genre as Record<string, unknown>)?.description ?? "")))
    .map((genre) => genre.trim())
    .filter(Boolean);
  const genreText = String(item.genre ?? "").trim();
  const allGenres = [...genres, ...genreText.split(/[\/,;|]+/g)];
  return normaliseSteamGenreLabel(allGenres, title);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
