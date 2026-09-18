import type { DemoGame } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";
import { formatReviewCount, gameAppeal, type GameAppeal } from "./game-appeal.ts";
import { approximateAge, idleForAtLeast, playedWithin } from "./recency.ts";
import { canClaimNeverPlayed, playtimeIsUnknown } from "./family-sharing.ts";
import { genrePreferenceAdjustment, type GenrePreferenceContextData } from "./genre-preferences.ts";
import { hoursFor, popularityPoints, verdictBaseline, verdictFor, verdictPoints, type GameVerdicts } from "./game-verdict.ts";
import { FINISHED_RATIO } from "./completion-check.ts";

/**
 * What to play next, as a standing answer rather than a draw.
 *
 * The Vault answers "what tonight" by asking three questions and shuffling. This
 * answers the question someone brings to the dashboard without having decided
 * anything yet: of everything still waiting, what is most worth starting? It is
 * deterministic on purpose - the same library gives the same shelf - so it can
 * be argued with. Every pick carries the specific reason it was chosen, and the
 * player's own decisions (finishing, setting aside, snoozing, pinning) move it
 * immediately.
 *
 * Steam's own "Play Next" shelf is the obvious comparison, and the two criticisms
 * of it shaped this: it leans on what is popular rather than what is yours, and
 * it never says why. So the strongest lane here is "because you finished X",
 * judged on what the games actually are, and popularity only speaks when
 * nothing about the player does.
 */

export type PlayNextLane = "because" | "finish" | "gem" | "quick" | "return" | "acclaimed";

/** How a game in the library came to say something about taste. */
export type PlayNextSeedKind = "finished" | "playing" | "played" | "pinned" | "set-aside" | "bounced";

export type PlayNextSeed = {
  id: string;
  title: string;
  kind: PlayNextSeedKind;
  hoursPlayed: number;
  /** When it was finished, for "just finished" phrasing. */
  completedAt?: string | null;
};

export type PlayNextPick = {
  game: DemoGame;
  lane: PlayNextLane;
  /**
   * Roughly 0-100. Every lane is built on the same scale so the dashboard can
   * order its handful, but it is a ranking, not a percentage to show anyone.
   */
  score: number;
  headline: string;
  detail: string;
  /** Tags the pick shares with its seed, or with the player's taste overall. */
  tags: string[];
  seed: PlayNextSeed | null;
};

export type PlayNextBecauseGroup = {
  seed: PlayNextSeed;
  headline: string;
  picks: PlayNextPick[];
};

export type PlayNextTaste = {
  /** Tags the player keeps coming back to, strongest first. */
  likes: string[];
  /** Tags on what they set aside and bounced off. Empty until they have. */
  avoids: string[];
  finished: number;
  played: number;
  setAside: number;
};

export type PlayNextResult = {
  /** The handful for the dashboard: one from each lane that has a real answer. */
  top: PlayNextPick[];
  lanes: Record<PlayNextLane, PlayNextPick[]>;
  becauseGroups: PlayNextBecauseGroup[];
  taste: PlayNextTaste;
  /** How many games were considered at all, for "picked from N". */
  candidateCount: number;
};

export const PLAY_NEXT_LANES: ReadonlyArray<{ id: PlayNextLane; title: string; blurb: string }> = [
  { id: "because", title: "Because you loved…", blurb: "Unplayed games that are closest to the ones you finished and sank hours into." },
  { id: "finish", title: "Nearly there", blurb: "Started, and close enough to the end that one more push finishes them." },
  { id: "gem", title: "Hidden gems on your shelf", blurb: "Adored by the few who played them, and easy to have forgotten you own." },
  { id: "quick", title: "Done in an evening", blurb: "Short enough to start and finish this week." },
  { id: "return", title: "Pick back up", blurb: "Games you gave real time to and then drifted away from." },
  { id: "acclaimed", title: "Widely loved, still unplayed", blurb: "The big ones everyone else already played." }
];

/* ---------------------------------------------------------------- tag profiles */

/**
 * Tags that say how a game was sold, praised or packaged rather than how it plays.
 *
 * "Indie" is a funding model, "Great Soundtrack" is a compliment and
 * "Singleplayer" is on nearly everything; left in, they made Hollow Knight look
 * like Stardew Valley. "Nudity" and "Mature" go too: they are content warnings,
 * and matching on them paired games whose only resemblance is a rating. Tone
 * tags - "Gore", "Dark", "Funny" - stay, because tone genuinely is taste.
 */
const NON_TASTE_TAGS = new Set([
  "indie",
  "singleplayer",
  "freetoplay",
  "earlyaccess",
  "greatsoundtrack",
  "goodsoundtrack",
  "masterpiece",
  "classic",
  "cultclassic",
  "beautiful",
  "addictive",
  "replayvalue",
  "controller",
  "fullcontrollersupport",
  "steamachievements",
  "steamtradingcards",
  "remoteplaytogether",
  "nudity",
  "sexualcontent",
  "mature",
  "bestsoundtrack"
]);

/** Tags that mark an app rather than a game. Wallpaper Engine is not a backlog. */
const SOFTWARE_TAGS = new Set([
  "software",
  "utilities",
  "designillustration",
  "animationmodeling",
  "videoproduction",
  "audioproduction",
  "photoediting",
  "webpublishing",
  "gamedevelopment",
  "softwaretraining"
]);

/**
 * Tags on games with no ending to reach. A listed length for these measures
 * something - a career, a sandbox, a round of a party game - but not a finish,
 * so "done in an evening" would be a promise the game cannot keep. Checked
 * against a game's strongest tags only: plenty of story games have a racing
 * section.
 */
