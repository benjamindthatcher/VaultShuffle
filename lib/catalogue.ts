import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamAppDetails } from "@/lib/steam";
import type { GamePayload } from "@/lib/types";

const AUTOMATIC_EXCLUSION_LABELS = new Set(["software", "utilities"]);
const AUTOMATIC_RELEASE_CHANNEL_RULES = [
  { matchedRule: "release_channel:playtest", pattern: /\bplaytest\b/i },
  { matchedRule: "release_channel:public_test", pattern: /\bpublic[\s-]+test\b/i },
  { matchedRule: "release_channel:test_environment", pattern: /\btest[\s-]+(?:realm|server)\b/i },
  { matchedRule: "release_channel:ptr", pattern: /\bptr\b/i },
  { matchedRule: "release_channel:pts", pattern: /\bpts\b/i },
  { matchedRule: "release_channel:beta", pattern: /\bbeta\b/i }
] as const;
type CatalogueQueueRow = { steam_appid: number; attempts: number };
type ManualQuarantineDecision = {
  steam_appid: number;
  review_status: "allowed" | "excluded";
  reason: string | null;
  matched_rule: string | null;
};

export async function quarantinedSteamImports(games: GamePayload[]) {
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

  const appids = uniqueNumericAppIds(games.flatMap((game) => game.steam_appid ? [game.steam_appid] : []));
  if (!appids.length) return new Map<string, string>();
  const { data, error } = await supabase
    .from("catalog_game_quarantine")
    .select("steam_appid, reason")
    .in("steam_appid", appids)
    .eq("review_status", "excluded");
  if (error) throw error;
  return new Map((data ?? []).map((row) => [String(row.steam_appid), String(row.reason)]));
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

export async function processCatalogueQueue(limit = 25, restrictToAppIds?: number[]) {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
  const { error: recoveryError } = await supabase
    .from("catalog_ingest_queue")
    .update({
      status: "pending",
      processing_started_at: null,
      next_attempt_at: now.toISOString(),
      last_error: "Recovered an expired catalogue worker lease.",
      updated_at: now.toISOString()
    })
    .eq("status", "processing")
    .lt("processing_started_at", staleBefore);
  if (recoveryError) throw recoveryError;

  let query = supabase.from("catalog_ingest_queue").select("steam_appid, attempts").eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("priority", { ascending: false }).order("first_requested_at", { ascending: true }).limit(clamp(limit, 1, 100));
  if (restrictToAppIds?.length) query = query.in("steam_appid", restrictToAppIds);
  const { data, error } = await query;
  if (error) throw error;
  const candidates = (data ?? []) as CatalogueQueueRow[];
  if (!candidates.length) return { processed: 0, accepted: 0, rejected: 0 };

  // Claim each item optimistically. Concurrent workers may read the same candidate
  // list, but only one can transition an item from pending to processing.
  const claims = await Promise.all(candidates.map(async (row) => {
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("catalog_ingest_queue")
      .update({ status: "processing", processing_started_at: claimedAt, updated_at: claimedAt })
      .eq("steam_appid", row.steam_appid)
      .eq("status", "pending")
      .select("steam_appid, attempts")
      .maybeSingle();
    if (claimError) throw claimError;
    return claimed as CatalogueQueueRow | null;
  }));
  const rows = claims.filter((row): row is CatalogueQueueRow => Boolean(row));
  const manualDecisions = await loadManualQuarantineDecisions(
    supabase,
    rows.map((row) => row.steam_appid)
  );

  let accepted = 0;
  let rejected = 0;
  for (const row of rows) {
    const appid = String(row.steam_appid);
    try {
      const details = await fetchSteamAppDetails(appid);
      if (!details?.title) throw new Error("Steam metadata did not include a title.");

      // Preserve the complete shared Steam record before deciding whether it
      // belongs on user-facing game surfaces. Quarantine controls visibility;
      // it must not discard metadata that may be useful for review later.
      await persistSteamCatalogueDetails(row.steam_appid, details);

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
      const attempts = Number(row.attempts || 0) + 1;
      const terminal = attempts >= 5;
      const { error: failureUpdateError } = await supabase.from("catalog_ingest_queue").update({ status: terminal ? "failed" : "pending", attempts,
        next_attempt_at: terminal ? null : new Date(Date.now() + Math.min(2 ** attempts * 60_000, 6 * 60 * 60_000)).toISOString(),
        processing_started_at: null, last_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown catalogue ingestion error",
        updated_at: new Date().toISOString() }).eq("steam_appid", row.steam_appid);
      if (failureUpdateError) throw failureUpdateError;
    }
  }
  return { processed: rows.length, accepted, rejected };
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
    capsule_url: details.capsule_url || null,
    header_url: details.header_url || null,
    review_positive: reviewPositive,
    review_negative: Math.max(0, reviewTotal - reviewPositive),
    review_total: reviewTotal,
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

function uniqueNumericAppIds(appIds: string[]) {
  return [...new Set(appIds.map(Number).filter((appid) => Number.isSafeInteger(appid) && appid > 0))];
}
function normalizeName(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(Math.floor(Number(value) || min), max)); }
