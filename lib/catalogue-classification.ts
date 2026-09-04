/**
 * What counts as a game, and how sure Steam lets us be.
 *
 * A draw is only worth trusting if everything in the pool is something a player
 * can sit down and play. Steam's storefront does not answer that question
 * directly, and the parts of its answer differ wildly in how much they can be
 * believed. These rules were fixed against the whole 25,988-row catalogue and
 * every AppID's Steam PICS record, so each one below records what the evidence
 * actually supports rather than what the field name suggests.
 *
 * Three verdicts, deliberately:
 *
 * - `excluded`   Steam's answer is reliable here. Hide it without asking.
 * - `review`     Something looks off, but the signal has a real false-positive
 *                rate. Stay visible and wait for a person; hiding a game a
 *                player owns is worse than briefly showing an oddity.
 * - `accepted`   Nothing to answer for.
 */

export type CatalogueVerdict = {
  excluded: boolean;
  reviewRequired: boolean;
  matchedRule: string | null;
  reason: string | null;
};

export type CatalogueEvidence = {
  title: string;
  steamType?: string | null;
  /** Steam sets this on a demo or DLC to point at the app it belongs to. */
  fullGameAppId?: string | number | null;
  genres?: string[] | null;
  categories?: string[] | null;
  /** Steam's "free to play" flag, which a free demo does not always carry. */
  isFree?: boolean | null;
  /** Final price in minor units. Absent when nothing about the app is for sale. */
  priceFinal?: number | null;
};

/**
 * Types Steam gets right. Every AppID the store filed as one of these was a
 * genuine non-game, including the ones whose PICS record disagreed: the six
 * RACE 07 "expansion pack" SKUs are typed `game` in PICS but every one of them
 * carries `fullgame: 8600`, so none of them launches without RACE 07.
 */
const DEFINITIVE_NON_GAME_TYPES = new Set(["dlc", "demo", "music", "movie", "hardware"]);

/**
 * Types that mean nothing on their own, with the counts that settled it.
 *
 * `advertising` is the worst offender in the whole system. It is not a claim
 * about the app; it is a marker left on legacy store pages. 59 of the 65
 * AppIDs it had flagged were plainly games - Prey, Rayman 2, Darksiders II,
 * World in Conflict, Ghost Recon Advanced Warfighter. Acting on it hid a
 * shelf of real games and caught nothing that the software rules below miss.
 *
 * `mod` is nearly as bad: 27 of 29 were standalone free games that need no
 * host game to run (Portal Stories: Mel, Entropy: Zero, NEOTOKYO°, Deus Ex:
 * Revision, Half-Life 2: Update). `video`, `series` and `episode` each mislabel
 * real games too - Babel Rising is typed `video`.
 *
 * These are listed rather than deleted so the next person to read Steam's type
 * field knows the question was asked and answered.
 */
const UNRELIABLE_NON_GAME_TYPES = new Set(["advertising", "mod", "series", "episode", "video"]);

/**
 * Steam's software-only genres. A genre set drawn entirely from this list, with
 * nothing else left over, identifies software with no false positives across
 * the full catalogue: 464 matches, 461 of them typed `application` or `tool` by
 * PICS and the other three (Tilt Brush, Blocks, Fantasynth One) genuinely not
 * games either. This is what catches the Wallpaper Engine class, which Steam's
 * store API cheerfully reports as `type: "game"`.
 */
const SOFTWARE_GENRES = new Set([
  "accounting", "animation & modeling", "audio production", "design & illustration",
  "education", "game development", "photo editing", "software training", "utilities",
  "video production", "web publishing"
]);

/**
 * Labels that say nothing about whether the thing is a game. `free to play` and
 * `early access` describe how it is sold; `indie` describes who made it; the
 * content warnings describe what is in it. None of them rescue an app from the
 * software rule, which is why Tilt Brush (`free to play, design & illustration`)
 * is still correctly identified as software.
 *
 * `casual` is deliberately absent: it is a real game genre, and treating it as
 * neutral would put educational and casual games at risk of being hidden.
 */
const NON_EVIDENTIAL_GENRES = new Set([
  "free to play", "free too play", "early access", "indie",
  "violent", "gore", "nudity", "sexual content"
]);

/**
 * Titles that name a distribution channel rather than a product.
 *
 * Each pattern needs an explicit channel word, because a bare "beta" in a title
 * is routinely part of the shipped name: Serious Sam Fusion 2017 (beta) is how
 * Croteam ships that game, The SKIES and StaudSoft's Synthetic World both
 * launched with it still attached, and CUCKOLD SIMULATOR: Life as a Beta Male
 * Cuck is a real game that the old bare-\bbeta\b rule flagged for review.
 */
const CHANNEL_EXCLUSION_RULES = [
  { matchedRule: "release_channel:playtest", pattern: /\bplay\s?test\b/i },
  { matchedRule: "release_channel:public_test", pattern: /\bpublic[\s-]+(?:test|beta)\b/i },
  { matchedRule: "release_channel:test_environment", pattern: /\btest[\s-]+(?:realm|server|client|environment)\b/i },
  { matchedRule: "release_channel:ptr", pattern: /(?:^|[\s\-–:(\[])ptr(?:$|[\s\-–:)\]])/i },
  { matchedRule: "release_channel:pts", pattern: /(?:^|[\s\-–:(\[])pts(?:$|[\s\-–:)\]])/i },
  { matchedRule: "release_channel:beta", pattern: /\b(?:open|closed|multiplayer|technical|balance|weekend|stress|network|early|free)[\s-]+beta\b/i },
  { matchedRule: "release_channel:beta", pattern: /\bbeta[\s-]+(?:client|test|weekend|build|branch|version|app)\b/i },
  { matchedRule: "release_channel:staging", pattern: /\bstaging(?:[\s-]+branch)?\b/i },
  { matchedRule: "release_channel:benchmark", pattern: /\bbenchmark(?:[\s-]+tool)?\b/i },
  { matchedRule: "release_channel:dedicated_server", pattern: /\bdedicated[\s-]+server\b/i },
  { matchedRule: "release_channel:sdk", pattern: /\b(?:sdk|devkit|dev\s?kit)\b/i }
] as const;