const NO_ENDING_TAGS = new Set([
  "sandbox",
  "racing",
  "driving",
  "partygame",
  "boardgame",
  "sports",
  "fighting",
  "moba",
  "battleroyale",
  "pvp",
  "trivia",
  "minigames",
  "massivelymultiplayer",
  "mmorpg"
]);

/**
 * Not a game at all. The catalogue still holds demos and test clients filed as
 * games (see the ~1,900 non-games noted against catalog_games), and a demo is
 * the worst possible answer to "what should I play next".
 */
const NON_GAME_TITLE = /\b(demo|sneak peek|playtest|public test|test server|dedicated server|soundtrack|benchmark|sdk|beta)\b/i;

const TAG_PROFILE_LIMIT = 20;

/**
 * One key per tag however it is spelled.
 *
 * SteamSpy and the Steam store page do not agree: one says "Rogue-like" and the
 * other "Roguelike", one "Souls-like" and the other "Soulslike". Both sources are
 * in the catalogue, so without this two players who love the same genre would
 * share no tags at all.
 */
export function tagKey(label: string) {
  return remember(tagKeys, label, () => label.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, ""));
}

/*
 * The same few thousand tags and titles are normalised on every rebuild, and a
 * rebuild follows every pin and dismissal. They never change, so each is worked
 * out once. Capped so a very long session cannot grow them without limit.
 */
const tagKeys = new Map<string, string>();
const editionKeys = new Map<string, string>();
const seriesKeys = new Map<string, string>();
const MEMO_LIMIT = 50_000;

function remember(cache: Map<string, string>, input: string, compute: () => string) {
  const known = cache.get(input);
  if (known !== undefined) return known;
  const value = compute();
  if (cache.size >= MEMO_LIMIT) cache.clear();
  cache.set(input, value);
  return value;
}

/**
 * A game's tags as shares of its strongest one, gameplay tags only.
 *
 * Raw weights are crowd vote counts, which run from single digits on a small
 * game to thousands on a famous one. Shares make Hades and an obscure roguelite
 * comparable on shape rather than on how many people voted. Built in the view
 * model so the whole map never has to live on the client.
 */
export function playNextTagProfile(tags: Record<string, number> | null | undefined): Record<string, number> | undefined {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return undefined;
  const entries = Object.entries(tags)
    .map(([label, weight]) => [label.trim(), Number(weight)] as const)
    .filter(([label, weight]) => label && Number.isFinite(weight) && weight > 0 && !NON_TASTE_TAGS.has(tagKey(label)))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, TAG_PROFILE_LIMIT);
  if (!entries.length) return undefined;
  const strongest = entries[0][1];
  return Object.fromEntries(entries.map(([label, weight]) => [label, Math.round((weight / strongest) * 1000) / 1000]));
}

/* ---------------------------------------------------------------- titles */

/**
 * Words that name a release of a game rather than a different game.
 *
 * Steam hands out a new AppID for every remaster and re-release, and libraries
 * are full of both halves: BioShock and BioShock Remastered, Borderlands GOTY
 * and GOTY Enhanced. Without this, finishing one made the other the top "games
 * like this" pick - it is, after all, the most similar game in the library.
 */
const EDITION_WORDS = /\b(game of the year|goty|enhanced|definitive|remastered|remaster|complete|edition|director'?s cut|special|anniversary|deluxe|ultimate|hd|redux|legendary|premium|standard|final cut|reloaded|collection)\b/g;

/** One key per game however many times it was re-released. */
export function editionKey(title: string) {
  return remember(editionKeys, title, () => title
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/\(\d{4}\)/g, " ")
    .replace(EDITION_WORDS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|of the)\s*$/, "")
    .trim());
}

/**
 * One key per series: the title before its subtitle, without a trailing number.
 *
 * "Hades II" and "Hades", "Borderlands 3" and "Borderlands: The Pre-Sequel". A
 * sequel is often exactly the right suggestion, so this never removes one - it
 * only stops a single series taking a whole row.
 */
/**
 * Names put in front of a series rather than being part of it. "Sid Meier's
 * Civilization IV" and "Civilization IV: Beyond the Sword" are one series, and
 * without this they sat side by side on the dashboard. A list rather than a
 * rule: stripping any possessive would turn Baldur's Gate into "gate".
 */
const FRANCHISE_PREFIX = /^(sid meier'?s|tom clancy'?s|marvel'?s|disney'?s|disney|clive barker'?s|american mcgee'?s|shin megami tensei:)\s+/;

export function seriesKey(title: string) {
  return remember(seriesKeys, title, () => {
    const lowered = title.toLowerCase().replace(/[™®©]/g, "").replace(/[’]/g, "'").trim().replace(FRANCHISE_PREFIX, "");
    const head = lowered.split(/:| - | – /)[0] ?? lowered;
    return editionKey(head)
      .replace(/\s+(\d+|[ivx]+)$/, "")
      .trim();
  });
}

/* ---------------------------------------------------------------- affinity */

/**
 * How much two hours count for against twenty.
 *
 * The same floor the learned model uses (lib/genre-preferences.ts): under two
 * hours a game has been tried rather than chosen. Past it, the endorsement grows
 * with the log of time given, so the hundredth hour of an endless game says
 * little more than the twentieth - otherwise one 2,000-hour shooter would
 * outvote every game somebody actually finished.
 */
const ENDORSEMENT_FLOOR_HOURS = 2;
const ENDORSEMENT_FULL_HOURS = 20;

function hoursEndorsement(hours: number) {
  if (!Number.isFinite(hours) || hours < ENDORSEMENT_FLOOR_HOURS) return 0;
  return Math.min(1, Math.log(1 + hours / ENDORSEMENT_FLOOR_HOURS) / Math.log(1 + ENDORSEMENT_FULL_HOURS / ENDORSEMENT_FLOOR_HOURS));
}

