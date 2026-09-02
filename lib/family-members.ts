import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchOwnedSteamGames, fetchSteamPlayerSummary } from "@/lib/steam";
import { SteamLibraryUnavailableError } from "@/lib/steam-owned-games";
import { fetchSteamResponse, readSteamJson, SteamApiError } from "@/lib/steam-api-error";
import { canonicalSteamProfileUrl, isSteamId, parseSteamProfileInput, type SteamProfileReference } from "@/lib/steam-profile-input";
import {
  familyImportCounts,
  MAX_FAMILY_MEMBERS,
  planFamilyImport,
  type FamilyCandidate,
  type FamilyImportCounts
} from "@/lib/family-sharing";
import { listAccessibleAppIds, removeFamilyMemberGames, upsertFamilyGames } from "@/lib/family-games";
import { ensureCatalogueGameStubs, recordAutomaticSteamQuarantine, recordImportedSteamAppIds } from "@/lib/catalogue";
import type { GamePayload } from "@/lib/types";

/**
 * Family members, and the shelves they lend.
 *
 * This is the approximation tier. It asks Steam nothing it is not allowed to
 * ask: each member's public owned-games list, through the same developer key
 * and the same parser the manual-profile onboarding already uses. What it
 * cannot know for certain is whether any given game is actually shareable, so
 * it never claims to - see lib/family-sharing.ts for how that judgement is made
 * and how "we do not know yet" stays distinct from "no".
 *
 * The whole candidate list is stored on the member row. That is what makes the
 * re-check cheap and, more importantly, correct: the interesting games are
 * precisely the ones the catalogue had not fetched categories for at the time,
 * and those become answerable days later without asking Steam again.
 */

export type FamilyMember = {
  id: string;
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  librarySeen: number;
  gamesImported: number;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type FamilyMemberRow = {
  id: string;
  user_id: string;
  steam_id: string;
  display_name: string;
  avatar_url: string | null;
  profile_url: string | null;
  candidate_appids: Array<number | string>;
  library_seen: number;
  games_imported: number;
  last_synced_at: string | null;
  last_error: string | null;
};

export class FamilyMemberError extends Error {
  readonly code:
    | "profile_not_found"
    | "library_private"
    | "library_empty"
    | "library_unavailable"
    | "steam_unavailable"
    | "limit_reached"
    | "already_added"
    | "is_self"
    | "not_found";

  constructor(code: FamilyMemberError["code"], message: string) {
    super(message);
    this.name = "FamilyMemberError";
    this.code = code;
  }
}

/**
 * A whole Steam library, capped so one enormous shelf cannot flood the queue.
 *
 * Real libraries get close to this - one account here holds 4,741 games - so the
 * cap is not theoretical, and a shelf that hits it is reported rather than
 * quietly shortened. Timing says the ceiling could be higher (a 5,000-game add
 * costs about ten seconds against a sixty-second limit); it stays here until
 * something actually needs it raised.
 */
const MAX_CANDIDATES = 5000;

function steamApiKey() {
  const apiKey = process.env.STEAM_WEB_API_KEY?.trim();
  if (!apiKey) {
    throw new FamilyMemberError("steam_unavailable", "Family sharing is temporarily unavailable. Please try again shortly.");
  }
  return apiKey;
}

export async function listFamilyMembers(userId: string): Promise<FamilyMember[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("user_family_members")
    .select("id, steam_id, display_name, avatar_url, profile_url, library_seen, games_imported, last_synced_at, last_error")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toFamilyMember);
}

async function loadMemberRows(userId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("user_family_members")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as FamilyMemberRow[];
}