/**
 * A trailing bare "beta" is suspicious but not decisive - see the shipped names
 * above. It earns a look from a person, never an automatic exclusion.
 */
const CHANNEL_REVIEW_RULES = [
  { matchedRule: "release_channel:beta_suffix", pattern: /[\s\-–:(\[]beta[\s)\]]*$/i }
] as const;

/**
 * A "Prologue" is Steam's fashionable way of shipping a demo as its own free
 * app, typed `game`, so none of the type rules above sees it. Sixty-nine of the
 * seventy-four in this catalogue were exactly that - Stoneshard: Prologue,
 * Soulstone Survivors: Prologue, Dark Hours: Prologue - and a draw that lands
 * on one hands the player a taster instead of the game.
 *
 * Being buyable is what separates them from the real products that happen to
 * carry the word: KINGDOM HEARTS HD 2.8 Final Chapter Prologue costs $59.99,
 * START AGAIN: a prologue costs $10.99, and both are whole games.
 */
const PROLOGUE_PATTERN = /\bprologue\b/i;

function isPurchasable(evidence: CatalogueEvidence) {
  return !evidence.isFree && typeof evidence.priceFinal === "number" && evidence.priceFinal > 0;
}

export function classifyCatalogueEntry(evidence: CatalogueEvidence): CatalogueVerdict {
  const title = String(evidence.title || "").trim();
  const steamType = String(evidence.steamType || "").trim().toLowerCase();

  if (DEFINITIVE_NON_GAME_TYPES.has(steamType)) {
    return excludedVerdict(
      `steam_type:${steamType}`,
      `Steam files this AppID as ${steamType}, not a playable game.`
    );
  }

  // A demo or DLC that lost its type still points at the app it belongs to.
  if (evidence.fullGameAppId != null && String(evidence.fullGameAppId).trim() !== "") {
    return excludedVerdict(
      "steam_fullgame_pointer",
      `Steam lists this AppID as content for app ${evidence.fullGameAppId}, so it is not a game on its own.`
    );
  }

  const genres = normaliseLabels(evidence.genres);
  if (isSoftwareOnly(genres)) {
    return excludedVerdict(
      "steam_genres:software_only",
      "Every genre Steam gives this AppID is a software genre, with no game genre alongside them."
    );
  }

  if (PROLOGUE_PATTERN.test(title) && !isPurchasable(evidence)) {
    return excludedVerdict(
      "name:free_prologue",
      "The title is a free \"prologue\", which Steam ships as a standalone demo of a larger game."
    );
  }

  const channelExclusion = CHANNEL_EXCLUSION_RULES.find((rule) => rule.pattern.test(title));
  if (channelExclusion) {
    return excludedVerdict(
      channelExclusion.matchedRule,
      "The title names a test channel, benchmark or development build rather than a released game."
    );
  }

  if (UNRELIABLE_NON_GAME_TYPES.has(steamType)) {
    // Recorded, never acted on. See the note on UNRELIABLE_NON_GAME_TYPES.
    return {
      excluded: false,
      reviewRequired: false,
      matchedRule: null,
      reason: null
    };
  }

  const softwareGenre = genres.find((genre) => SOFTWARE_GENRES.has(genre));
  if (softwareGenre) {
    return reviewVerdict(
      `steam_genres:${softwareGenre}`,
      `Steam applies the ${softwareGenre} genre alongside game genres; a person should confirm this is playable.`
    );
  }

  const channelReview = CHANNEL_REVIEW_RULES.find((rule) => rule.pattern.test(title));
  if (channelReview) {
    return reviewVerdict(
      channelReview.matchedRule,
      "The title ends in \"beta\", which is sometimes a test build and sometimes just the shipped name."
    );
  }

  return { excluded: false, reviewRequired: false, matchedRule: null, reason: null };
}

/** True when Steam's own type is one we refuse to store in `catalog_games`. */
export function isStorableSteamType(steamType?: string | null) {
  return String(steamType || "").trim().toLowerCase() === "game";
}

function isSoftwareOnly(genres: string[]) {
  if (!genres.some((genre) => SOFTWARE_GENRES.has(genre))) return false;
  return !genres.some((genre) => !SOFTWARE_GENRES.has(genre) && !NON_EVIDENTIAL_GENRES.has(genre));
}

function normaliseLabels(labels?: string[] | null) {
  return (labels ?? [])
    .map((label) => String(label).trim().toLowerCase())
    .filter(Boolean);
}

function excludedVerdict(matchedRule: string, reason: string): CatalogueVerdict {
  return { excluded: true, reviewRequired: false, matchedRule, reason };
}

function reviewVerdict(matchedRule: string, reason: string): CatalogueVerdict {
  return { excluded: false, reviewRequired: true, matchedRule, reason };
}