type Affinity = { value: number; kind: PlayNextSeedKind | null };

const DAY_MS = 86_400_000;

/**
 * What the player's own actions say about one game, from -1 to 1.
 *
 * Finishing is the loudest yes the library holds, but it is rare: the median
 * account has marked three games finished and nearly half have marked none,
 * while almost all of them have a few dozen games with ten hours or more. So
 * time played carries most of the model, and a finish is worth a little more
 * than the most-played game rather than being the only thing that counts.
 *
 * Sleeping a game is the closest thing the product has to "never again", but it
 * means two different things. Set aside after twenty minutes it is a verdict;
 * set aside after thirty hours it is "I have had my fill", which is praise.
 */
export function playNextAffinity(game: DemoGame, pinned: ReadonlySet<string>, now = Date.now()): Affinity {
  const hours = Math.max(0, Number(game.hoursPlayed) || 0);
  const unknownPlaytime = playtimeIsUnknown(game);

  if (game.status === "Completed") {
    const completedAt = game.completedAt ? Date.parse(game.completedAt) : Number.NaN;
    const recent = Number.isFinite(completedAt) && now - completedAt <= 90 * DAY_MS;
    return { value: recent ? 1 : 0.9, kind: "finished" };
  }

  if (game.status === "Slept") {
    if (unknownPlaytime || hours < ENDORSEMENT_FLOOR_HOURS) return { value: -1, kind: "set-aside" };
    if (hours < 10) return { value: -0.5, kind: "set-aside" };
    return { value: 0, kind: null };
  }

  const endorsement = unknownPlaytime ? 0 : hoursEndorsement(hours);
  if (endorsement > 0) {
    const recent = playedWithin(game.recency, 30);
    // What someone is playing this month is a better guide to next month than
    // what they played in 2019, so current play is worth a little more.
    return { value: Math.min(1, endorsement * 0.85 * (recent ? 1.2 : 1)), kind: recent ? "playing" : "played" };
  }

  if (pinned.has(game.id)) return { value: 0.5, kind: "pinned" };

  // Opened, abandoned within the hour, and left alone for months. Weak on its
  // own - it might have crashed, or been installed on the wrong machine - but
  // in number it is a pattern.
  if (!unknownPlaytime && hours > 0 && hours < 1 && idleForAtLeast(game.recency, 90)) {
    return { value: -0.25, kind: "bounced" };
  }

  return { value: 0, kind: null };
}

/* ---------------------------------------------------------------- vectors */

/**
 * A game's tags as parallel arrays sorted by tag id.
 *
 * Every candidate is compared with up to eighty seeds, which on a five-thousand
 * game library is a third of a million comparisons per build - and the build
 * reruns after every pin and dismissal. String-keyed maps made that 190ms on a
 * desktop and several times worse on the phones most people use this on.
 * Sorted integer ids let two vectors be compared in one pass over both.
 */
type GameVector = { ids: Int32Array; weights: Float64Array; norm: number };

const EMPTY_VECTOR: GameVector = { ids: new Int32Array(0), weights: new Float64Array(0), norm: 0 };

function toVector(entries: Map<number, number>): GameVector {
  if (!entries.size) return EMPTY_VECTOR;
  const sorted = [...entries.entries()].sort((left, right) => left[0] - right[0]);
  const ids = new Int32Array(sorted.length);
  const weights = new Float64Array(sorted.length);
  let total = 0;
  sorted.forEach(([id, weight], index) => {
    ids[index] = id;
    weights[index] = weight;
    total += weight * weight;
  });
  return { ids, weights, norm: Math.sqrt(total) };
}

function rawProfile(game: DemoGame): Array<[string, number]> {
  if (game.tagProfile && Object.keys(game.tagProfile).length) {
    return Object.entries(game.tagProfile);
  }
  // Two in a hundred owned games have no tags yet. Their genres are coarser but
  // still better than leaving them out of every comparison.
  return game.genres
    .filter((genre) => !NON_TASTE_TAGS.has(tagKey(genre)))
    .map((genre) => [genre, 0.5]);
}

function lacksAnEnding(game: DemoGame) {
  return rawProfile(game).slice(0, 3).some(([label]) => NO_ENDING_TAGS.has(tagKey(label)));
}

function isSoftware(game: DemoGame) {
  if (game.genres.some((genre) => genre === "Software")) return true;
  const profile = rawProfile(game);
  // Dominated by app tags, rather than merely carrying one: plenty of games are
  // tagged "Game Development" because they ship a level editor.
  const top = profile.slice(0, 3).map(([label]) => tagKey(label));
  return top.filter((key) => SOFTWARE_TAGS.has(key)).length >= 2;
}

function cosine(left: GameVector, right: GameVector) {
  if (!left.norm || !right.norm) return 0;
  const a = left.ids;
  const b = right.ids;
  let i = 0;
  let j = 0;
  let dot = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x === y) {
      dot += left.weights[i] * right.weights[j];
      i += 1;
      j += 1;
    } else if (x < y) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return dot / (left.norm * right.norm);
}

/**
 * The tags two games most clearly share, strongest first.
 *
 * Ranked on the product of both weights with the rarity counted twice, so the
 * answer is the tags that actually make them alike - "Metroidvania" rather than
 * "Action", which they would share with half the library.
 */
