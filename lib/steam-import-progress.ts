export const STEAM_IMPORT_BATCH_SIZE = 75;

export type SteamImportStatus = "idle" | "fetching" | "importing" | "complete" | "failed";

export type SteamImportProgress = {
  status: SteamImportStatus;
  imported: number;
  total: number;
  percent: number;
  playHistoryMissing: boolean;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export const IDLE_STEAM_IMPORT: SteamImportProgress = {
  status: "idle",
  imported: 0,
  total: 0,
  percent: 0,
  playHistoryMissing: false,
  lastError: null,
  startedAt: null,
  completedAt: null
};

export function steamImportPercent(status: SteamImportStatus, imported: number, total: number) {
  if (status === "complete") return 100;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(99, Math.round((imported / total) * 100)));
}

export function steamImportBatch<T>(items: T[], imported: number, batchSize = STEAM_IMPORT_BATCH_SIZE) {
  const start = Math.max(0, Math.min(items.length, Math.trunc(imported)));
  const size = Math.max(1, Math.trunc(batchSize));
  return items.slice(start, start + size);
}
