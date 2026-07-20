export type DurationLookupStatus = "matched" | "not_found" | "no_duration" | "ambiguous" | "needs_review" | "provider_error";
export type DurationConfidence = "high" | "medium" | "low" | "none";

export type GameDurationResult = {
  steamAppId: number;
  provider: "igdb";
  providerGameId: number | null;
  mainStoryMinutes: number | null;
  mainExtraMinutes: number | null;
  completionistMinutes: number | null;
  submissionCount: number | null;
  providerUpdatedAt: string | null;
  status: DurationLookupStatus;
  confidence: DurationConfidence;
};

export interface GameDurationProvider {
  findBySteamAppId(steamAppId: number): Promise<GameDurationResult>;
}

export function secondsToMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value / 60) : null;
}

