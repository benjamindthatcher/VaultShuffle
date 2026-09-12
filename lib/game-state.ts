import type { DemoGame } from "@/lib/demo-data";

export type GamePatch = Readonly<{
  status?: DemoGame["status"];
  completionPercent?: number;
  hoursPlayed?: number;
  notes?: string;
  priority?: DemoGame["priority"];
  completedAt?: string | null;
  completionSuggestionDismissedAt?: string | null;
  completionSuggestionDismissedPlaytime?: number | null;
}>;

/** Pure optimistic state update shared by the app provider and its runtime tests. */
export function applyGamePatch(
  game: DemoGame,
  patch: GamePatch,
  emptyNotesDescription = game.description
): DemoGame {
  const status = patch.status ?? game.status;
  return {
    ...game,
    status,
    completionPercent: status === "Completed"
      ? Math.min(100, patch.completionPercent ?? game.completionPercent)
      : Math.min(99, patch.completionPercent ?? game.completionPercent),
    hoursPlayed: patch.hoursPlayed ?? game.hoursPlayed,
    priority: patch.priority ?? game.priority,
    notes: patch.notes ?? game.notes,
    description: patch.notes === undefined
      ? game.description
      : patch.notes.trim() || emptyNotesDescription,
    completedAt: patch.completedAt !== undefined
      ? patch.completedAt
      : status === "Completed" ? new Date().toISOString() : patch.status ? null : game.completedAt,
    previousActiveStatus: (status === "Completed" || status === "Blacklisted") && game.status !== "Completed" && game.status !== "Blacklisted"
      ? (game.previousActiveStatus ?? (game.status === "In Progress" ? "In Progress" : "Not Started"))
      : game.previousActiveStatus,
    completionSuggestionDismissedAt: patch.completionSuggestionDismissedAt ?? game.completionSuggestionDismissedAt,
    completionSuggestionDismissedPlaytime: patch.completionSuggestionDismissedPlaytime ?? game.completionSuggestionDismissedPlaytime
  };
}

/** The client-side mirror of idempotent manual Reactivate. */
export function restoreActiveGame(game: DemoGame): DemoGame {
  return {
    ...game,
    status: game.previousActiveStatus ?? (game.hoursPlayed > 0 ? "In Progress" : "Not Started"),
    completedAt: null,
    previousActiveStatus: null
  };
}
