import type { DemoGame, VaultSessionId, VaultMoodId, VaultGoalId } from "../demo-data.ts";
import type { GlobalFilters } from "../global-filters.ts";
import type { VaultDraw } from "../vault-history.ts";
import type { VaultEligibilityStage, VaultPoolEntry, VaultMatchExplanation } from "../vault.ts";

export type VaultSetup = {
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
  collectionId: string | null;
  genres: string[];
  globalFilters: GlobalFilters;
  deferredIds: string[];
};
export type VaultDrawRequest = VaultSetup & {
  requestKey: string;
  quick: boolean;
  arm: "test" | "control";
  previousId: string | null;
  cycleIds: string[];
  excludeIds: string[];
};
/** Whole-pool totals and at most 64 preview cards, never the whole Library. */
export type VaultPreview = {
  deck: VaultPoolEntry[];
  poolTotal: number;
  quickTotal: number;
  stages: VaultEligibilityStage[];
  collectionCounts: Record<string, number>;
  preferenceRowCount: number;
};
export type VaultDrawResult = {
  game: DemoGame;
  draw: VaultDraw;
  explanation: VaultMatchExplanation | null;
  reasons: string[];
  collectionName: string | null;
  arm: "test" | "control";
  cycleReset: boolean;
  deckSize: number;
  activeSnoozedIds: string[];
};
