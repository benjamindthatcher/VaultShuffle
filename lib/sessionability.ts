/**
 * Whether a game suits the sitting you actually have, as opposed to how big a
 * commitment it is in total.
 *
 * "How long have you got?" was answered entirely from remaining playthrough
 * length: Short meant three hours or less left, Weekend meant thirty-plus. That
 * is a different question - it asks how much of a commitment you want, not what
 * works tonight.
 *
 * The two come apart constantly. A fifty-hour roguelike is excellent for forty
 * minutes, because a run is twenty and finishing one is a real ending. A
 * two-hour narrative game is a poor use of forty minutes, because stopping
 * halfway through is the worst way to play it.
 *
 * Steam tags describe this well enough without any modelling. A game whose
 * sessions are self-contained is tagged accordingly; so is one built to be
 * disappeared into.
 */

/** Sessions are self-contained: a run, a match, a race, a level. */
const PICK_UP_TAGS = [
  "arcade", "roguelike", "roguelite", "roguelike deckbuilder", "racing", "fighting",
  "sports", "rhythm", "casual", "puzzle", "party game", "battle royale", "moba",
  "twin stick shooter", "bullet hell", "auto battler", "card game", "board game",
  "tower defense", "platformer", "2d platformer", "precision platformer", "idle",
  "clicker", "shoot 'em up", "beat 'em up", "score attack", "time attack",
  "short", "minigames", "physics", "sokoban", "word game", "trivia", "chess",
  "local multiplayer", "split screen", "pvp", "deathmatch", "hero shooter"
];

/** Wants an uninterrupted block: stopping early costs you something. */
const SIT_DOWN_TAGS = [
  "story rich", "narrative", "visual novel", "grand strategy", "4x", "crpg",
  "management", "colony sim", "city builder", "base building", "turn-based tactics",
  "turn-based strategy", "immersive sim", "open world", "survival", "crafting",
  "walking simulator", "point & click", "detective", "mystery", "investigation",
  "choose your own adventure", "interactive fiction", "text-based", "rpg",
  "jrpg", "party-based rpg", "dungeon crawler", "simulation", "farming sim",
  "life sim", "exploration", "atmospheric", "cinematic"
];

const PICK_UP = new Set(PICK_UP_TAGS);
const SIT_DOWN = new Set(SIT_DOWN_TAGS);

/** How clearly a game leans one way before it counts as more than a nudge. */
export const SESSIONABILITY_CONFIDENT = 0.34;

function normalise(value: string) {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/**
 * -1 to 1. Positive means each sitting stands on its own; negative means the
 * game wants a long uninterrupted run at it. Zero means the tags say nothing
 * either way, which is common and must stay neutral rather than guessing.
 */
export function sessionabilityScore(labels: readonly string[]): number {
  let pickUp = 0;
  let sitDown = 0;
  const seen = new Set<string>();

  for (const label of labels) {
    const key = normalise(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (PICK_UP.has(key)) pickUp += 1;
    if (SIT_DOWN.has(key)) sitDown += 1;
  }

  const total = pickUp + sitDown;
  if (!total) return 0;
  // Divided by the evidence found rather than a fixed cap, so one clear tag is
  // as decisive as five of the same kind - which is how tag lists actually read.
  return (pickUp - sitDown) / total;
}

export type SessionLean = "pick-up" | "sit-down" | "either";

export function sessionLean(score: number): SessionLean {
  if (score >= SESSIONABILITY_CONFIDENT) return "pick-up";
  if (score <= -SESSIONABILITY_CONFIDENT) return "sit-down";
  return "either";
}

/**
 * Plain wording for the result card, or null when the tags said nothing worth
 * repeating. Never invents a claim from an absence of tags.
 */
export function sessionabilityReason(score: number): string | null {
  const lean = sessionLean(score);
  if (lean === "pick-up") return "Picks up and puts down easily";
  if (lean === "sit-down") return "Rewards an uninterrupted run at it";
  return null;
}