function sharedTags(left: GameVector, right: GameVector, labels: readonly string[], limit = 3) {
  const scored: Array<{ id: number; value: number }> = [];
  let i = 0;
  let j = 0;
  while (i < left.ids.length && j < right.ids.length) {
    const x = left.ids[i];
    const y = right.ids[j];
    if (x === y) {
      scored.push({ id: x, value: left.weights[i] * right.weights[j] });
      i += 1;
      j += 1;
    } else if (x < y) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return scored
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map(({ id }) => labels[id]);
}

/* ---------------------------------------------------------------- the engine */

export type PlayNextInput = {
  /** What can be suggested: the library after the global filters. */
  games: DemoGame[];
  /**
   * What taste is learned from: the whole library. A finished game hidden by a
   * filter set afterwards is still evidence of what someone likes.
   */
  allGames?: DemoGame[];
  pinnedIds?: readonly string[];
  snoozedIds?: readonly string[];
  preferenceContext?: GenrePreferenceContextData | null;
  verdicts?: GameVerdicts | null;
  now?: number;
  topCount?: number;
};

/** Below this two games are not alike enough to put one forward for the other. */
const MIN_SEED_SIMILARITY = 0.32;
/** A seed this weakly endorsed cannot carry a "because" on its own. */
const MIN_SEED_AFFINITY = 0.25;
/**
 * How many of the strongest seeds each candidate is compared against.
 *
 * The comparison is the whole cost of a build, and it grows with seeds times
 * candidates. Forty-eight covers every finished game and most-played game for
 * nearly everyone - the median account has 52 games past ten hours - and the
 * seeds past it are the weakly endorsed ones that rarely win a "because".
 */
const MAX_POSITIVE_SEEDS = 48;
const LANE_LIMIT = 12;

/**
 * The floor each lane must clear before it is offered at all. An empty lane is
 * better than a weak one: "Hidden gems" holding one game nobody would call a gem
 * spends the player's trust on the lanes that are good.
 */
const LANE_MINIMUM: Record<PlayNextLane, number> = {
  because: 30,
  finish: 30,
  gem: 34,
  quick: 30,
  return: 30,
  acclaimed: 30
};

type Candidate = {
  game: DemoGame;
  vector: GameVector;
  taste: number;
  anti: number;
  quality: number;
  jitter: number;
  appeal: GameAppeal;
  best: { seed: SeedEntry; similarity: number } | null;
  /** Every seed this is close enough to be offered for, for the per-game rows. */
  matches: Array<{ seed: SeedEntry; similarity: number }>;
};

type SeedEntry = {
  game: DemoGame;
  affinity: number;
  kind: PlayNextSeedKind;
  vector: GameVector;
};

export function buildPlayNext({
  games,
  allGames = games,
  pinnedIds = [],
  snoozedIds = [],
  preferenceContext = null,
  verdicts = null,
  now = Date.now(),
  topCount = 4
}: PlayNextInput): PlayNextResult {
  const pinned = new Set(pinnedIds);
  const snoozed = new Set(snoozedIds);
  const corpus = uniqueById([...allGames, ...games]).filter((game) => !isSoftware(game));

  // Rarity measured against this player's own library, which is the shelf the
  // suggestions come from. A tag on eighty percent of it tells two of its games
  // apart about as well as the word "game" does.
  const tagIds = new Map<string, number>();
  const labels: string[] = [];
  const documentFrequency: number[] = [];
  const profiles = new Map<string, Array<[number, number]>>();
  for (const game of corpus) {
    const seen = new Set<number>();
    const entries: Array<[number, number]> = [];
    for (const [label, weight] of rawProfile(game)) {
      const key = tagKey(label);
      if (!key || !Number.isFinite(weight) || weight <= 0) continue;
      let id = tagIds.get(key);
      if (id === undefined) {
        id = labels.length;
        tagIds.set(key, id);
        labels.push(label);
        documentFrequency.push(0);
      }
      if (!seen.has(id)) documentFrequency[id] += 1;
      seen.add(id);
      entries.push([id, weight]);
    }
    profiles.set(game.id, entries);
  }
  const documents = Math.max(1, corpus.length);
  const idf = documentFrequency.map((count) => Math.log(1 + documents / Math.max(1, count)));

  const vectors = new Map<string, GameVector>();
  const vectorFor = (game: DemoGame) => {
    const cached = vectors.get(game.id);
    if (cached) return cached;
    const weights = new Map<number, number>();
    for (const [id, weight] of profiles.get(game.id) ?? []) {
      weights.set(id, Math.max(weights.get(id) ?? 0, weight * idf[id]));
    }
    const built = toVector(weights);
    vectors.set(game.id, built);
    return built;
  };

  // ---- seeds: everything the player's actions say about the library
  const positives: SeedEntry[] = [];
  const negatives: SeedEntry[] = [];
  const counts = { finished: 0, played: 0, setAside: 0 };
  for (const game of corpus) {
    const { value, kind } = playNextAffinity(game, pinned, now);
    if (!kind || value === 0) continue;
    const entry = { game, affinity: value, kind, vector: vectorFor(game) };
    if (!entry.vector.norm) continue;
    if (value > 0) positives.push(entry); else negatives.push(entry);
    if (kind === "finished") counts.finished += 1;
    else if (kind === "played" || kind === "playing") counts.played += 1;
    else if (kind === "set-aside" || kind === "bounced") counts.setAside += 1;
  }
  positives.sort((left, right) => right.affinity - left.affinity || left.game.title.localeCompare(right.game.title));
  const seeds = positives.slice(0, MAX_POSITIVE_SEEDS);

  const likeProfile = combine(seeds);
  const avoidProfile = combine(negatives);

  const verdictReference = verdicts ? verdictBaseline(verdicts) : 0.5;
  const dayKey = new Date(now).toISOString().slice(0, 10);
  // Three seeds is where a profile starts to describe a person rather than one
  // game. Below it, taste is treated as unknown rather than as a dislike of
  // everything, so a new account's shelf is decided on the games' own merits.
  const hasTaste = seeds.length >= 3;

  // Releases of a game somebody has already played, finished or put away. Not
  // new to them, whatever the AppID says.
  const experienced = new Map<string, string>();
  for (const game of corpus) {
    const touched = game.status === "Completed" || game.status === "Slept"
      || (!playtimeIsUnknown(game) && Number(game.hoursPlayed || 0) >= ENDORSEMENT_FLOOR_HOURS);
    if (touched) experienced.set(editionKey(game.title), game.id);
  }

  // ---- candidates: everything still waiting that nobody has ruled out
  const candidates: Candidate[] = games
    .filter((game) => isCandidate(game, pinned, snoozed))
    .filter((game) => {
      const owner = experienced.get(editionKey(game.title));
      return !owner || owner === game.id;
    })
    .map((game) => {
      const vector = vectorFor(game);
      const appeal = gameAppeal(game);
      let best: Candidate["best"] = null;
      let bestStrength = 0;
      const matches: Candidate["matches"] = [];
      for (const seed of seeds) {
        if (seed.game.id === game.id || seed.affinity < MIN_SEED_AFFINITY) continue;
        if (supersededBy(game, seed.game)) continue;
        const similarity = cosine(vector, seed.vector) * modeAgreement(game, seed.game);
        if (similarity >= MIN_SEED_SIMILARITY) matches.push({ seed, similarity });
        // Similarity decides; affinity only settles near-ties between seeds, so
        // the explanation names the game this one is most like rather than the
        // most-played game it vaguely resembles.
        const strength = similarity * (0.75 + 0.25 * seed.affinity);
        if (strength > bestStrength) {
          best = { seed, similarity };
          bestStrength = strength;
        }
      }
      return {
        game,
        vector,
        // Unknown taste sits at a neutral middle for everyone, so it neither
        // helps nor hurts any one game.
        taste: hasTaste ? cosine(vector, likeProfile) : 0.25,
        anti: cosine(vector, avoidProfile),
        appeal,
        quality: qualityPoints(game, appeal, preferenceContext, verdicts, verdictReference),
        jitter: dailyJitter(game.id, dayKey),
        best,
        matches
      };
    });

  const lanes: Record<PlayNextLane, PlayNextPick[]> = {
    because: [],
    finish: [],
    gem: [],
    quick: [],
    return: [],
    acclaimed: []
  };

  for (const candidate of candidates) {
    for (const pick of lanePicks(candidate, likeProfile, labels, now)) {
      if (pick.score >= LANE_MINIMUM[pick.lane]) lanes[pick.lane].push(pick);
    }
  }

  for (const lane of Object.keys(lanes) as PlayNextLane[]) {
    lanes[lane] = diversify(
      lanes[lane].sort((left, right) => right.score - left.score || left.game.title.localeCompare(right.game.title)),
      2
    ).slice(0, LANE_LIMIT);
  }

  return {
    // Chosen for spread, shown strongest first.
    top: assembleTop(lanes, topCount).sort((left, right) => right.score - left.score),
    lanes,
    becauseGroups: buildBecauseGroups(candidates, labels, now),
    taste: {
      likes: topTags(likeProfile, 8).map((id) => labels[id]),
      avoids: topTags(avoidProfile, 6, new Set(topTags(likeProfile, 8))).map((id) => labels[id]),
      ...counts
    },
    candidateCount: candidates.length
  };
}

/**
 * How far two games' ways of being played agree.
 *
 * Tags cannot see this well: DOOM and Half-Life Deathmatch share "FPS", "Action"
 * and "Shooter", and finishing a campaign says very little about wanting to be
 * shot at by strangers. A mismatch discounts the likeness rather than ruling it
 * out, because plenty of people genuinely play both.
 */
function modeAgreement(left: DemoGame, right: DemoGame) {
  const a = left.playerMode;
  const b = right.playerMode;
  if (!a || !b || a === b) return 1;
  if ((a === "single" && b === "multi") || (a === "multi" && b === "single")) return 0.75;
  return 0.9;
}

/**
 * An older competitive game in the series someone is already playing.
 *
 * Counter-Strike: Source is the most similar game in the library to Counter-
 * Strike 2 and is not a suggestion anybody wants: its players moved on with the
 * series. A single-player entry is different - a sequel or prequel to something
 * you finished is often the best pick there is - so only competitive games are
 * treated as replaced by their successor.
 */
function supersededBy(candidate: DemoGame, seed: DemoGame) {
  if (candidate.playerMode !== "multi") return false;
  return seriesKey(candidate.title) === seriesKey(seed.title);
}

/**
 * At most one release of a game, and at most `perSeries` of a series, keeping
 * the order it was given. A row of four Borderlands is one suggestion, not four.
 */
function diversify(picks: PlayNextPick[], perSeries: number) {
  const editions = new Set<string>();
  const series = new Map<string, number>();
  return picks.filter((pick) => {
    const edition = editionKey(pick.game.title);
    const family = seriesKey(pick.game.title);
    if (editions.has(edition) || (series.get(family) ?? 0) >= perSeries) return false;
    editions.add(edition);
    series.set(family, (series.get(family) ?? 0) + 1);
    return true;
  });
}

function isCandidate(game: DemoGame, pinned: ReadonlySet<string>, snoozed: ReadonlySet<string>) {
  if (game.ownership !== "Owned") return false;
  if (NON_GAME_TITLE.test(game.title)) return false;
  if (game.status === "Completed" || game.status === "Slept") return false;
  if (pinned.has(game.id) || snoozed.has(game.id)) return false;
  return !isSoftware(game);
}

function combine(entries: SeedEntry[]) {
  const total = new Map<number, number>();
  for (const entry of entries) {
    const scale = Math.abs(entry.affinity) / (entry.vector.norm || 1);
    entry.vector.ids.forEach((id, index) => {
      total.set(id, (total.get(id) ?? 0) + entry.vector.weights[index] * scale);
    });
  }
  return toVector(total);
}

function topTags(vector: GameVector, limit: number, skip: ReadonlySet<number> = new Set()) {
  return [...vector.ids]
    .map((id, index) => ({ id, weight: vector.weights[index] }))
    .filter(({ id }) => !skip.has(id))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit)
    .map(({ id }) => id);
}

