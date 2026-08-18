import type { VaultGoalId, VaultMoodId, VaultSessionId } from "@/lib/demo-data";

export type VaultRerollReason =
  | "reroll_too_long"
  | "reroll_wrong_mood"
  | "reroll_played_enough"
  | "reroll_not_interested"
  | "reroll_not_tonight";

export type VaultDrawEventType = "opened_on_steam" | "pinned" | "unpinned" | "drew_again" | "hidden_for_session" | "snoozed_7_days" | "snoozed_30_days" | "slept" | "marked_completed" | "restored" | "liked" | "disliked" | VaultRerollReason;

/** Shown after repeated rerolls, which are the app's clearest negative signal. */
export const VAULT_REROLL_REASONS: ReadonlyArray<{ id: VaultRerollReason; label: string }> = [
  { id: "reroll_too_long", label: "Too long" },
  { id: "reroll_wrong_mood", label: "Wrong mood" },
  { id: "reroll_played_enough", label: "Played enough" },
  { id: "reroll_not_interested", label: "Not interested" },
  { id: "reroll_not_tonight", label: "Just not tonight" }
];

export type VaultDrawEvent = { id: string; drawId: string; eventType: VaultDrawEventType; createdAt: string };
export type VaultDraw = {
  id: string;
  steamAppId: number;
  drawnAt: string;
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
  collectionId: string | null;
  selectedGenres: string[];
  eligiblePoolCount: number;
  rerollIndex: number;
  events: VaultDrawEvent[];
};

export type VaultDrawInput = Omit<VaultDraw, "id" | "drawnAt" | "events">;
