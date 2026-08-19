import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamAppDetails, SteamAppRequestError, SteamAppUnavailableError, fetchSteamDeckCompatibility } from "@/lib/steam";
import type { GamePayload } from "@/lib/types";
import { catalogueGameStubRows } from "@/lib/catalogue-stubs";

const AUTOMATIC_EXCLUSION_LABELS = new Set(["software", "utilities"]);
const AUTOMATIC_RELEASE_CHANNEL_RULES = [
  { matchedRule: "release_channel:playtest", pattern: /\bplaytest\b/i },
  { matchedRule: "release_channel:public_test", pattern: /\bpublic[\s-]+test\b/i },
  { matchedRule: "release_channel:test_environment", pattern: /\btest[\s-]+(?:realm|server)\b/i },
  { matchedRule: "release_channel:ptr", pattern: /\bptr\b/i },
  { matchedRule: "release_channel:pts", pattern: /\bpts\b/i },
  { matchedRule: "release_channel:beta", pattern: /\bbeta\b/i },
  { matchedRule: "release_channel:staging", pattern: /\bstaging(?:[\s-]+branch)?\b/i }
] as const;
type CatalogueQueueRow = { steam_appid: number; attempts: number };
type ManualQuarantineDecision = {
  steam_appid: number;
  review_status: "allowed" | "excluded";
  reason: string | null;
  matched_rule: string | null;
};

export async function recordAutomaticSteamQuarantine(games: GamePayload[]) {
  const supabase = getSupabaseAdmin();
  const detectedCandidates = games.flatMap((game) => {
    const appid = Number(game.steam_appid);
    const matchedRule = automaticCatalogueExclusionRule(game.title, splitLabels(game.genre));
    return Number.isSafeInteger(appid) && appid > 0 && matchedRule
      ? [{
          steam_appid: appid,
          name: game.title,
          matched_rule: matchedRule,
          reason: automaticExclusionReason(matchedRule),
          last_detected_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]
      : [];
  });

  const manualDecisions = await loadManualQuarantineDecisions(
    supabase,
    detectedCandidates.map((candidate) => candidate.steam_appid)
  );
  const candidates = detectedCandidates.filter((candidate) => !manualDecisions.has(candidate.steam_appid));
  if (candidates.length) {
    const { error } = await supabase.from("catalog_game_quarantine").upsert(candidates, { onConflict: "steam_appid" });
    if (error) throw error;
  }

  return candidates.length;
}

export async function recordImportedSteamAppIds(userId: string, appIds: string[]) {
  const ids = uniqueNumericAppIds(appIds);
  if (!ids.length) return { queued: 0 };
  const supabase = getSupabaseAdmin();
  const { data: queued, error } = await supabase.rpc("register_catalog_imports", {
    p_user_id: userId, p_appids: ids, p_priority: 80
  });
  if (error) throw error;
  return { queued: Number(queued || 0) };
}

/**
 * Creates only the shared identity required by the games foreign key. Steam's
 * owned-games response already gives us the AppID and title, so a catalogue
 * miss must never roll back an otherwise usable library import. The existing
 * ingest queue replaces these deliberately stale stubs with full metadata.
 */
export async function ensureCatalogueGameStubs(games: GamePayload[]) {
  const rows = catalogueGameStubRows(games);
  if (!rows.length) return 0;

  const supabase = getSupabaseAdmin();
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase
      .from("catalog_games")
      .upsert(rows.slice(index, index + 500), {
        onConflict: "steam_appid",
        ignoreDuplicates: true
      });
    if (error) throw error;
  }

  return rows.length;
}

/**
 * How many games are still waiting for their first metadata fetch.
 *
 * Only "pending" counts. A "ready" row has already been fetched and is retained
 * as a record, not as outstanding work - counting those as backlog would keep
 * the guard below permanently tripped and stop stale refreshes running at all.
 */
export async function countPendingCatalogueJobs() {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("catalog_ingest_queue")
    .select("steam_appid", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) throw error;
  return Number(count || 0);
}

export async function queueStaleCatalogueMetadata(limit = 100) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("queue_stale_catalogue_metadata", {
    p_limit: clamp(limit, 1, 250)
  });
  if (error) throw error;
  return Number(data || 0);
}