/**
 * What the game is worth on its own, in the same points the Vault uses.
 *
 * Reviews, what everybody else did with this exact game, and the learned genre
 * term - which is where the Vault's rerolls, likes and dislikes reach this
 * shelf. Kept as a term added to each lane rather than a lane of its own, so a
 * panned game can still be close to your taste and still lose.
 */
function qualityPoints(
  game: DemoGame,
  appeal: GameAppeal,
  preferenceContext: GenrePreferenceContextData | null,
  verdicts: GameVerdicts | null,
  verdictReference: number
) {
  const verdict = verdictPoints(verdictFor(verdicts, game.steamAppId), verdictReference)
    + popularityPoints(hoursFor(verdicts, game.steamAppId));
  const learned = genrePreferenceAdjustment(preferenceContext, game.genres, game.title, null).points;
  return appeal.points + 0.6 * verdict + 0.5 * learned;
}

/**
 * A small, stable nudge that changes once a day.
 *
 * Without it the shelf is identical every visit until the library changes, and
 * a shelf that never moves stops being read. Two points is enough to reorder
 * near-ties and nowhere near enough to promote a weak pick over a strong one.
 */
function dailyJitter(id: string, dayKey: string) {
  let hash = 2166136261;
  const text = `${id}:${dayKey}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967295) * 4 - 2;
}

function remainingHours(game: DemoGame) {
  const minutes = estimatedTimeToBeatMinutes(game.duration);
  if (!minutes || game.duration?.endless) return null;
  return (minutes * Math.max(0.05, 1 - Math.min(99, game.completionPercent) / 100)) / 60;
}

function isUntouched(game: DemoGame) {
  return playtimeIsUnknown(game) || Number(game.hoursPlayed || 0) < ENDORSEMENT_FLOOR_HOURS;
}

function lanePicks(
  candidate: Candidate,
  likeProfile: GameVector,
  labels: readonly string[],
  now: number
): PlayNextPick[] {
  const { game, taste, anti, quality, jitter, best, appeal } = candidate;
  const picks: PlayNextPick[] = [];
  const hours = Number(game.hoursPlayed || 0);
  const remaining = remainingHours(game);
  const fitTags = taste >= 0.3 ? sharedTags(candidate.vector, likeProfile, labels, 3) : [];
  const neverPlayed = playtimeIsUnknown(game) || canClaimNeverPlayed(game);
  // Closeness to one loved game counts as much as closeness to taste overall.
  // Someone who finished Portal 2 should be offered Portal as a quick win even
  // when most of what they play looks nothing like it.
  const closest = best && best.similarity >= MIN_SEED_SIMILARITY ? best : null;
  const fit = Math.max(taste, closest ? closest.similarity * 0.85 : 0);
  const byLikeness = Boolean(closest && closest.similarity * 0.85 > taste);
  const fitNote = byLikeness && closest ? ` A lot like ${closest.seed.game.title}.` : "";
  const likeTags = byLikeness && closest ? sharedTags(candidate.vector, closest.seed.vector, labels, 3) : fitTags;

  // Because you loved X. The lane the whole feature is built around.
  if (best && best.similarity >= MIN_SEED_SIMILARITY && isUntouched(game)) {
    const seed = toSeed(best.seed);
    const tags = sharedTags(candidate.vector, best.seed.vector, labels, 3);
    picks.push({
      game,
      lane: "because",
      score: 70 * best.similarity + 30 * taste - 35 * anti + quality + jitter,
      headline: becauseHeadline(seed, now),
      detail: tags.length
        ? `Shares ${listLabels(tags)} with ${seed.title}.`
        : `Built a lot like ${seed.title}.`,
      tags,
      seed
    });
  }

  // Nearly there. Needs a length to be honest about "nearly", and stops where
  // the completion sweep starts: past three quarters of the estimate the better
  // question is "did you already finish it?", which the dashboard asks
  // elsewhere. Once the player has answered "not yet", it belongs back here.
  const estimateHours = (estimatedTimeToBeatMinutes(game.duration) ?? 0) / 60;
  const pastEstimate = estimateHours > 0 && hours >= estimateHours * FINISHED_RATIO && !game.completionSuggestionDismissedAt;
  if (!game.duration?.endless && game.playerMode !== "multi" && remaining !== null && !pastEstimate
    && game.completionPercent < 100 && hours > 0 && remaining <= 30
    // "Nearly" has to be true one way or the other: most of the way through,
    // or only a few sittings left. A third of the way into a fifty-hour game
    // is not nearly anything.
    && ((game.completionPercent >= 50) || (game.completionPercent >= 25 && remaining <= 8))) {
    const left = Math.max(1, Math.round(remaining));
    picks.push({
      game,
      lane: "finish",
      score: 30 + 0.45 * game.completionPercent - 0.8 * remaining + 15 * taste + quality + jitter,
      headline: left <= 1 ? "About an hour from the credits" : `About ${left}h from the credits`,
      detail: `You're ${game.completionPercent}% through, so the ending is genuinely in reach.`,
      tags: fitTags,
      seed: null
    });
  }

  // Pick back up. Only with evidence it was dropped: a game we have never
  // watched being played has not been abandoned, merely not observed.
  if (!playtimeIsUnknown(game) && hours >= 3 && game.completionPercent < 90 && idleForAtLeast(game.recency, 45)) {
    const age = game.recency.daysSince === null ? null : approximateAge(game.recency.daysSince);
    picks.push({
      game,
      lane: "return",
      score: 25 + 25 * hoursEndorsement(hours) + 20 * taste - 20 * anti + quality + jitter,
      headline: `You put ${formatHoursShort(hours)} into this`,
      detail: age
        ? game.duration?.endless ? `Last played about ${age} ago. Worth another run?` : `Last played about ${age} ago, so you would still remember where you were.`
        : "And then drifted off it.",
      tags: fitTags,
      seed: null
    });
  }

  // Hidden gems. Adored and obscure, and specifically the ones you have never
  // opened, which are the ones most easily forgotten.
  if (neverPlayed && appeal.hiddenGem >= 0.25) {
    const percent = Math.round((appeal.positivity ?? 0) * 100);
    picks.push({
      game,
      lane: "gem",
      score: 30 + 30 * appeal.hiddenGem + 50 * fit - 30 * anti + quality + jitter,
      headline: "Hidden gem",
      detail: `${percent}% positive from only ${formatReviewCount(appeal.reviewTotal)} reviews${taste >= 0.3 && !byLikeness ? ", and close to what you play" : ""}.${fitNote}`,
      tags: likeTags,
      seed: null
    });
  }

  // Done in an evening. Untouched short games only: a started one with a few
  // hours left is already the finish lane's. Competitive games are left out
  // whatever their listed length - a deathmatch "beaten in two hours" is an
  // estimate of nothing - and so are the poorly liked, because the whole case
  // for a short game is that it is an easy yes.
  //
  // Solo games only. A co-op game that is "done in an evening" still needs a
  // second person free that evening, which is not the promise this lane makes.
  if (isUntouched(game) && remaining !== null && remaining <= 6
    && (game.playerMode === "single" || !game.playerMode) && !lacksAnEnding(game)
    && (appeal.positivity === null || appeal.reviewTotal < 50 || appeal.positivity >= 0.75)) {
    const left = Math.max(1, Math.round(remaining));
    const started = hours >= 0.2 && !playtimeIsUnknown(game);
    picks.push({
      game,
      lane: "quick",
      score: 30 + 3 * (6 - remaining) + 50 * fit - 25 * anti + quality + jitter,
      headline: remaining <= 4 ? "Done in an evening" : `About ${left}h long`,
      detail: `${started ? `About ${left}h left.` : remaining <= 4 ? `Roughly ${left}h start to finish.` : "Short enough to start and finish this week."}${fitNote}`,
      tags: likeTags,
      seed: null
    });
  }

  // Widely loved. Popularity speaks here and only here, and still has to agree
  // with taste to rank: this is the lane Steam's own shelf is made of.
  if (neverPlayed && (appeal.kind === "phenomenon" || appeal.kind === "acclaimed")) {
    const percent = Math.round((appeal.positivity ?? 0) * 100);
    picks.push({
      game,
      lane: "acclaimed",
      score: 25 + 20 * appeal.hype + 50 * fit - 30 * anti + quality + jitter,
      headline: "Widely loved, still unplayed",
      detail: `${percent}% positive across ${formatReviewCount(appeal.reviewTotal)} reviews.${fitNote}`,
      tags: likeTags,
      seed: null
    });
  }

  return picks.map((pick) => ({ ...pick, score: Math.round(pick.score * 10) / 10 }));
}

