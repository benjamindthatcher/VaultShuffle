/**
 * Choosing the games a guest gets to draw from.
 *
 * The old pool was the top 250 by popularity, which is a list of the same
 * blockbusters everyone has already played and is dominated by a handful of
 * genres. A guest arriving to try the product should find something that fits
 * whoever they happen to be - someone who only plays farming sims, or visual
 * novels, or grand strategy - and the honest test of that is whether their
 * corner of Steam is represented at all.
 *
 * So selection goes breadth first: every niche contributes its single best game
 * before any niche contributes a second. Depth is what the remaining slots are
 * for.
 */

export const GUEST_POOL_SIZE = 1000;

/**
 * The niches a guest might turn up already knowing they want. Deliberately a
 * mix of top-level genres and the Steam tags that actually describe how a game
 * plays, because "Action" is not a taste and "Metroidvania" is.
 *
 * Missing from a niche is fine - it simply contributes nothing. The cost of
 * listing one that does not exist is zero, so the list errs on the side of
 * covering someone.
 */
export const GUEST_NICHES = [
  // Top-level shelves
  "Action", "Adventure", "RPG", "Strategy", "Simulation", "Casual", "Racing", "Sports",
  "Massively Multiplayer",
  // How things actually play
  "Roguelike", "Roguelite", "Metroidvania", "Soulslike", "Platformer", "2D Platformer",
  "Puzzle", "Point & Click", "Visual Novel", "Story Rich", "Narrative",
  "Horror", "Survival Horror", "Psychological Horror",
  "Shooter", "FPS", "Third-Person Shooter", "Battle Royale", "Hero Shooter",
  "Fighting", "Beat 'em up", "Hack and Slash", "Twin Stick Shooter", "Bullet Hell",
  "Turn-Based Strategy", "Grand Strategy", "4X", "Real Time Strategy", "Tower Defense",
  "City Builder", "Colony Sim", "Management", "Tycoon", "Automation",
  "Farming Sim", "Life Sim", "Dating Sim", "Sandbox", "Open World",
  "Deckbuilder", "Card Game", "Board Game", "Chess", "Word Game", "Trivia",
  "Rhythm", "Music", "Typing",
  "Survival", "Crafting", "Base Building", "Zombies", "Post-apocalyptic",
  "Stealth", "Immersive Sim", "Detective", "Mystery", "Investigation",
  "JRPG", "CRPG", "Action RPG", "Party-Based RPG", "Dungeon Crawler",
  "Co-op", "Local Co-Op", "Split Screen", "Multiplayer", "PvP", "MMORPG",
  "Space", "Flight", "Driving", "Racing Sim", "Football", "Basketball",
  "Walking Simulator", "Exploration", "Relaxing", "Wholesome", "Cozy",
  "Pixel Graphics", "Anime", "Retro", "Arcade", "Idle", "Clicker",
  "Souls-like", "Precision Platformer", "Physics", "Sokoban", "Turn-Based Tactics",
  "Tactical RPG", "Roguelike Deckbuilder", "Auto Battler", "MOBA", "RTS"
] as const;

export type GuestPoolCandidate = {
  steam_appid: number;
  genres?: string[] | null;
  tags?: Record<string, number> | null;
  popularity_rank?: number | null;
  review_total?: number | null;
  review_positive?: number | null;
};

/**
 * Lower is better. Popularity rank when Steam gives us one, otherwise fall back
 * to review volume, which is the best proxy we have for "enough people have
 * played this that recommending it is defensible".
 */
export function guestQualityRank(candidate: GuestPoolCandidate): number {
  const rank = candidate.popularity_rank;
  if (typeof rank === "number" && Number.isFinite(rank) && rank > 0) return rank;
  const reviews = Number(candidate.review_total ?? 0);
  // Well past any real popularity_rank, so ranked games always sort first.
  return 1_000_000 - Math.min(999_000, reviews);
}

function nichesOf(candidate: GuestPoolCandidate, niches: readonly string[]): string[] {
  const owned = new Set<string>();
  for (const genre of candidate.genres ?? []) owned.add(String(genre).toLowerCase());
  for (const tag of Object.keys(candidate.tags ?? {})) owned.add(tag.toLowerCase());
  return niches.filter((niche) => owned.has(niche.toLowerCase()));
}

/**
 * Round-robin across niches: each contributes its best unused game, then its
 * second, and so on. A niche with three eligible games is fully represented
 * before a niche with three thousand gets its fourth.
 *
 * Anything left over is filled by overall quality, so a smaller pool degrades
 * into "the best games we have" rather than failing.
 */
export function selectGuestPool<T extends GuestPoolCandidate>(
  candidates: T[],
  size: number = GUEST_POOL_SIZE,
  niches: readonly string[] = GUEST_NICHES
): T[] {
  const ordered = [...candidates].sort((left, right) => {
    const byQuality = guestQualityRank(left) - guestQualityRank(right);
    if (byQuality !== 0) return byQuality;
    return left.steam_appid - right.steam_appid;
  });

  const queues = new Map<string, T[]>();
  for (const candidate of ordered) {
    for (const niche of nichesOf(candidate, niches)) {
      const queue = queues.get(niche);
      if (queue) queue.push(candidate); else queues.set(niche, [candidate]);
    }
  }

  const chosen: T[] = [];
  const taken = new Set<number>();
  const cursors = new Map<string, number>();
  // Rarest niches first, so the ones with least to offer are never crowded out
  // by the ones with thousands of candidates.
  const order = [...queues.keys()].sort((left, right) =>
    (queues.get(left)?.length ?? 0) - (queues.get(right)?.length ?? 0));

  let progressed = true;
  while (chosen.length < size && progressed) {
    progressed = false;
    for (const niche of order) {
      if (chosen.length >= size) break;
      const queue = queues.get(niche) ?? [];
      let cursor = cursors.get(niche) ?? 0;
      while (cursor < queue.length && taken.has(queue[cursor].steam_appid)) cursor += 1;
      cursors.set(niche, cursor);
      if (cursor >= queue.length) continue;
      const pick = queue[cursor];
      taken.add(pick.steam_appid);
      chosen.push(pick);
      cursors.set(niche, cursor + 1);
      progressed = true;
    }
  }

  if (chosen.length < size) {
    for (const candidate of ordered) {
      if (chosen.length >= size) break;
      if (taken.has(candidate.steam_appid)) continue;
      taken.add(candidate.steam_appid);
      chosen.push(candidate);
    }
  }

  // Presented best-first; the breadth is in which games are here at all.
  return chosen.sort((left, right) => guestQualityRank(left) - guestQualityRank(right));
}
