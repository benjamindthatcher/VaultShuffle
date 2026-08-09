export const TOP_LEVEL_GENRES = [
  "Casual",
  "Action",
  "Adventure",
  "Strategy",
  "RPG",
  "Simulation",
  "Sports",
  "Racing",
  "Software"
] as const;

export type TopLevelGenre = (typeof TOP_LEVEL_GENRES)[number];

const TOP_LEVEL_SET = new Set<string>(TOP_LEVEL_GENRES);

const TAG_TO_TOP_LEVEL: Record<string, TopLevelGenre> = {
  "2d platformer": "Casual",
  "3d platformer": "Casual",
  arcade: "Casual",
  casual: "Casual",
  "free to play": "Casual",
  "hidden object": "Casual",
  indie: "Casual",
  incremental: "Casual",
  platformer: "Casual",
  "point & click": "Casual",
  puzzle: "Casual",

  action: "Action",
  "action-adventure": "Action",
  "battle royale": "Action",
  fighting: "Action",
  fps: "Action",
  moba: "Action",
  shooter: "Action",
  "third-person shooter": "Action",

  adventure: "Adventure",
  exploration: "Adventure",
  horror: "Adventure",
  "open world": "Adventure",
  "story rich": "Adventure",
  "visual novel": "Adventure",

  "4x": "Strategy",
  "card battler": "Strategy",
  "grand strategy": "Strategy",
  management: "Strategy",
  rts: "Strategy",
  strategy: "Strategy",
  tactical: "Strategy",
  "tower defense": "Strategy",
  "turn-based strategy": "Strategy",

  "action rpg": "RPG",
  jrpg: "RPG",
  "role-playing": "RPG",
  "role playing": "RPG",
  roguelike: "RPG",
  roguelite: "RPG",
  rpg: "RPG",

  building: "Simulation",
  "city builder": "Simulation",
  sandbox: "Simulation",
  sim: "Simulation",
  simulation: "Simulation",
  simulator: "Simulation",
  survival: "Simulation",

  basketball: "Sports",
  football: "Sports",
  golf: "Sports",
  hockey: "Sports",
  soccer: "Sports",
  sports: "Sports",
  tennis: "Sports",

  driving: "Racing",
  racing: "Racing",

  "animation & modeling": "Software",
  "audio production": "Software",
  "design & illustration": "Software",
  education: "Software",
  "game development": "Software",
  "photo editing": "Software",
  software: "Software",
  "software training": "Software",
  utilities: "Software",
  "video production": "Software",
  "web publishing": "Software"
};

const GENERIC_TAGS = new Set(["early access", "massively multiplayer"]);

const NON_GENRE_STEAM_TAGS = new Set([
  "captions available",
  "co-op",
  "controller",
  "cross-platform multiplayer",
  "family sharing",
  "full controller support",
  "in-app purchases",
  "includes level editor",
  "includes source sdk",
  "local co-op",
  "local multiplayer",
  "mods",
  "mods (require hl2)",
  "multi-player",
  "multiplayer",
  "online co-op",
  "partial controller support",
  "remote play on phone",
  "remote play on tablet",
  "remote play on tv",
  "remote play together",
  "shared/split screen",
  "shared/split screen co-op",
  "shared/split screen pvp",
  "single-player",
  "singleplayer",
  "stats",
  "steam achievements",
  "steam cloud",
  "steam leaderboards",
  "steam trading cards",
  "steam workshop",
  "tracked controller support",
  "valve anti-cheat enabled"
]);

export type SteamTagMap = Record<string, number>;

export function splitGenres(value?: string | null) {
  const genres = String(value || "")
    .split(/[\/,;|]+/g)
    .map((genre) => genre.trim())
    .filter((genre) => genre && genre.toLowerCase() !== "unknown");
  return unique(genres);
}

export function normaliseSteamGenreLabel(value?: string | string[] | null, title = "") {
  const tags = Array.isArray(value) ? value : splitGenres(value);
  const cleaned = unique(tags.map(cleanGenreLabel).filter(Boolean));
  if (!cleaned.length) return "Unknown";

  const topLevels = topLevelGenresFor(cleaned.join(" / "), title);
  const orderedTags = unique([
    ...topLevels,
    ...cleaned.filter((tag) => !TOP_LEVEL_SET.has(tag))
  ]);

  return orderedTags.length ? orderedTags.join(" / ") : "Unknown";
}

