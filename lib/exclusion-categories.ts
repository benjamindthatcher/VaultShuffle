/**
 * "Never show me this kind of game."
 *
 * Every genre control in the product until now has been include-only: the Vault
 * takes up to three genres to prefer, the Library takes genres to show. Nobody
 * could express the thing the launch feedback actually asked for - "Is there an
 * option to ignore like all ARPGs? Diablo, No Rest for the Wicked, PoE, LE" -
 * and that is a standing fact about a shelf, not a way of looking at a list, so
 * it belongs with the global filters rather than in a toolbar.
 *
 * A curated vocabulary rather than the raw tag list. Across owned games the
 * crowd uses 400-odd distinct dominant tags, most of them describing texture
 * ("Colorful", "Stylized", "Female Protagonist") rather than anything a person
 * would rule out an evening over. Twenty-two categories that people actually
 * hold opinions about is a usable control; four hundred is a search box.
 */

export type ExclusionGroup = "genre" | "loop" | "practical";

export type ExclusionCategory = {
  id: string;
  label: string;
  group: ExclusionGroup;
  /** Crowd tags, matched on share of the top tag. See EXCLUSION_TAG_SHARE. */
  tags: string[];
  /** Steam's own category strings, matched on presence: these are facts, not votes. */
  categories?: string[];
};

/**
 * How much of a game a tag has to describe before it counts as a reason to hide it.
 *
 * Presence alone is too loose - a single "Horror" vote on a comedy platformer
 * would hide it - and the 0.65 dominance bar the length classifier uses is too
 * strict here, because a game can be substantially a roguelike without that
 * being its single loudest tag. Forty percent of the top tag is the line where a
 * tag is describing the game rather than a corner of it.
 *
 * Erring wide is also the right direction for this control specifically: the user
 * asked for these to be gone, and one chip turns the whole category back on.
 */
export const EXCLUSION_TAG_SHARE = 0.4;

export const EXCLUSION_CATEGORIES: ExclusionCategory[] = [
  // ---- Genre ----------------------------------------------------------------
  {
    id: "horror",
    label: "Horror",
    group: "genre",
    tags: ["horror", "survival horror", "psychological horror", "lovecraftian", "gore", "jump scare"]
  },
  {
    id: "anime",
    label: "Anime",
    group: "genre",
    tags: ["anime", "manga", "cute", "hentai"]
  },
  {
    id: "visual-novel",
    label: "Visual novels",
    group: "genre",
    tags: ["visual novel", "interactive fiction", "dating sim", "otome", "text-based"]
  },
  {
    id: "puzzle",
    label: "Puzzle",
    group: "genre",
    tags: ["puzzle", "puzzle platformer", "hidden object", "match 3", "logic", "sokoban", "word game"]
  },
  {
    id: "strategy",
    // The Age of Empires complaint. Worth saying plainly that this is what it
    // covers, because "strategy" reads narrower than the tag actually is.
    label: "Strategy & 4X",
    group: "genre",
    tags: ["strategy", "rts", "real time strategy", "real-time strategy", "4x", "grand strategy",
      "turn-based strategy", "turn based strategy", "wargame", "tactical rpg", "turn-based tactics"]
  },
  {
    id: "simulation",
    label: "Sims & management",
    group: "genre",
    tags: ["simulation", "management", "colony sim", "city builder", "farming sim", "automation",
      "economy", "business sim", "life sim", "life simulation"]
  },
  {
    id: "sports-racing",
    label: "Sports & racing",
    group: "genre",
    tags: ["sports", "racing", "driving", "football (soccer)", "football (american)", "basketball",
      "golf", "baseball", "hockey", "cycling", "motocross"]
  },
  {
    id: "fighting",
    label: "Fighting",
    group: "genre",
    tags: ["fighting", "2d fighter", "3d fighter", "beat 'em up", "beat em up", "martial arts"]
  },
  {
    id: "platformer",
    label: "Platformers",
    group: "genre",
    tags: ["platformer", "2d platformer", "3d platformer", "precision platformer", "puzzle platformer"]
  },
  {
    id: "card-board",
    label: "Card & board games",
    group: "genre",
    tags: ["card game", "deckbuilding", "card battler", "roguelike deckbuilder", "board game",
      "tabletop", "chess", "trading card game", "collectible card game"]
  },

  // ---- Loop -----------------------------------------------------------------
  {
    id: "arpg",
    // The complaint this control was built for.
    label: "ARPGs & loot grinders",
    group: "loop",
    tags: ["action rpg", "arpg", "hack and slash", "looter shooter", "dungeon crawler", "loot", "grinding"]
  },
  {
    id: "roguelike",
    label: "Roguelikes",
    group: "loop",
    tags: ["roguelike", "roguelite", "rogue-lite", "rogue-like", "roguelike deckbuilder", "permadeath"]
  },
  {
    id: "competitive",
    label: "Competitive PvP",
    group: "loop",
    tags: ["pvp", "competitive", "e-sports", "esports", "moba", "battle royale", "hero shooter",
      "arena shooter", "team-based", "1v1", "extraction shooter"]
  },
  {
    id: "mmo",
    label: "MMOs & live service",
    group: "loop",
    tags: ["mmorpg", "mmo", "massively multiplayer", "live service", "persistent online", "mmo rpg"]
  },
  {
    id: "survival-craft",
    label: "Survival & crafting",
    group: "loop",
    tags: ["survival", "crafting", "open world survival craft", "base building", "base-building", "sandbox"]
  },
  {
    id: "idle",
    label: "Idle & clickers",
    group: "loop",
    tags: ["clicker", "idler", "idle", "incremental", "auto battler", "auto-battler"]
  },
  {
    id: "party",
    label: "Party & couch play",
    group: "loop",
    // The categories matter more than the tags here: whether a game needs other
    // people in the room is something Steam states outright.
    tags: ["party game", "local multiplayer", "split screen", "local co-op", "4 player local", "mini games"],
    categories: ["Shared/Split Screen", "Shared/Split Screen PvP", "Shared/Split Screen Co-op", "Remote Play Together"]
  },
  {
    id: "punishing",
    label: "Punishing difficulty",
    group: "loop",
    tags: ["difficult", "souls-like", "soulslike", "bullet hell", "masocore", "precision platformer", "rhythm"]
  },

  // ---- Practical ------------------------------------------------------------
  {
    id: "retro",
    label: "Retro & pixel art",
    group: "practical",
    tags: ["pixel graphics", "retro", "8-bit", "16-bit", "classic", "old school", "oldschool"]
  },
  {
    id: "vr",
    label: "VR",
    group: "practical",
    // Factual and worth having even if nothing else here is used: a VR-only game
    // is unplayable without a headset, so offering one is never right.
    tags: ["vr", "vr only"],
    categories: ["VR Only", "VR Supported", "Tracked Controller Support"]
  },
  {
    id: "early-access",
    label: "Early access",
    group: "practical",
    tags: ["early access"]
  },
  {
    id: "free-to-play",
    label: "Free to play",
    group: "practical",
    tags: ["free to play", "free-to-play", "freemium"]
  },
  {
    id: "adult",
    label: "Sexual content",
    group: "practical",
    tags: ["sexual content", "nudity", "nsfw", "hentai", "mature"]
  }
];