export async function processCatalogueQueue(
  limit = 25,
  restrictToAppIds?: number[],
  deadlineAt = Number.POSITIVE_INFINITY
) {
  const supabase = getSupabaseAdmin();
  const appIds = restrictToAppIds?.length ? uniqueNumericAppIds(restrictToAppIds) : null;
  const { data, error } = await supabase.rpc("claim_catalogue_ingest_jobs", {
    p_limit: clamp(limit, 1, 100),
    p_appids: appIds
  });
  if (error) throw error;
  const rows = (data ?? []) as CatalogueQueueRow[];
  if (!rows.length) {
    return { claimed: 0, processed: 0, accepted: 0, rejected: 0, failed: 0, deferred: 0, rateLimited: false };
  }
  let manualDecisions: Awaited<ReturnType<typeof loadManualQuarantineDecisions>>;
  try {
    manualDecisions = await loadManualQuarantineDecisions(
      supabase,
      rows.map((row) => row.steam_appid)
    );
  } catch (setupError) {
    // Claims must not remain leased if queue setup fails before row processing
    // begins. Releasing them here makes the batch immediately recoverable.
    await releaseCatalogueClaims(rows.map((row) => row.steam_appid));
    throw setupError;
  }

  let accepted = 0;
  let rejected = 0;
  let processed = 0;
  let failed = 0;
  let deferred = 0;
  let rateLimited = false;
  for (const [index, row] of rows.entries()) {
    if (Date.now() + 20_000 >= deadlineAt) {
      const deferredAppIds = rows.slice(index).map((pendingRow) => pendingRow.steam_appid);
      await releaseCatalogueClaims(deferredAppIds);
      deferred += deferredAppIds.length;
      break;
    }

    processed += 1;
    const appid = String(row.steam_appid);
    try {
      const details = await fetchSteamAppDetails(appid);
      if (!details?.title) throw new Error("Steam metadata did not include a title.");

      // catalog_games carries a hard `steam_type = 'game'` check constraint, so a
      // demo, DLC, mod or advertising AppID cannot be stored there at all. These
      // arrive as user imports, get stubbed as 'game' (the only permitted value),
      // and every refresh then tried to write the true type, hit a constraint
      // violation, and recorded it as a transient failure — roughly eighty retries
      // per entry, forever.
      //
      // The shared write is skipped rather than attempted; classification below
      // then quarantines the entry through the same path as every other
      // non-game, so it settles instead of churning.
      const storable = String(details.steam_type || "").trim().toLowerCase() === "game";

      // Preserve the complete shared Steam record before deciding whether it
      // belongs on user-facing game surfaces. Quarantine controls visibility;
      // it must not discard metadata that may be useful for review later.
      if (storable) await persistSteamCatalogueDetails(row.steam_appid, details);

      const manualDecision = manualDecisions.get(row.steam_appid);
      const classification = manualDecision
        ? classificationFromManualDecision(manualDecision)
        : classifySteamCatalogueEntry(details);
      if (!classification.accepted) {
        if (!classification.excluded) {
          throw new Error(classification.reason || "Steam metadata was unavailable.");
        }
        rejected += 1;
        const now = new Date().toISOString();
        if (!manualDecision) {
          const { error: quarantineError } = await supabase.from("catalog_game_quarantine").upsert({
            steam_appid: row.steam_appid,
            name: details?.title || null,
            steam_type: details?.steam_type || null,
            matched_rule: classification.matchedRule,
            reason: classification.reason || "Steam metadata was unavailable.",
            genres: details?.genres ?? [],
            categories: details?.categories ?? [],
            last_detected_at: now,
            updated_at: now
          }, { onConflict: "steam_appid" });
          if (quarantineError) throw quarantineError;
        }
        const { error: rejectedError } = await supabase.from("catalog_ingest_queue").update({ status: "rejected", rejection_reason: classification.reason,
          processed_at: now, processing_started_at: null, updated_at: now })
          .eq("steam_appid", row.steam_appid);
        if (rejectedError) throw rejectedError;
        continue;
      }
      const now = new Date().toISOString();
      accepted += 1;
      const { error: readyError } = await supabase.from("catalog_ingest_queue").update({ status: "ready", processed_at: now,
        processing_started_at: null, last_error: null, updated_at: now }).eq("steam_appid", row.steam_appid);
      if (readyError) throw readyError;
    } catch (error) {
      if (error instanceof SteamAppRequestError && error.status === 429) {
        const retryDelay = Math.max(error.retryAfterMs ?? 0, 30 * 60_000);
        const retryAt = new Date(Date.now() + retryDelay).toISOString();
        const deferredRows = rows.slice(index);
        await deferCatalogueClaimsAfterRateLimit(deferredRows, row, retryAt, error.message);
        processed -= 1;
        deferred += deferredRows.length;
        rateLimited = true;
        break;
      }
      failed += 1;
      const attempts = Number(row.attempts || 0) + 1;
      const unavailable = error instanceof SteamAppUnavailableError;
      const terminal = unavailable ? attempts >= 3 : attempts >= 5;
      const retryDelay = unavailable
        ? 24 * 60 * 60_000
        : Math.min(2 ** attempts * 60_000, 6 * 60 * 60_000);
      const { error: failureUpdateError } = await supabase.from("catalog_ingest_queue").update({ status: terminal ? "failed" : "pending", attempts,
        next_attempt_at: terminal ? null : new Date(Date.now() + retryDelay).toISOString(),
        processing_started_at: null, last_error: catalogueErrorMessage(error),
        updated_at: new Date().toISOString() }).eq("steam_appid", row.steam_appid);
      if (failureUpdateError) throw failureUpdateError;
    }
  }
  return { claimed: rows.length, processed, accepted, rejected, failed, deferred, rateLimited };
}