function toSeed(entry: SeedEntry): PlayNextSeed {
  return {
    id: entry.game.id,
    title: entry.game.title,
    kind: entry.kind,
    hoursPlayed: Number(entry.game.hoursPlayed || 0),
    completedAt: entry.game.completedAt ?? null
  };
}

export function becauseHeadline(seed: PlayNextSeed, now = Date.now()) {
  if (seed.kind === "finished") {
    const completedAt = seed.completedAt ? Date.parse(seed.completedAt) : Number.NaN;
    const justNow = Number.isFinite(completedAt) && now - completedAt <= 30 * DAY_MS;
    return `Because you ${justNow ? "just finished" : "finished"} ${seed.title}`;
  }
  if (seed.kind === "playing") return `Because you've been playing ${seed.title}`;
  if (seed.kind === "pinned") return `Like ${seed.title}, which you pinned`;
  return `Because you played ${formatHoursShort(seed.hoursPlayed)} of ${seed.title}`;
}

function formatHoursShort(hours: number) {
  if (hours < 1) return "under an hour";
  if (hours < 10) return `${Math.round(hours * 10) / 10}h`.replace(".0h", "h");
  return `${Math.round(hours)}h`;
}

/**
 * The dashboard's handful: the best answer from each lane that has one, in the
 * order they are most useful, before any lane gets a second say.
 *
 * Strictly by score, "because" would take every slot for anyone with a big
 * library, and the shelf would be four variations on one game. A finish in reach
 * and a forgotten gem are different kinds of answer, and the point of showing
 * four is to offer four kinds.
 */
