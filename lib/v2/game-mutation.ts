/** Existing per-game bookkeeping version, used only while an Undo is offered. */
export type GameMutationReceipt = Readonly<{ mutationVersion: string }>;
export type RestoreDecision = Readonly<{
  status: "Completed" | "Blacklisted" | "In Progress" | "Not Started";
  completedAt: string | null;
  expectedVersion: string;
}>;