async function deferCatalogueClaimsAfterRateLimit(
  rows: CatalogueQueueRow[],
  attemptedRow: CatalogueQueueRow,
  retryAt: string,
  message: string
) {
  if (!rows.length) return;
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const attemptedAppId = attemptedRow.steam_appid;
  const untouchedAppIds = rows
    .map((row) => row.steam_appid)
    .filter((steamAppId) => steamAppId !== attemptedAppId);

  const { error: attemptedError } = await supabase
    .from("catalog_ingest_queue")
    .update({
      status: "pending",
      attempts: Number(attemptedRow.attempts || 0) + 1,
      next_attempt_at: retryAt,
      processing_started_at: null,
      last_error: message.slice(0, 500),
      updated_at: now
    })
    .eq("steam_appid", attemptedAppId)
    .eq("status", "processing");
  if (attemptedError) throw attemptedError;

  if (!untouchedAppIds.length) return;
  const { error: untouchedError } = await supabase
    .from("catalog_ingest_queue")
    .update({
      status: "pending",
      next_attempt_at: retryAt,
      processing_started_at: null,
      last_error: "Deferred because the Steam Store rate-limited this worker batch.",
      updated_at: now
    })
    .in("steam_appid", untouchedAppIds)
    .eq("status", "processing");
  if (untouchedError) throw untouchedError;
}

async function releaseCatalogueClaims(steamAppIds: number[]) {
  if (!steamAppIds.length) return;
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("catalog_ingest_queue")
    .update({
      status: "pending",
      processing_started_at: null,
      next_attempt_at: now,
      updated_at: now
    })
    .in("steam_appid", steamAppIds)
    .eq("status", "processing");
  if (error) throw error;
}

async function persistSteamCatalogueDetails(
  steamAppId: number,
  details: NonNullable<Awaited<ReturnType<typeof fetchSteamAppDetails>>>
) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const title = String(details.title || "").trim();
  if (!title) throw new Error("Steam metadata did not include a title.");
  const reviewTotal = Math.max(0, Number(details.review_total || 0));
  const reviewPositive = Math.max(0, Number(details.review_positive || 0));

  // Only fetched when we do not already have it, so the extra request happens
  // once per game rather than on every metadata refresh.
  const { data: existingDeck } = await supabase
    .from("catalog_games")
    .select("deck_compatibility")
    .eq("steam_appid", steamAppId)
    .maybeSingle();
  const knownDeck = (existingDeck as { deck_compatibility?: number | null } | null)?.deck_compatibility ?? null;
  const deckCompatibility = knownDeck ?? await fetchSteamDeckCompatibility(String(steamAppId));
  const isUsd = details.price_currency === "USD";
  const { error } = await supabase.from("catalog_games").upsert({
    steam_appid: steamAppId,
    name: title,
    normalized_name: normalizeName(title),
    steam_type: details.steam_type || "unknown",
    developer: details.developers?.join(", ") || null,
    publisher: details.publishers?.join(", ") || null,
    genres: details.genres ?? [],
    categories: details.categories ?? [],
    short_description: details.short_description || null,
    release_date: details.release_date || null,
    is_free: Boolean(details.is_free),
    deck_compatibility: deckCompatibility,
    deck_checked_at: deckCompatibility === null ? null : now,
    platform_windows: details.platform_windows ?? null,
    platform_mac: details.platform_mac ?? null,
    platform_linux: details.platform_linux ?? null,
    capsule_url: details.capsule_url || null,
    header_url: details.header_url || null,
    review_positive: reviewPositive,
    review_negative: Math.max(0, reviewTotal - reviewPositive),
    price_currency: isUsd ? "USD" : null,
    price_initial: isUsd ? details.price_initial ?? null : null,
    price_final: isUsd ? details.price_final ?? null : null,
    discount_percent: isUsd ? details.discount_percent ?? 0 : 0,
    first_seen_reason: "user_import",
    metadata_fetched_at: now,
    updated_at: now
  }, { onConflict: "steam_appid" });
  if (error) throw error;
}

