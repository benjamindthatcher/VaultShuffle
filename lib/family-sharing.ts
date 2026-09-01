import type { DemoGame } from "./demo-data.ts";

/**
 * Games you can play but do not own.
 *
 * Steam Families lets up to six people share one library. VaultShuffle's whole
 * premise is "what can I play tonight", and for a lot of accounts the honest
 * answer includes a partner's or a sibling's shelf.
 *
 * Family games go through the normal pipeline and appear in the normal places.
 * They are not a second class of object and they do not carry a wall of
 * provenance labelling - a small icon on the card is the whole of it. What this
 * module exists for is the three places where treating them identically to owned
 * games would make the app say something false:
 *
 *  1. Ownership. lib/steam-import-jobs.ts treats Steam's owned-games response as
 *     authoritative and retires anything missing from it. Family games are never
 *     in that response, so an unguarded refresh would retire all of them. This is
 *     invisible to the user and the most damaging of the three.
 *  2. Money. Every value figure on the dashboard is "what this shelf is worth".
 *     Nobody paid for a family game, so counting it inflates the one number on
 *     the page denominated in real currency.
 *  3. Playtime. A family game's playtime belongs to whoever owns it, and we
 *     never copy it across. hours_played = 0 therefore means "never told" rather
 *     than "never played", and anything about to say the latter has to check
 *     first. Same rule as lib/recency.ts: missing is not zero.
 *
 * Note what is NOT on that list: eligibility for the Vault. A family game is
 * drawable exactly like an owned one, including under Something New, because a
 * game from somebody else's shelf is usually the most genuinely new thing in the
 * library. It just cannot be described as never played while doing it.
 */

export type AccessSource = "owned" | "family";

export function isFamilyAccess(source: AccessSource | null | undefined) {
  return source === "family";
}

/**
 * Steam Families holds six accounts. One of them is the player, so five other
 * shelves is the most that can ever legitimately be added - a cap that also
 * stops this becoming a way to merge arbitrary strangers' libraries.
 */
export const MAX_FAMILY_MEMBERS = 5;

/**
 * Steam's own category string, as it arrives in Store appdetails and lands in
 * catalog_games.categories. This is real evidence rather than a guess: Valve
 * publishes family-sharing eligibility as a store category (the same thing
 * category2=62 searches on), and the catalogue already stores it for the player
 * mode filter. Cyberpunk 2077 carries it; a title whose publisher has opted out
 * does not.
 */
export const FAMILY_SHARING_CATEGORY = "Family Sharing";

/**
 * What we are willing to say about one candidate game.
 *
 * "unknown" is load-bearing and is NOT a synonym for "no". The catalogue fills
 * metadata in lazily, so a family member's shelf will always contain titles that
 * have simply not been fetched yet. Calling those ineligible would silently drop
 * real games; calling them eligible would import junk. They are held, counted
 * out loud, and admitted by a later re-check once the catalogue knows.
 */
export type FamilyEligibility = "eligible" | "not_shareable" | "free" | "unknown";

export type FamilyCandidateFacts = {
  /** catalog_games.categories, or null when the catalogue has not fetched it. */
  categories?: string[] | null;
  isFree?: boolean | null;
  /** True when the catalogue has excluded this AppID (soundtracks, tools, demos). */
  quarantined?: boolean | null;
};

export function familyShareEligibility(facts: FamilyCandidateFacts): FamilyEligibility {
  if (facts.quarantined) return "not_shareable";
  // Free games need no family to be playable, so importing them as a favour
  // someone did you is just wrong. They are also the bulk of the difference
  // between two people's public libraries.
  if (facts.isFree) return "free";
  if (!facts.categories?.length) return "unknown";
  return facts.categories.includes(FAMILY_SHARING_CATEGORY) ? "eligible" : "not_shareable";
}

export type FamilyCandidate = {
  steamAppId: string;
  title: string;
  facts: FamilyCandidateFacts;
};