export function topLevelGenresFor(value?: string | null, title = ""): TopLevelGenre[] {
  const tags = splitGenres(value);
  const exact = tags.flatMap((tag) => (TOP_LEVEL_SET.has(tag) ? [tag as TopLevelGenre] : []));
  const mapped = tags.flatMap((tag) => {
    const key = genreKey(tag);
    return TAG_TO_TOP_LEVEL[key] ? [TAG_TO_TOP_LEVEL[key]] : [];
  });
  const combined = uniqueTopLevels([...exact, ...mapped]);
  if (combined.length) return combined;

  const inferred = inferTopLevelGenre(title, tags);
  return inferred ? [inferred] : [];
}

/**
 * Returns every stored Steam tag in provider weight order. The complete map is
 * retained on the game model; callers can choose a display limit without
 * throwing source information away.
 */
export function steamTagLabels(tags?: SteamTagMap | null, limit = Number.POSITIVE_INFINITY) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return [];
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  return unique(Object.entries(tags)
    .filter(([label, weight]) => label.trim() && Number.isFinite(Number(weight)) && Number(weight) > 0)
    .sort(([leftLabel, leftWeight], [rightLabel, rightWeight]) =>
      Number(rightWeight) - Number(leftWeight) || leftLabel.localeCompare(rightLabel)
    )
    .map(([label]) => cleanGenreLabel(label)))
    .slice(0, maximum);
}

/** A compact genre/theme subset suitable for cards and Vault filters. */
export function steamTagGenreLabels(tags?: SteamTagMap | null, limit = 6) {
  return steamTagLabels(tags)
    .filter((label) => !NON_GENRE_STEAM_TAGS.has(genreKey(label)))
    .slice(0, Math.max(0, Math.floor(limit)));
}

export function matchesTopLevelGenre(value: string | null | undefined, genre: string, title = "") {
  if (genre === "Any genre" || genre === "All genres") return true;
  return topLevelGenresFor(value, title).includes(genre as TopLevelGenre);
}

export function genreDisplayLabel(value?: string | null, title = "") {
  const tags = splitGenres(value);
  const [primary] = topLevelGenresFor(value, title);
  if (!primary) return tags[0] || "Unknown";

  const secondary =
    tags.find((tag) => tag !== primary && !GENERIC_TAGS.has(genreKey(tag))) ||
    tags.find((tag) => tag !== primary) ||
    topLevelGenresFor(value, title).find((tag) => tag !== primary);

  return secondary ? `${primary} / ${secondary}` : primary;
}

export function primaryGenre(value?: string | null, title = "") {
  return topLevelGenresFor(value, title)[0] || splitGenres(value)[0] || "Unknown";
}

function inferTopLevelGenre(title: string, tags: string[]): TopLevelGenre | null {
  const text = `${title} ${tags.join(" ")}`.toLowerCase();
  if (/(software|utility|utilities|training|development|production|design|illustration|modeling|publishing|education)/.test(text)) return "Software";
  if (/(racing|driving|motocross|rally|formula|kart)/.test(text)) return "Racing";
  if (/(sports?|football|soccer|basketball|golf|tennis|hockey|fishing|baseball)/.test(text)) return "Sports";
  if (/(simulator|simulation|management|city builder|building|sandbox|survival)/.test(text)) return "Simulation";
  if (/(strategy|tactical|rts|4x|tower defense|grand strategy|card battler)/.test(text)) return "Strategy";
  if (/(rpg|role-playing|role playing|jrpg|rogue)/.test(text)) return "RPG";
  if (/(action|shooter|fps|fighting|battle royale|moba|combat)/.test(text)) return "Action";
  if (/(adventure|exploration|story rich|visual novel|horror|open world)/.test(text)) return "Adventure";
  if (/(casual|puzzle|arcade|platformer|hidden object|indie|free to play|incremental)/.test(text)) return "Casual";
  return null;
}

function cleanGenreLabel(value: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (genreKey(trimmed) === "rpg") return "RPG";
  return TOP_LEVEL_GENRES.find((genre) => genreKey(genre) === genreKey(trimmed)) || trimmed;
}

function genreKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function unique<T>(items: T[]) {
  const seen = new Set<T | string>();
  return items.filter((item) => {
    const key = typeof item === "string" ? genreKey(item) : item;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueTopLevels(items: TopLevelGenre[]) {
  return unique(items.filter((item): item is TopLevelGenre => TOP_LEVEL_SET.has(item)));
}
