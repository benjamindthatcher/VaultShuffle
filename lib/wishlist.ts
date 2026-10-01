import type { DemoGame } from "./demo-data.ts";
import { editionKey, playNextTagProfile, seriesKey, tagKey } from "./play-next.ts";
import { isSteamStoreCountry, steamBudgetBand } from "./steam-store-regions.ts";

export type WishlistGame = {
  appId: number;
  title: string;
  image: string;
  genres: string[];
  tags?: Record<string, number>;
  minutes?: number | null;
  endless?: boolean;
  positive?: number | null;
  reviews?: number | null;
  source?: "local" | "steam";
  addedAt?: string;
  description?: string;
  price?: { current: string; original?: string; discount: number; country: string; amountMinor?: number; currency?: string };
  detailsCheckedAt?: string;
  detailsExpiresAt?: string;
  release?: string;
  storeStatus?: "available" | "unavailable";
  budgetHint?: boolean;
};
export type WishlistMode = "for-you" | "short" | "acclaimed" | "cheap";
export type WishlistInteractionContext = {
  surface: "recommendations" | "search" | "wishlist";
  recommendation_mode?: WishlistMode;
  rank?: number;
};
export type WishlistPick = { game: WishlistGame; reason: string; score: number; reasonKey: string; signal: "library" | "wishlist" | "discovery" };
export const WISHLIST_PAGE_SIZE = 24;
export const WISHLIST_PICK_COUNT = 9;
export const WISHLIST_DECK_SIZE = WISHLIST_PICK_COUNT * 80;
export const WISHLIST_BUDGET_RESERVE = WISHLIST_PICK_COUNT * 8;
export const WISHLIST_BUDGET_SCAN = WISHLIST_PICK_COUNT * 32;

const NON_GAME = /\b(demo|playtest|soundtrack|dedicated server|benchmark|sdk)\b/i;
const OPEN_ENDED_TAGS = new Set(["sandbox", "racing", "driving", "multiplayer", "pvp", "moba", "battleroyale", "mmorpg", "massivelymultiplayer", "sports", "partygame"]);
export function cheapWishlistBand(game: WishlistGame, country: string): 1 | 2 | null {
  const price = game.price;
  const band = steamBudgetBand(price?.currency);
  if (!isSteamStoreCountry(country) || !band || !price || price.country !== country || !Number.isSafeInteger(price.amountMinor) || !price.amountMinor || price.amountMinor < 0) return null;
  if (price.amountMinor > band.fallback) return null;
  // A small, unreviewed bargain is not automatically a good recommendation.
  const reviews = game.reviews ?? 0;
  const positive = game.positive ?? 0;
  if (reviews < 500 || positive / reviews < 0.84) return null;
  return price.amountMinor <= band.first ? 1 : 2;
}