export type FamilyImportPlan = {
  /** Games to write as family rows. */
  importable: FamilyCandidate[];
  /** In the member's library but already this account's own. Not touched. */
  alreadyOwned: FamilyCandidate[];
  /** Steam or the catalogue says these cannot be shared. */
  excluded: FamilyCandidate[];
  /** Waiting on catalogue metadata. Re-checked later, not discarded. */
  pending: FamilyCandidate[];
};

export type FamilyImportCounts = {
  seen: number;
  importable: number;
  alreadyOwned: number;
  excluded: number;
  pending: number;
};

/**
 * Decide what one family member's public library actually contributes.
 *
 * Order matters. Ownership is checked before eligibility because a game the
 * player already owns should never be reported as "excluded" - they own it, the
 * sharing question is moot, and saying otherwise reads as an error.
 */
export function planFamilyImport(
  candidates: FamilyCandidate[],
  ownedAppIds: Iterable<string>
): FamilyImportPlan {
  const owned = new Set([...ownedAppIds].map(String));
  const plan: FamilyImportPlan = { importable: [], alreadyOwned: [], excluded: [], pending: [] };
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const appId = String(candidate.steamAppId || "").trim();
    if (!appId || seen.has(appId)) continue;
    seen.add(appId);

    if (owned.has(appId)) {
      plan.alreadyOwned.push(candidate);
      continue;
    }

    const eligibility = familyShareEligibility(candidate.facts);
    if (eligibility === "eligible") plan.importable.push(candidate);
    else if (eligibility === "unknown") plan.pending.push(candidate);
    else plan.excluded.push(candidate);
  }

  return plan;
}

export function familyImportCounts(plan: FamilyImportPlan): FamilyImportCounts {
  return {
    seen: plan.importable.length + plan.alreadyOwned.length + plan.excluded.length + plan.pending.length,
    importable: plan.importable.length,
    alreadyOwned: plan.alreadyOwned.length,
    excluded: plan.excluded.length,
    pending: plan.pending.length
  };
}

/**
 * The sentence shown after a member is checked.
 *
 * Every number it can print is one we can defend, and the estimate is named as
 * an estimate on the same line rather than in small print somewhere else.
 */
export function describeFamilyImport(counts: FamilyImportCounts, displayName: string) {
  if (!counts.seen) return `${displayName} has no public games we can read.`;
  const parts = [`${counts.importable} look shareable`];
  if (counts.alreadyOwned) parts.push(`${counts.alreadyOwned} you already own`);
  if (counts.excluded) parts.push(`${counts.excluded} cannot be shared`);
  if (counts.pending) parts.push(`${counts.pending} still being checked`);
  return `${counts.seen} games on ${displayName}'s shelf — ${parts.join(", ")}.`;
}

/**
 * Whether the app is allowed to state that this game has never been played.
 *
 * The one thing the family feature genuinely changes about existing copy.
 * hours_played is 0 both when somebody has never launched a game and when the
 * only playtime that exists belongs to the family member who owns it. Saying
 * "Never played" in the second case tells someone with eighty hours in a game
 * that they have never touched it.
 *
 * Callers show nothing rather than substituting a label. "No playtime data" on
 * every card is a worse read than a card that simply does not mention playtime.
 */
export function canClaimNeverPlayed(game: { accessSource?: AccessSource; hoursPlayed?: number | null }) {
  return !isFamilyAccess(game.accessSource) && Number(game.hoursPlayed ?? 0) === 0;
}

/** True when nothing at all can be said about how much this has been played. */
export function playtimeIsUnknown(game: { accessSource?: AccessSource }) {
  return isFamilyAccess(game.accessSource);
}

/**
 * Whose shelf this came from, for the one line that explains the icon.
 *
 * Deliberately short. The card carries an icon and nothing else; this is for the
 * details panel, where there is room for a sentence and where somebody has
 * actively asked what they are looking at.
 */
export function familyProvenance(
  game: Pick<DemoGame, "accessSource" | "familyOwnerName">
): string | null {
  if (!isFamilyAccess(game.accessSource)) return null;
  const owner = game.familyOwnerName?.trim();
  return owner
    ? `Shared from ${owner}'s Steam library. Playtime is theirs, so none is shown here.`
    : "Shared from a family member's Steam library. Playtime is theirs, so none is shown here.";
}