/**
 * The order the chips are offered in.
 *
 * Not rendered as headings. The panel's other wells are all a single row, and
 * three labelled columns of unequal height read as a different kind of control
 * dropped into the middle of it - so the grouping is carried by the ordering
 * instead, which puts related chips beside each other without a third level of
 * hierarchy inside an already-labelled section.
 */
export const EXCLUSION_GROUP_ORDER: ExclusionGroup[] = ["genre", "loop", "practical"];

const BY_ID = new Map(EXCLUSION_CATEGORIES.map((category) => [category.id, category]));

export function exclusionCategory(id: string) {
  return BY_ID.get(id) ?? null;
}

export function isExclusionCategory(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

function normalise(value: string) {
  return value.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
}

/**
 * Which categories a game belongs to, computed once on the server.
 *
 * Returned as a short list of ids rather than shipping the whole tag map to the
 * client: a library averages 565 games here, and the ids cost a few bytes each
 * where the tags would cost a couple of hundred. It also keeps the vocabulary in
 * one place, so widening a category is a server change and not a release.
 */
export function exclusionCategoriesFor(input: {
  tags?: Record<string, number> | null;
  genres?: string[] | null;
  categories?: string[] | null;
}): string[] {
  const shares = new Map<string, number>();
  const entries = Object.entries(input.tags ?? {})
    .map(([tag, votes]) => [normalise(tag), Number(votes)] as const)
    .filter(([tag, votes]) => tag && Number.isFinite(votes) && votes > 0);
  const top = Math.max(0, ...entries.map(([, votes]) => votes));
  if (top > 0) {
    for (const [tag, votes] of entries) {
      shares.set(tag, Math.max(shares.get(tag) ?? 0, votes / top));
    }
  }

  // Steam's own genre strings count as a full-share signal. They are chosen by
  // the publisher rather than voted on, so "Horror" there is a statement rather
  // than a minority opinion - and unlike the persistent-online case in
  // game-classification.ts, a wrong one here only hides a game the user asked to
  // hide a category of, which they can undo with one chip.
  for (const genre of input.genres ?? []) {
    const key = normalise(String(genre));
    if (key) shares.set(key, 1);
  }

  const officialCategories = new Set((input.categories ?? []).map((value) => normalise(String(value))));

  const matched: string[] = [];
  for (const category of EXCLUSION_CATEGORIES) {
    const byTag = category.tags.some((tag) => (shares.get(normalise(tag)) ?? 0) >= EXCLUSION_TAG_SHARE);
    const byCategory = (category.categories ?? []).some((value) => officialCategories.has(normalise(value)));
    if (byTag || byCategory) matched.push(category.id);
  }
  return matched;
}

/** The categories actually present in a library, so the panel never offers an empty one. */
export function availableExclusionCategories(exclusionsPerGame: Array<string[] | undefined>): Set<string> {
  const present = new Set<string>();
  for (const list of exclusionsPerGame) {
    for (const id of list ?? []) present.add(id);
  }
  return present;
}
