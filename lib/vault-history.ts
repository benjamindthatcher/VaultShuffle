import type { VaultGoalId, VaultMoodId, VaultSessionId } from "@/lib/demo-data";

export type VaultDrawEventType = "opened_on_steam" | "pinned" | "unpinned" | "drew_again" | "hidden_for_session" | "snoozed_7_days" | "snoozed_30_days" | "slept" | "marked_completed" | "restored";

export type VaultDrawEvent = { id: string; drawId: string; eventType: VaultDrawEventType; createdAt: string };
export type VaultDraw = {
  id: string;
  steamAppId: number;
  drawnAt: string;
  session: VaultSessionId;
  mood: VaultMoodId;
  goal: VaultGoalId;
  collectionId: string | null;
  selectedGenres: string[];
  eligiblePoolCount: number;
  rerollIndex: number;
  events: VaultDrawEvent[];
};

export type VaultDrawInput = Omit<VaultDraw, "id" | "drawnAt" | "events">;