async function loadManualQuarantineDecisions(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appids: number[]
) {
  const ids = [...new Set(appids)];
  if (!ids.length) return new Map<number, ManualQuarantineDecision>();
  const { data, error } = await supabase
    .from("catalog_game_quarantine")
    .select("steam_appid, review_status, reason, matched_rule")
    .in("steam_appid", ids)
    .eq("source", "manual");
  if (error) throw error;
  return new Map(
    ((data ?? []) as ManualQuarantineDecision[]).map((decision) => [Number(decision.steam_appid), decision])
  );
}

function classificationFromManualDecision(decision: ManualQuarantineDecision) {
  if (decision.review_status === "allowed") {
    return { accepted: true, excluded: false, reason: null, matchedRule: "manual:allowed" };
  }
  return {
    accepted: false,
    excluded: true,
    reason: decision.reason || "This AppID was manually excluded from the game catalogue.",
    matchedRule: decision.matched_rule || "manual:excluded"
  };
}

function classifySteamCatalogueEntry(details: Awaited<ReturnType<typeof fetchSteamAppDetails>>) {
  if (!details) {
    return {
      accepted: false,
      excluded: false,
      reason: "Steam metadata was unavailable.",
      matchedRule: "metadata_unavailable"
    };
  }
  // Steam's own classification is the most reliable signal there is, and the
  // shared catalogue physically cannot hold anything else.
  const steamType = String(details.steam_type || "").trim().toLowerCase();
  if (steamType && steamType !== "game") {
    return {
      accepted: false,
      excluded: true,
      reason: `Steam classifies this AppID as ${steamType}, not a game.`,
      matchedRule: `steam_type:${steamType}`
    };
  }

  const normalizedLabels = [...(details.genres ?? []), ...(details.categories ?? [])]
    .map((label) => String(label).trim().toLowerCase());
  const matchedRule = automaticCatalogueExclusionRule(String(details.title || ""), normalizedLabels);
  if (matchedRule) {
    return {
      accepted: false,
      excluded: true,
      reason: automaticExclusionReason(matchedRule),
      matchedRule
    };
  }
  return { accepted: true, excluded: false, reason: null, matchedRule: null };
}

/**
 * Supabase reports failures as plain objects, not Error instances, so the previous
 * `instanceof Error` test threw away the only useful part of a database failure
 * and stored "Unknown catalogue ingestion error" instead.
 *
 * That is why the check-constraint violation above went a month without a
 * diagnosis: the queue faithfully recorded eighty failures and never once said
 * what had actually gone wrong.
 */
function catalogueErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    const parts = [record.message, record.code, record.details, record.hint]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    if (parts.length) return parts.join(" · ").slice(0, 500);
  }
  return "Unknown catalogue ingestion error";
}

function splitLabels(labels?: string | null) {
  return String(labels || "")
    .split(/[\/,|]/)
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

function automaticCatalogueExclusionRule(title: string, normalizedLabels: string[]) {
  const blockedGenre = normalizedLabels.find((label) => AUTOMATIC_EXCLUSION_LABELS.has(label));
  if (blockedGenre) return `steam_label:${blockedGenre}`;
  return AUTOMATIC_RELEASE_CHANNEL_RULES.find((rule) => rule.pattern.test(title))?.matchedRule ?? null;
}

function automaticExclusionReason(matchedRule: string) {
  if (matchedRule.startsWith("steam_label:")) {
    return `Steam classified this AppID as ${matchedRule.slice("steam_label:".length)}, not a game.`;
  }
  return "The Steam title identifies this AppID as a beta, PTR, playtest, or other test environment.";
}

function uniqueNumericAppIds(appIds: Array<string | number>) {
  return [...new Set(appIds.map(Number).filter((appid) => Number.isSafeInteger(appid) && appid > 0))];
}
function normalizeName(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(Math.floor(Number(value) || min), max)); }