const TOP_LANE_ORDER: PlayNextLane[] = ["because", "finish", "gem", "quick", "return", "acclaimed"];

function assembleTop(lanes: Record<PlayNextLane, PlayNextPick[]>, count: number) {
  const chosen: PlayNextPick[] = [];
  const usedGames = new Set<string>();
  const usedSeries = new Set<string>();
  const usedSeeds = new Set<string>();
  const available = (pick: PlayNextPick) => !usedGames.has(pick.game.id) && !usedSeries.has(seriesKey(pick.game.title));
  const take = (pick: PlayNextPick | undefined) => {
    if (!pick || chosen.length >= count) return;
    chosen.push(pick);
    usedGames.add(pick.game.id);
    usedSeries.add(seriesKey(pick.game.title));
    if (pick.seed) usedSeeds.add(pick.seed.id);
  };

  for (const lane of TOP_LANE_ORDER) {
    take(lanes[lane].find(available));
  }
  // Second pass: more "because", each for a different game you loved.
  while (chosen.length < count) {
    const next = lanes.because.find((pick) => available(pick) && pick.seed && !usedSeeds.has(pick.seed.id));
    if (!next) break;
    take(next);
  }
  // Last resort: round the lanes again, one at a time, so a thin profile gets
  // a spread rather than three of whichever lane happens to be deepest.
  let progressed = true;
  while (chosen.length < count && progressed) {
    progressed = false;
    for (const lane of TOP_LANE_ORDER) {
      const next = lanes[lane].find(available);
      if (next) {
        take(next);
        progressed = true;
      }
    }
  }
  return chosen;
}