async function steamIdForReference(reference: SteamProfileReference, apiKey: string) {
  if (reference.kind === "steam_id") return reference.steamId;

  const params = new URLSearchParams({ key: apiKey, vanityurl: reference.vanity, url_type: "1", format: "json" });
  const response = await fetchSteamResponse(
    "resolve_vanity",
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?${params.toString()}`,
    { headers: { "User-Agent": "VaultShuffle/0.1" }, cache: "no-store", signal: AbortSignal.timeout(12_000) }
  );
  const payload = await readSteamJson(response, "resolve_vanity") as { response?: { success?: number; steamid?: unknown } };
  const steamId = String(payload?.response?.steamid ?? "");
  if (payload?.response?.success !== 1 || !isSteamId(steamId)) {
    throw new FamilyMemberError("profile_not_found", "We could not find that Steam profile. Check the link or try the 17-digit Steam ID.");
  }
  return steamId;
}

export type FamilyMemberAddResult = {
  member: FamilyMember;
  counts: FamilyImportCounts;
  /** Games beyond MAX_CANDIDATES that were not read. Zero for almost everybody. */
  truncated: number;
};

/**
 * Add one family member and take a first pass at their shelf.
 *
 * The account's own Steam ID is refused outright. Adding yourself would import
 * your own library a second time as "family", which is both useless and the
 * kind of thing that makes the whole feature look untrustworthy.
 */
export async function addFamilyMember(
  userId: string,
  ownSteamId: string,
  input: string
): Promise<FamilyMemberAddResult> {
  const existing = await loadMemberRows(userId);
  if (existing.length >= MAX_FAMILY_MEMBERS) {
    throw new FamilyMemberError(
      "limit_reached",
      `A Steam family holds six accounts, so VaultShuffle takes ${MAX_FAMILY_MEMBERS} besides your own.`
    );
  }

  const apiKey = steamApiKey();
  const reference = parseSteamProfileInput(input);
  const steamId = await steamIdForReference(reference, apiKey);

  if (steamId === ownSteamId) {
    throw new FamilyMemberError("is_self", "That is your own Steam profile. Add the people you share a Steam family with.");
  }
  if (existing.some((member) => member.steam_id === steamId)) {
    throw new FamilyMemberError("already_added", "That family member has already been added.");
  }

  const [profileResult, gamesResult] = await Promise.allSettled([
    fetchSteamPlayerSummary(steamId, apiKey, true),
    fetchOwnedSteamGames(steamId, apiKey)
  ]);

  if (profileResult.status === "rejected") throw asFamilyError(profileResult.reason);
  const profile = profileResult.value;
  if (!profile) throw new FamilyMemberError("profile_not_found", "We could not find that Steam profile. Check the link and try again.");

  if (gamesResult.status === "rejected") {
    if (gamesResult.reason instanceof SteamLibraryUnavailableError && profile.community_visibility_state && profile.community_visibility_state !== 3) {
      throw new FamilyMemberError("library_private", "That profile's games are private. They need to set Game details to Public in Steam's privacy settings.");
    }
    throw asFamilyError(gamesResult.reason);
  }

  const wholeLibrary = gamesResult.value;
  const library = wholeLibrary.slice(0, MAX_CANDIDATES);
  const truncated = wholeLibrary.length - library.length;
  const now = new Date().toISOString();

  const { data, error } = await getSupabaseAdmin()
    .from("user_family_members")
    .insert({
      user_id: userId,
      steam_id: steamId,
      display_name: profile.display_name || "Steam player",
      avatar_url: profile.avatar_url,
      profile_url: canonicalSteamProfileUrl(steamId),
      candidate_appids: library.flatMap((game) => {
        const appId = Number(game.steam_appid);
        return Number.isSafeInteger(appId) && appId > 0 ? [appId] : [];
      }),
      library_seen: library.length,
      last_synced_at: now,
      updated_at: now
    })
    .select("*")
    .single();

  if (error) {
    if (String(error.message ?? "").includes("FAMILY_MEMBER_LIMIT_REACHED")) {
      throw new FamilyMemberError("limit_reached", `VaultShuffle takes ${MAX_FAMILY_MEMBERS} family members besides your own account.`);
    }
    throw error;
  }

  // Planned across the whole family rather than just the new shelf. The copy
  // count is how many members hold a title, and a title two people own would
  // otherwise be written back down to one copy by whichever add ran last.
  //
  // Every candidate gets a catalogue stub, not only the ones importing now: the
  // stub is what queues the metadata fetch, and that fetch is what turns a
  // "still being checked" game into a decided one on the next re-check.
  const inserted = data as FamilyMemberRow;
  const { byMember, totals } = await runFamilyImport(userId, [...existing, inserted], library);

  const member = (await listFamilyMembers(userId)).find((entry) => entry.steamId === steamId);
  if (!member) throw new FamilyMemberError("not_found", "That family member could not be saved. Please try again.");

  return { member, counts: byMember.get(inserted.id) ?? totals, truncated };
}

/**
 * Re-decide what every member's shelf contributes, without asking Steam again.
 *
 * Called on demand from the dashboard. The candidate lists are already stored,
 * so this is purely a catalogue question: which of the games we could not judge
 * last time can we judge now.
 */
export async function recheckFamilyLibrary(userId: string): Promise<FamilyImportCounts> {
  const members = await loadMemberRows(userId);
  if (!members.length) return { seen: 0, importable: 0, alreadyOwned: 0, excluded: 0, pending: 0 };
  const { totals } = await runFamilyImport(userId, members);
  return totals;
}

/**
 * Turn stored candidates into family rows.
 *
 * `freshLibrary` is only supplied on the first pass, when Steam has just told us
 * the titles. Afterwards the catalogue is the source of names, which is correct:
 * by then it holds the canonical one rather than whatever the owner's locale
 * returned.
 */
type FamilyImportOutcome = {
  totals: FamilyImportCounts;
  byMember: Map<string, FamilyImportCounts>;
};

async function runFamilyImport(
  userId: string,
  members: FamilyMemberRow[],
  freshLibrary?: GamePayload[]
): Promise<FamilyImportOutcome> {
  const { owned } = await listAccessibleAppIds(userId);

  const titlesFromSteam = new Map<string, string>();
  for (const game of freshLibrary ?? []) {
    if (game.steam_appid) titlesFromSteam.set(String(game.steam_appid), game.title);
  }

  // A first pass has titles Steam just gave us and no catalogue rows yet, so the
  // stubs have to be written before anything can be judged or joined against.
  if (freshLibrary?.length) {
    await ensureFamilyCatalogueStubs(freshLibrary);
  }

  const allAppIds = [...new Set(members.flatMap((member) => (member.candidate_appids ?? []).map(String)))];
  const facts = await catalogueFactsFor(allAppIds);

  const totals: FamilyImportCounts = { seen: 0, importable: 0, alreadyOwned: 0, excluded: 0, pending: 0 };
  const byMember = new Map<string, FamilyImportCounts>();
  // One AppID can come from several members. The owner recorded is whichever
  // member's shelf it was found on first, which is what the card names.
  const ownersByAppId = new Map<string, string[]>();
  const importable = new Map<string, { title: string }>();

  for (const member of members) {
    const candidates: FamilyCandidate[] = (member.candidate_appids ?? []).flatMap((value) => {
      const appId = String(value);
      const fact = facts.get(appId);
      const title = fact?.name || titlesFromSteam.get(appId) || "";
      if (!title) return [];
      return [{
        steamAppId: appId,
        title,
        facts: { categories: fact?.categories ?? null, isFree: fact?.isFree ?? null, quarantined: fact?.quarantined ?? false }
      }];
    });

    const plan = planFamilyImport(candidates, owned);
    const counts = familyImportCounts(plan);
    byMember.set(member.id, counts);
    totals.seen += counts.seen;
    totals.importable += counts.importable;
    totals.alreadyOwned += counts.alreadyOwned;
    totals.excluded += counts.excluded;
    totals.pending += counts.pending;

    for (const game of plan.importable) {
      importable.set(game.steamAppId, { title: game.title });
      ownersByAppId.set(game.steamAppId, [...(ownersByAppId.get(game.steamAppId) ?? []), member.steam_id]);
    }

    const { error } = await getSupabaseAdmin()
      .from("user_family_members")
      .update({
        games_imported: counts.importable,
        last_synced_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", member.id)
      .eq("user_id", userId);
    // A stale count on the roster is cosmetic; the games themselves are written
    // below. Failing the whole import over it would be the worse outcome.
    if (error) console.warn("Could not update family member counts", error.message);
  }

  if (importable.size) {
    const appIds = [...importable.keys()];
    // Only the games actually joining the library are pushed into the priority
    // ingest queue, and they get exactly the treatment an owned game gets.
    //
    // The candidates we could NOT judge are deliberately left out of it. They
    // already exist as deliberately-stale catalogue stubs, so the nightly stale
    // sweep will reach them on its own schedule - whereas queueing three
    // thousand games nobody owns at import priority would spend the Steam Store
    // budget, and the Fluid CPU behind it, on somebody else's shelf while real
    // owned games waited. Slower is the right trade here; the counts say
    // "still being checked" and the re-check is one button.
    await recordImportedSteamAppIds(userId, appIds).catch(() => ({ queued: 0 }));
    await upsertFamilyGames(
      userId,
      [...importable.entries()].map(([steamAppId, game]) => ({
        steam_appid: steamAppId,
        title: game.title,
        family_owner_steam_id: ownersByAppId.get(steamAppId)?.[0] ?? null
      }))
    );
  }

  return { totals, byMember };
}

export type FamilyMemberRemoval = {
  /** Games deleted outright, because nobody else in the family provides them. */
  removed: number;
  /** Games another remaining member also shares, so access continues. */
  retained: number;
  displayName: string;
};

/**
 * Stop borrowing from one person.
 *
 * Three things happen, in an order that matters:
 *
 *  1. Games another remaining member also shares are worked out first, and kept.
 *     Access has not gone; only one route to it has.
 *  2. Everything else of theirs leaves. A row the player actually engaged with -
 *     a note on it, or marked Completed or Slept - is retired rather than
 *     deleted, so their own record of having played something survives losing
 *     the ability to play it. The rest is deleted, and the database cascades
 *     that to its pins, snoozes and collection memberships.
 *  3. The remaining members are re-planned. Without this, a game that stays
 *     because two people had it keeps pointing at the one who left, and its card
 *     would go from naming an owner to saying "a family member" for no visible
 *     reason. Costs a catalogue read and no Steam call.
 */
export async function removeFamilyMember(userId: string, memberId: string): Promise<FamilyMemberRemoval> {
  const members = await loadMemberRows(userId);
  const target = members.find((member) => member.id === memberId);
  if (!target) throw new FamilyMemberError("not_found", "That family member is no longer on your account.");

  const others = members.filter((member) => member.id !== memberId);
  const retainedAppIds = new Set(others.flatMap((member) => (member.candidate_appids ?? []).map(String)));
  const theirs = new Set((target.candidate_appids ?? []).map(String));
  const retained = [...theirs].filter((appId) => retainedAppIds.has(appId)).length;

  const removed = await removeFamilyMemberGames(userId, target.steam_id, [...retainedAppIds]);

  const { error } = await getSupabaseAdmin()
    .from("user_family_members")
    .delete()
    .eq("id", memberId)
    .eq("user_id", userId);
  if (error) throw error;

  // Re-attribute what stayed to somebody who is still here.
  if (others.length) await runFamilyImport(userId, others);

  return { removed, retained, displayName: target.display_name };
}

type CatalogueFact = {
  name: string;
  categories: string[] | null;
  isFree: boolean | null;
  quarantined: boolean;
};

/**
 * What the catalogue knows about these AppIDs.
 *
 * categories is the evidence the eligibility rule stands on - Steam publishes
 * family-sharing eligibility as a store category and VaultShuffle already keeps
 * it for the player-mode filter, so this asks nothing new of Steam.
 */
async function catalogueFactsFor(appIds: string[]): Promise<Map<string, CatalogueFact>> {
  const facts = new Map<string, CatalogueFact>();
  if (!appIds.length) return facts;

  const supabase = getSupabaseAdmin();
  const numeric = appIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);

  for (let index = 0; index < numeric.length; index += 500) {
    const batch = numeric.slice(index, index + 500);
    const [{ data: games, error }, { data: quarantined, error: quarantineError }] = await Promise.all([
      supabase.from("catalog_games").select("steam_appid, name, categories, is_free").in("steam_appid", batch),
      supabase.from("catalog_game_quarantine").select("steam_appid").eq("review_status", "excluded").in("steam_appid", batch)
    ]);
    if (error) throw error;
    if (quarantineError) throw quarantineError;

    const excluded = new Set((quarantined ?? []).map((row) => String((row as { steam_appid: number }).steam_appid)));
    for (const row of (games ?? []) as Array<{ steam_appid: number; name: string; categories: string[] | null; is_free: boolean | null }>) {
      const appId = String(row.steam_appid);
      facts.set(appId, {
        name: row.name,
        categories: row.categories,
        isFree: row.is_free,
        quarantined: excluded.has(appId)
      });
    }
  }

  return facts;
}

/**
 * Stub every candidate, not only the ones importing now.
 *
 * The stub is what makes a game knowable later: it carries a deliberately stale
 * metadata timestamp, so the nightly catalogue sweep will fetch its categories,
 * and categories are the entire basis on which a game is judged shareable. A
 * candidate with no stub can never leave "still being checked".
 */
async function ensureFamilyCatalogueStubs(library: GamePayload[]) {
  await ensureCatalogueGameStubs(library);
  await recordAutomaticSteamQuarantine(library);
}

function toFamilyMember(row: Record<string, unknown>): FamilyMember {
  const steamId = String(row.steam_id ?? "");
  return {
    id: String(row.id ?? ""),
    steamId,
    displayName: String(row.display_name ?? "Steam player"),
    avatarUrl: (row.avatar_url as string | null) ?? null,
    profileUrl: (row.profile_url as string | null) ?? canonicalSteamProfileUrl(steamId),
    librarySeen: Number(row.library_seen ?? 0),
    gamesImported: Number(row.games_imported ?? 0),
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null
  };
}

function asFamilyError(error: unknown) {
  if (error instanceof FamilyMemberError || error instanceof SteamApiError) return error;
  if (error instanceof SteamLibraryUnavailableError) {
    return new FamilyMemberError(error.code, error.message);
  }
  return new FamilyMemberError("steam_unavailable", "Steam could not share that library just now. Please try again.");
}