export function hasFiniteWishlistStory(game: WishlistGame) {
  const topTags = Object.entries(game.tags ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return !game.endless && !!game.minutes && !topTags.some(([tag]) => OPEN_ENDED_TAGS.has(tagKey(tag)));
}

export function hasShortWishlistStory(game: WishlistGame) {
  return hasFiniteWishlistStory(game) && game.minutes! <= 600;
}

function profile(game: WishlistGame) {
  const tags = playNextTagProfile(game.tags);
  return new Map(Object.entries(tags ?? Object.fromEntries(game.genres.map((genre) => [genre, 1])))
    .map(([label, weight]) => [tagKey(label), weight]));
}

function similarity(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (const [key, weight] of a) { aa += weight * weight; dot += weight * (b.get(key) ?? 0); }
  for (const weight of b.values()) bb += weight * weight;
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** Keep smaller, distinct played interests in large libraries. Owning a game
 * alone is not evidence of taste; blacklisted and borrowed games are not seeds.
 * Round-robin by strongest gameplay tag before taking additional similar games.
 */
function playedWishlistSeeds(library: DemoGame[]) {
  const groups = new Map<string, DemoGame[]>();
  const played = library.filter(game => game.status !== "Blacklisted" && game.accessSource !== "family"
    && (game.status === "Completed" || game.hoursPlayed >= 3))
    .sort((a, b) => Number(b.status === "Completed") - Number(a.status === "Completed") || b.hoursPlayed - a.hoursPlayed);
  const ids = new Set<number>();
  for (const game of played) {
    if (ids.has(game.steamAppId)) continue;
    ids.add(game.steamAppId);
    const tags = profile({ appId: game.steamAppId, title: game.title, image: "", genres: game.genres, tags: game.tagProfile });
    const category = [...tags].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    const group = groups.get(category) ?? [];
    group.push(game); groups.set(category, group);
  }
  const selected: DemoGame[] = [];
  for (let round = 0; selected.length < 120; round++) {
    let added = false;
    for (const group of groups.values()) {
      if (group[round]) { selected.push(group[round]); added = true; }
      if (selected.length >= 120) break;
    }
    if (!added) break;
  }
  return selected;
}

/** Match against the full, unfiltered library, including blacklisted and family games. */
export function wishlistOwned(game: WishlistGame, library: DemoGame[]) {
  return library.some((owned) => owned.steamAppId === game.appId || editionKey(owned.title) === editionKey(game.title));
}

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** Prepare a diverse deck once, then serve instant batches without replacement.
 * A supplied session seed randomizes relevant candidates, never eligibility.
 * Library behavior outweighs saves; one batch can use at most one wishlist seed.
 */
export function recommendWishlist(catalogue: WishlistGame[], library: DemoGame[], saved: WishlistGame[], mode: WishlistMode = "for-you", sessionSeed = 0, country = "GB"): WishlistPick[] {
  const random = randomGenerator(sessionSeed);
  const owned = new Set(library.map((game) => game.steamAppId));
  const ownedEditions = new Set(library.map((game) => editionKey(game.title)));
  const savedIds = new Set(saved.map((game) => game.appId));
  const cheapBandOneCount = mode === "cheap" ? catalogue.filter((game) => cheapWishlistBand(game, country) === 1 && !owned.has(game.appId) && !savedIds.has(game.appId) && !ownedEditions.has(editionKey(game.title)) && !NON_GAME.test(game.title)).length : 0;
  const played = playedWishlistSeeds(library);
  const seeds = [
    ...played.map((game) => ({ id: game.steamAppId, title: game.title, profile: profile({ appId: game.steamAppId, title: game.title, image: "", genres: game.genres, tags: game.tagProfile }), signal: "library" as const, completed: game.status === "Completed", hours: game.hoursPlayed })),
    ...saved.filter((game) => !owned.has(game.appId)).slice(0, 20).map((game) => ({ id: game.appId, title: game.title, profile: profile(game), signal: "wishlist" as const, completed: false, hours: 0 })),
  ];
  const seen = new Set<number>();
  const candidates = catalogue.filter((game) => {
    if (seen.has(game.appId) || owned.has(game.appId) || savedIds.has(game.appId) || ownedEditions.has(editionKey(game.title)) || NON_GAME.test(game.title)) return false;
    seen.add(game.appId);
    if (mode === "short") return hasShortWishlistStory(game);
    if (mode === "acclaimed") return (game.reviews ?? 0) >= 500 && (game.positive ?? 0) / Math.max(1, game.reviews ?? 0) >= 0.84;
    if (mode === "cheap") {
      const band = cheapWishlistBand(game, country);
      return band !== null && (cheapBandOneCount < WISHLIST_PICK_COUNT || band === 1);
    }
    return true;
  }).map((game) => {
    const total = Math.max(0, game.reviews ?? 0);
    const positive = Math.min(total, Math.max(0, game.positive ?? 0));
    const quality = (positive + 70) / (total + 100);
    const base = quality * 35 + Math.min(6, Math.log10(total + 1)) * 2;
    const gp = profile(game);
    const labels = Object.keys(playNextTagProfile(game.tags) ?? {}).sort((a, b) => (game.tags?.[b] ?? 0) - (game.tags?.[a] ?? 0));
    const category = labels[0] ?? game.genres[0] ?? "Discovery";
    const options: WishlistPick[] = [];
    if (mode === "for-you" || mode === "cheap") {
      for (const seed of seeds) {
        const affinity = similarity(gp, seed.profile);
        if (affinity < 0.35) continue;
        const shared = [...labels, ...game.genres].filter((label) => seed.profile.has(tagKey(label))).slice(0, 2);
        const connection = shared.length ? `Shared ${shared.join(" + ")} tastes` : "A similar mix of genres";
        const evidence = seed.signal === "wishlist" ? `a side pick from your save, ${seed.title}` : seed.completed ? `you finished ${seed.title}` : `you played ${Math.round(seed.hours)}h of ${seed.title}`;
        options.push({ game, reason: `${connection}: ${evidence}.`, reasonKey: `seed:${seed.id}`, signal: seed.signal,
          score: base + affinity * (seed.signal === "library" ? 65 * Math.min(1, 0.55 + Math.log2(seed.hours + 1) / 12 + (seed.completed ? 0.15 : 0)) : played.length ? 24 : 42) + (seed.completed ? 5 : 0) });
      }
    }
    // A few strong connections per game retain varied reasons without keeping
    // every library comparison in memory for thousands of candidates.
    options.sort((a, b) => b.score - a.score);
    options.splice(8);
    const libraryFit = Math.max(0, ...options.filter((option) => option.signal === "library").map((option) => option.score - base));
    const reviews = total >= 100 ? `${Math.round(positive / total * 100)}% positive across ${new Intl.NumberFormat("en", { notation: "compact" }).format(total)} Steam reviews` : "An extra discovery beyond your usual picks";
    options.push({ game, reason: `${category} discovery · ${reviews}.`, reasonKey: `discovery:${tagKey(category)}`, signal: "discovery", score: base + libraryFit * 0.45 });
    if (mode === "cheap") options.push({ game, reason: `${game.price!.current} on Steam · ${reviews}.`, reasonKey: `budget:${cheapWishlistBand(game, country)}`, signal: "discovery", score: base + libraryFit * 0.6 + (cheapWishlistBand(game, country) === 1 ? 22 : 8) });
    if (hasShortWishlistStory(game)) options.push({ game, reason: `A shorter ${category.toLowerCase()} adventure: about ${Math.max(1, Math.round(game.minutes! / 60))} hours for the main story.`, reasonKey: "short", signal: "discovery", score: base + libraryFit * 0.5 + (mode === "short" ? 10 : 0) });
    if (total >= 100 && total < 20000 && quality >= 0.9) options.push({ game, reason: `An overlooked ${category.toLowerCase()} gem: ${reviews}.`, reasonKey: "gem", signal: "discovery", score: base + libraryFit * 0.5 + 4 });
    return { game, options, category: tagKey(category), edition: editionKey(game.title), series: seriesKey(game.title), best: Math.max(...options.map((option) => option.score)) };
  }).sort((a, b) => b.best - a.best);

  const deck: WishlistPick[] = [];
  const editions = new Set<string>();
  const franchises = new Map<string, number>();
  // Eighty batches; bound the scoring window so a larger pool stays responsive.
  while (candidates.length && deck.length < WISHLIST_DECK_SIZE) {
    // Remove globally exhausted editions/franchises before forming the window.
    // Otherwise a blocked front window can incorrectly end a deep deck.
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (editions.has(candidates[i].edition) || (franchises.get(candidates[i].series) ?? 0) >= 2) candidates.splice(i, 1);
    }
    const window = new Set(candidates.slice(0, mode === "for-you" ? 256 : 512));
    if (mode === "for-you") {
      // Retain the strongest matches, plus the best of every gameplay category.
      // Refill each batch: a static interleaved list would lose the player's
      // strongest interest after its first handful of games was removed.
      const categories = new Set([...new Set(candidates.map(candidate => candidate.category))].slice(0, 256));
      const quota = Math.max(1, Math.floor(256 / Math.max(1, categories.size)));
      const counts = new Map<string, number>();
      for (const candidate of candidates) {
        if (!categories.has(candidate.category)) continue;
        const count = counts.get(candidate.category) ?? 0;
        if (count < quota) { window.add(candidate); counts.set(candidate.category, count + 1); }
      }
    }
    const reasons = new Set<string>();
    const batchSeries = new Set<string>();
    const batchCategories = new Map<string, number>();
    let wishlistCount = 0;
    const batch: WishlistPick[] = [];
    for (let slot = 0; slot < WISHLIST_PICK_COUNT && candidates.length; slot++) {
      let bestIndex = -1;
      let bestOption: WishlistPick | undefined;
      let bestScore = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (!window.has(candidate)) continue;
        if (editions.has(candidate.edition) || (franchises.get(candidate.series) ?? 0) >= 2) {
          candidates.splice(i--, 1);
          continue;
        }
        for (const option of candidate.options) {
          if (option.signal === "wishlist" && wishlistCount >= 1) continue;
          const score = option.score + (sessionSeed ? random() * 24 : 0)
            - (reasons.has(option.reasonKey) ? 150 : 0)
            - (batchSeries.has(candidate.series) ? 150 : 0)
            // A variety of genuine played interests beats nine near-identical
            // matches; a single-interest player still gets relevant games.
            - (mode === "for-you" && (batchCategories.get(candidate.category) ?? 0) >= 2 ? 30 : 0);
          if (score > bestScore) { bestScore = score; bestIndex = i; bestOption = option; }
        }
      }
      if (bestIndex < 0 || !bestOption) break;
      const [candidate] = candidates.splice(bestIndex, 1);
      batch.push(bestOption);
      batchCategories.set(candidate.category, (batchCategories.get(candidate.category) ?? 0) + 1);
      reasons.add(bestOption.reasonKey);
      if (bestOption.signal === "wishlist") wishlistCount++;
      const series = seriesKey(bestOption.game.title);
      batchSeries.add(series);
      editions.add(editionKey(bestOption.game.title));
      franchises.set(series, (franchises.get(series) ?? 0) + 1);
    }
    if (!batch.length) break;
    // No fixed slot roles: even the strongest match moves around the grid.
    if (sessionSeed) for (let i = batch.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [batch[i], batch[j]] = [batch[j], batch[i]]; }
    deck.push(...batch);
  }
  return deck;
}