function listLabels(labels: string[]) {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

const MAX_BECAUSE_GROUPS = 5;
const MAX_PICKS_PER_GROUP = 4;

/**
 * One row per game the player loved: the unplayed games closest to it.
 *
 * Built from each seed outwards rather than by grouping the lane, where every
 * game belongs only to the seed it is closest to. That left rows of one - the
 * game someone is playing this week could own a single neighbour because its
 * other neighbours were each a hair closer to something finished years ago. A
 * row answers "what is like Hollow Knight", so it takes the games most like
 * Hollow Knight, and the page shows each game once, in the first row that
 * claims it.
 */
function buildBecauseGroups(candidates: Candidate[], labels: readonly string[], now: number): PlayNextBecauseGroup[] {
  const bySeed = new Map<string, { seed: SeedEntry; picks: PlayNextPick[] }>();
  for (const candidate of candidates) {
    if (!isUntouched(candidate.game)) continue;
    for (const match of candidate.matches) {
      const seed = toSeed(match.seed);
      const tags = sharedTags(candidate.vector, match.seed.vector, labels, 3);
      const score = 70 * match.similarity + 30 * candidate.taste - 35 * candidate.anti + candidate.quality + candidate.jitter;
      if (score < LANE_MINIMUM.because) continue;
      const entry = bySeed.get(seed.id) ?? { seed: match.seed, picks: [] };
      entry.picks.push({
        game: candidate.game,
        lane: "because",
        score: Math.round(score * 10) / 10,
        headline: becauseHeadline(seed, now),
        detail: tags.length ? `Shares ${listLabels(tags)} with ${seed.title}.` : `Built a lot like ${seed.title}.`,
        tags,
        seed
      });
      bySeed.set(seed.id, entry);
    }
  }

  // Strongest first, with what is fresh in the player's mind pulled forward.
  // "Because you just finished Hollow Knight" is the row someone is most ready
  // to act on, and ranked on similarity alone it lost to a game finished two
  // years ago whose neighbours happened to be closer.
  const freshness = (seed: PlayNextSeed) => {
    if (seed.kind === "playing") return 10;
    const completedAt = seed.completedAt ? Date.parse(seed.completedAt) : Number.NaN;
    return seed.kind === "finished" && Number.isFinite(completedAt) && now - completedAt <= 45 * DAY_MS ? 12 : 0;
  };
  const ranked = [...bySeed.values()]
    .map((entry) => {
      // One series per row, where a lane as a whole allows two: a row is short
      // enough that a second Borderlands is a slot that could have been
      // something else.
      const picks = diversify(entry.picks.sort((left, right) => right.score - left.score), 1);
      return { seed: toSeed(entry.seed), picks, rank: (picks[0]?.score ?? 0) + freshness(toSeed(entry.seed)) };
    })
    .filter((entry) => entry.picks.length)
    .sort((left, right) => right.rank - left.rank);

  const used = new Set<string>();
  const groups: PlayNextBecauseGroup[] = [];
  const build = (minimum: number) => {
    for (const entry of ranked) {
      if (groups.length >= MAX_BECAUSE_GROUPS) break;
      if (groups.some((group) => group.seed.id === entry.seed.id)) continue;
      const picks = entry.picks.filter((pick) => !used.has(pick.game.id)).slice(0, MAX_PICKS_PER_GROUP);
      if (picks.length < minimum) continue;
      for (const pick of picks) used.add(pick.game.id);
      groups.push({ seed: entry.seed, headline: picks[0].headline, picks });
    }
  };
  // Rows of two or more first. A single game under a heading reads as a gap,
  // so a lone neighbour only gets a row when there is nothing fuller to show.
  build(2);
  if (!groups.length) build(1);
  return groups;
}

function uniqueById(games: DemoGame[]) {
  const seen = new Map<string, DemoGame>();
  for (const game of games) if (!seen.has(game.id)) seen.set(game.id, game);
  return [...seen.values()];
}

/**
 * Keeps each suggestion in the slot it was already in.
 *
 * Dismissing one card changes the input to the whole shelf, and rebuilding it
 * from scratch could move the three cards nobody touched - the one somebody was
 * about to press slides out from under their thumb. Survivors keep their slots,
 * newcomers fill the gaps in the order they rank, and anything past the new
 * length falls away.
 */
export function keepSlots<T extends { game: { id: string } }>(previousIds: readonly string[], picks: readonly T[]): T[] {
  const byId = new Map(picks.map((pick) => [pick.game.id, pick]));
  const newcomers = picks.filter((pick) => !previousIds.includes(pick.game.id));
  const arranged: T[] = [];
  for (const id of previousIds) {
    const survivor = byId.get(id);
    const next = survivor ?? newcomers.shift();
    if (next) arranged.push(next);
  }
  return [...arranged, ...newcomers].slice(0, picks.length);
}
