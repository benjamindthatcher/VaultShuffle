"use client";

import { captureProductEvent } from "./posthog-client";

/** Status and Playing Next outcomes are emitted once by AppDataProvider.
 * This event measures discovery and recovery without recording search or notes. */
export function trackLibraryInteraction(
  action: "details_opened" | "replacement_opened" | "undo" | "selection_toggled",
  properties: Record<string, unknown>,
) {
  captureProductEvent("library_interaction", { ...properties, app_area: "library", action });
}