/** Empty/private/error payloads must never masquerade as a successful import. */
export function parseSteamWishlist(payload: unknown, resultHeader?: string | null): number[] {
  if (resultHeader && resultHeader !== "1") throw new Error("Steam did not allow access to this wishlist. Check your profile and game details privacy settings.");
  const response = (payload as { response?: { items?: unknown } } | null)?.response;
  // Steam's protobuf JSON omits an empty repeated field. Only an explicit OK
  // transport result makes response:{} a confirmed empty wishlist.
  if (resultHeader === "1" && response && typeof response === "object" && !Array.isArray(response) && Object.keys(response).length === 0) return [];
  if (!response || !Array.isArray(response.items)) throw new Error("Steam did not share a wishlist. Set your Steam profile and game details to public, then try again.");
  const ids = response.items.map((item: unknown) => Number((item as { appid?: unknown } | null)?.appid));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 4294967295)) throw new Error("Steam returned an incomplete wishlist. Please try again.");
  return [...new Set(ids)];
}

export function readGuestWishlist(raw: string | null): WishlistGame[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    const seen = new Set<number>();
    return value.filter((game): game is WishlistGame => {
      if (!game || typeof game !== "object") return false;
      const g = game as WishlistGame;
      if (!Number.isSafeInteger(g.appId) || g.appId <= 0 || typeof g.title !== "string" || typeof g.image !== "string" || !Array.isArray(g.genres) || !g.genres.every((genre) => typeof genre === "string") || seen.has(g.appId)) return false;
      seen.add(g.appId);
      return true;
    }).slice(0, 1000);
  } catch { return []; }
}
