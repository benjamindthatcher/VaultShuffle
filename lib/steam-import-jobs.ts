import crypto from "node:crypto";
import { recordImportedSteamAppIds } from "@/lib/catalogue";
import { recordSteamVisibility, upsertSteamGames } from "@/lib/games";
import { promoteFamilyGamesToOwned } from "@/lib/family-games";
import { capturePlaytimeSnapshot } from "@/lib/playtime-snapshots";
import {
  IDLE_STEAM_IMPORT,
  steamImportBatch,
  steamImportPercent,
  type SteamImportProgress
} from "@/lib/steam-import-progress";
import { steamPlayHistoryMissing, steamVisibilityFromGames } from "@/lib/steam-owned-games";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { GamePayload } from "@/lib/types";

type SteamImportJobRow = {
  user_id: string;
  status: "importing" | "complete" | "failed";
  total_games: number;
  imported_games: number;
  games: GamePayload[];
  play_history_missing: boolean;
  last_error: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  processing_token: string | null;
  processing_started_at: string | null;
};

export type SteamImportBatchResult = {
  progress: SteamImportProgress;
  retryAfterSeconds?: number;
};

export async function getSteamImportProgress(userId: string): Promise<SteamImportProgress> {
  const { data, error } = await getSupabaseAdmin()
    .from("steam_import_jobs")
    .select("user_id, status, total_games, imported_games, play_history_missing, last_error, started_at, completed_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? progressFromJob(data as SteamImportJobRow) : IDLE_STEAM_IMPORT;
}

export async function stageSteamImport(userId: string, games: GamePayload[]) {
  const now = new Date().toISOString();
  const playHistoryMissing = steamPlayHistoryMissing(games);
  const { data, error } = await getSupabaseAdmin()
    .from("steam_import_jobs")
    .upsert({
      user_id: userId,
      status: "importing",
      total_games: games.length,
      imported_games: 0,
      games,
      play_history_missing: playHistoryMissing,
      last_error: null,
      started_at: now,
      updated_at: now,
      completed_at: null,
      processing_token: null,
      processing_started_at: null
    }, { onConflict: "user_id" })
    .select("user_id, status, total_games, imported_games, play_history_missing, last_error, started_at, completed_at")
    .single();
  if (error) throw error;

  await recordSteamVisibility(userId, steamVisibilityFromGames(games)).catch(() => undefined);
  return progressFromJob(data as SteamImportJobRow);
}

export async function processNextSteamImportBatch(userId: string): Promise<SteamImportBatchResult> {
  const currentJob = await loadSteamImportJob(userId);
  if (!currentJob) throw new Error("No Steam import is ready to resume.");
  if (currentJob.status === "complete") return { progress: progressFromJob(currentJob) };

  const processingToken = crypto.randomUUID();
  const job = await claimSteamImportJob(userId, processingToken);
  if (!job) {
    return {
      progress: await getSteamImportProgress(userId),
      retryAfterSeconds: 2
    };
  }

  const games = Array.isArray(job.games) ? job.games : [];
  if (!games.length || games.length !== job.total_games) {
    throw await failSteamImport(
      userId,
      processingToken,
      "The saved Steam import could not be resumed. Start a fresh refresh.",
      job.imported_games
    );
  }

  const batch = steamImportBatch(games, job.imported_games);
  if (!batch.length) {
    return { progress: await finishSteamImport(userId, processingToken, job, games) };
  }

  try {
    const appIds = batch.flatMap((game) => game.steam_appid ? [String(game.steam_appid)] : []);
    await recordImportedSteamAppIds(userId, appIds).catch(() => ({ queued: 0 }));
    await upsertSteamGames(userId, batch);
    // Buying a game you already had through the family upgrades the row in
    // place, so its notes, collections, pins and completion history survive the
    // purchase rather than being orphaned beside a new one.
    await promoteFamilyGamesToOwned(userId, appIds);

    const nextImported = Math.min(job.total_games, job.imported_games + batch.length);
    if (nextImported >= job.total_games) {
      return {
        progress: await finishSteamImport(
          userId,
          processingToken,
          { ...job, imported_games: nextImported },
          games
        )
      };
    }

    const { data, error } = await getSupabaseAdmin()
      .from("steam_import_jobs")
      .update({
        status: "importing",
        imported_games: nextImported,
        last_error: null,
        updated_at: new Date().toISOString(),
        processing_token: null,
        processing_started_at: null
      })
      .eq("user_id", userId)
      .eq("imported_games", job.imported_games)
      .eq("processing_token", processingToken)
      .select("user_id, status, total_games, imported_games, play_history_missing, last_error, started_at, completed_at")
      .maybeSingle();
    if (error) throw error;
    return {
      progress: data ? progressFromJob(data as SteamImportJobRow) : await getSteamImportProgress(userId)
    };
  } catch (error) {
    const message = describeImportError(error);
    await failSteamImport(userId, processingToken, message, job.imported_games);
    throw error;
  }
}

async function finishSteamImport(
  userId: string,
  processingToken: string,
  job: SteamImportJobRow,
  games: GamePayload[]
) {
  await reconcileSteamOwnership(userId, games);
  await capturePlaytimeSnapshot(userId);

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("steam_import_jobs")
    .update({
      status: "complete",
      imported_games: job.total_games,
      games: [],
      last_error: null,
      updated_at: now,
      completed_at: now,
      processing_token: null,
      processing_started_at: null
    })
    .eq("user_id", userId)
    .eq("processing_token", processingToken)
    .select("user_id, status, total_games, imported_games, play_history_missing, last_error, started_at, completed_at")
    .single();
  if (error) throw error;
  return progressFromJob(data as SteamImportJobRow);
}

/**
 * Steam is authoritative for ownership. Rows that disappeared from its latest
 * complete response are retained as Wishlist rows so notes and completion history
 * are not destroyed, but they immediately leave every owned-library read model.
 *
 * Only OWNED rows. Family games are reachable through somebody else's library
 * and are never in GetOwnedGames, so an unguarded sweep here would retire every
 * one of them on the next refresh - see lib/family-sharing.ts. Their own
 * lifecycle is handled by the family import, which is the only thing that knows
 * whether access still exists.
 */
async function reconcileSteamOwnership(userId: string, games: GamePayload[]) {
  const currentAppIds = new Set(games.flatMap((game) => game.steam_appid ? [String(game.steam_appid)] : []));
  const supabase = getSupabaseAdmin();
  const ownedRows: Array<{ id: string; catalog_steam_appid: number | string }> = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("user_games")
      .select("id, catalog_steam_appid")
      .eq("user_id", userId)
      .eq("ownership", "Owned")
      .eq("access_source", "owned")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as typeof ownedRows;
    ownedRows.push(...page);
    if (page.length < pageSize) break;
  }

  const staleIds = ownedRows.flatMap((row) =>
    currentAppIds.has(String(row.catalog_steam_appid)) ? [] : [String(row.id)]
  );
  for (let index = 0; index < staleIds.length; index += 200) {
    const { error: updateError } = await supabase
      .from("user_games")
      .update({ ownership: "Wishlist", updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("id", staleIds.slice(index, index + 200));
    if (updateError) throw updateError;
  }
}

async function loadSteamImportJob(userId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("steam_import_jobs")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as SteamImportJobRow | null;
}

async function claimSteamImportJob(userId: string, processingToken: string) {
  const { data, error } = await getSupabaseAdmin()
    .rpc("claim_steam_import_job", {
      p_user_id: userId,
      p_processing_token: processingToken,
      p_lease_seconds: 120
    })
    .maybeSingle();
  if (error) throw error;
  return data as SteamImportJobRow | null;
}

async function failSteamImport(
  userId: string,
  processingToken: string,
  message: string,
  importedGames: number
) {
  const { error } = await getSupabaseAdmin()
    .from("steam_import_jobs")
    .update({
      status: "failed",
      last_error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
      processing_token: null,
      processing_started_at: null
    })
    .eq("user_id", userId)
    .eq("imported_games", importedGames)
    .eq("processing_token", processingToken)
    .neq("status", "complete");
  if (error) console.error("Could not save Steam import failure state", error);
  return new Error(message);
}

function progressFromJob(job: SteamImportJobRow): SteamImportProgress {
  const status = job.status;
  const imported = Math.max(0, Number(job.imported_games || 0));
  const total = Math.max(0, Number(job.total_games || 0));
  return {
    status,
    imported,
    total,
    percent: steamImportPercent(status, imported, total),
    playHistoryMissing: Boolean(job.play_history_missing),
    lastError: job.last_error || null,
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null
  };
}

function describeImportError(error: unknown) {
  return error instanceof Error ? error.message : "The Steam import stopped before this batch was saved.";
}
