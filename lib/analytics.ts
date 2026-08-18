"use client";

import { captureProductEvent, registerAnalyticsContext, type CaptureOptions } from "@/lib/posthog-client";

/**
 * Every product event VaultShuffle sends, grouped by the surface it belongs to.
 *
 * Two rules keep this list readable in PostHog:
 *
 *  1. Anything that is a step in a funnel gets its own event name. Outcomes buried
 *     in a property cannot be charted without writing HogQL by hand, which is how
 *     `opened_on_steam` stayed invisible inside `vault_draw_action` for a month.
 *  2. Anything that is a dimension of an event stays a property. Mood, session and
 *     goal describe a draw; they are not separate kinds of draw.
 */
export const ANALYTICS_EVENTS = {
  // Acquisition and identity
  signInStarted: "sign_in_started",
  signedOut: "user_signed_out",
  steamLibrarySynced: "steam_library_synced",
  steamImportFailed: "steam_import_failed",

  // The Vault loop. vault_pick_launched is the north-star metric: it is the point
  // at which VaultShuffle has actually solved the user's decision problem.
  vaultSetupChanged: "vault_setup_changed",
  vaultDrawRequested: "vault_draw_requested",
  vaultDrawFailed: "vault_draw_failed",
  vaultPickLaunched: "vault_pick_launched",
  vaultPickRerolled: "vault_pick_rerolled",
  vaultPickPinned: "vault_pick_pinned",
  vaultPickUnpinned: "vault_pick_unpinned",
  vaultPickHidden: "vault_pick_hidden",
  vaultPickSnoozed: "vault_pick_snoozed",
  vaultPickSlept: "vault_pick_slept",
  vaultPickCompleted: "vault_pick_completed",
  vaultPickRestored: "vault_pick_restored",
  vaultPickLiked: "vault_pick_liked",
  vaultPickDisliked: "vault_pick_disliked",
  vaultRerollReason: "vault_reroll_reason",
  vaultHistoryOpened: "vault_history_opened",
  vaultHistoryCleared: "vault_history_cleared",

  // Library
  deviceModeChanged: "device_mode_changed",
  librarySearched: "library_searched",
  libraryFiltered: "library_filtered",
  libraryGameOpened: "library_game_opened",

  // Collections
  collectionCreated: "collection_created",
  collectionUpdated: "collection_updated",
  collectionDeleted: "collection_deleted",
  collectionMembershipChanged: "collection_membership_changed",

  // Purge
  purgeDecision: "purge_decision",

  // Game lifecycle outside a draw
  gameStatusChanged: "game_status_changed",

  // Site
  feedbackSubmitted: "feedback_submitted",
  contactSubmitted: "contact_submitted",
  analyticsConsentChosen: "analytics_consent_chosen",
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/** Maps a draw follow-up action to its own first-class event name. */
export const VAULT_DRAW_EVENT_NAMES = {
  opened_on_steam: ANALYTICS_EVENTS.vaultPickLaunched,
  drew_again: ANALYTICS_EVENTS.vaultPickRerolled,
  pinned: ANALYTICS_EVENTS.vaultPickPinned,
  unpinned: ANALYTICS_EVENTS.vaultPickUnpinned,
  hidden_for_session: ANALYTICS_EVENTS.vaultPickHidden,
  snoozed_7_days: ANALYTICS_EVENTS.vaultPickSnoozed,
  snoozed_30_days: ANALYTICS_EVENTS.vaultPickSnoozed,
  slept: ANALYTICS_EVENTS.vaultPickSlept,
  marked_completed: ANALYTICS_EVENTS.vaultPickCompleted,
  restored: ANALYTICS_EVENTS.vaultPickRestored,
  liked: ANALYTICS_EVENTS.vaultPickLiked,
  disliked: ANALYTICS_EVENTS.vaultPickDisliked,
  reroll_too_long: ANALYTICS_EVENTS.vaultRerollReason,
  reroll_wrong_mood: ANALYTICS_EVENTS.vaultRerollReason,
  reroll_played_enough: ANALYTICS_EVENTS.vaultRerollReason,
  reroll_not_interested: ANALYTICS_EVENTS.vaultRerollReason,
  reroll_not_tonight: ANALYTICS_EVENTS.vaultRerollReason,
} as const;

/**
 * Maps a vault state action to its event. "drawn" is deliberately null: the draw
 * itself is already reported as vault_draw_requested and would double count.
 */
export const VAULT_ACTION_EVENT_NAMES = {
  drawn: null,
  pinned: ANALYTICS_EVENTS.vaultPickPinned,
  unpinned: ANALYTICS_EVENTS.vaultPickUnpinned,
  snoozed: ANALYTICS_EVENTS.vaultPickSnoozed,
  unsnoozed: ANALYTICS_EVENTS.vaultPickRestored,
} as const;

const APP_AREAS = ["vault", "library", "purge", "collections"] as const;

function appArea() {
  if (typeof window === "undefined") return "unknown";
  const path = window.location.pathname;
  const match = APP_AREAS.find((area) => path === `/${area}` || path.startsWith(`/${area}/`));
  if (match) return match;
  if (path === "/") return "landing";
  return path.split("/")[1] || "landing";
}

/**
 * Sends a product event with the shared properties every event should carry.
 * Prefer this over calling captureProductEvent directly so that no event ships
 * without an app_area to segment it by.
 */
export function trackEvent(
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
  options?: CaptureOptions,
) {
  captureProductEvent(event, { app_area: appArea(), ...properties }, options);
}

/**
 * Events fired from a link that navigates away (Steam deep links in particular)
 * must use sendBeacon, or the browser cancels the request mid-flight and the
 * event is lost.
 */
export function trackNavigationEvent(event: AnalyticsEvent, properties?: Record<string, unknown>) {
  trackEvent(event, properties, { transport: "sendBeacon" });
}

/** Registers session-wide context so every later event can be segmented by it. */
export function setAnalyticsAudience(isGuest: boolean) {
  registerAnalyticsContext({ is_guest: isGuest });
}
