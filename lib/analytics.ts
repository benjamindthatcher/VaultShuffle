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
  // Acquisition and identity.
  //
  // The landing page had no product tracking at all, so the funnel began at the
  // point someone was already inside the app: landing -> guest or Steam ->
  // import -> first draw -> launched was missing its first two steps, which are
  // the ones acquisition work actually moves.
  landingViewed: "landing_viewed",
  landingChoiceMade: "landing_choice_made",
  // The landing page's interactive demo - the only thing on the page someone can
  // actually do before choosing a path, and so the clearest read on whether the
  // page is doing any work. Which control was touched is a dimension of the one
  // event rather than six event names.
  landingDemoUsed: "landing_demo_used",
  signInStarted: "sign_in_started",
  manualProfileSetupStarted: "manual_profile_setup_started",
  manualProfileSetupViewed: "manual_profile_setup_viewed",
  manualProfileLookupStarted: "manual_profile_lookup_started",
  manualProfileLookupSucceeded: "manual_profile_lookup_succeeded",
  manualProfileLookupFailed: "manual_profile_lookup_failed",
  manualProfileCreationStarted: "manual_profile_creation_started",
  manualProfileCreated: "manual_profile_created",
  manualProfileCreationFailed: "manual_profile_creation_failed",
  manualProfileDashboardReached: "manual_profile_dashboard_reached",
  manualProfileAccessNoticeShown: "manual_profile_access_notice_shown",
  manualProfileAccessNoticeAcknowledged: "manual_profile_access_notice_acknowledged",
  manualProfileSecurityLinkClicked: "manual_profile_security_link_clicked",
  manualProfileSecurityViewed: "manual_profile_security_viewed",
  manualProfileSecurityStarted: "manual_profile_security_started",
  manualProfileSecurityErrorViewed: "manual_profile_security_error_viewed",
  manualProfileSecurityCompleted: "manual_profile_security_completed",
  // The step between a finished first import and a first draw, which is where a
  // new account either becomes a user or does not.
  onboardingHandoffTaken: "onboarding_handoff_taken",
  signedOut: "user_signed_out",
  steamLibrarySynced: "steam_library_synced",
  steamImportFailed: "steam_import_failed",
  pinnedPlaytimeRefreshStarted: "pinned_playtime_refresh_started",
  pinnedPlaytimeRefreshSucceeded: "pinned_playtime_refresh_succeeded",
  pinnedPlaytimeRefreshFailed: "pinned_playtime_refresh_failed",

  // Guest previews use the same first-class product events as signed-in use so
  // the funnels remain comparable. These events describe the preview-specific
  // surfaces around that activity without duplicating every click.
  guestPreviewViewed: "guest_preview_viewed",
  guestPreviewAction: "guest_preview_action",
  guestSignInNudgeShown: "guest_sign_in_nudge_shown",
  guestSignInNudgeDismissed: "guest_sign_in_nudge_dismissed",
  // A guest meeting something the preview genuinely cannot do. This is the point
  // where a preview either converts or loses someone, and it was the one part of
  // the guest journey with no event at all - we could see them arrive, draw and
  // leave, but not what they reached for and could not have.
  guestFeatureLocked: "guest_feature_locked",

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
  gameSteamOpened: "game_steam_opened",

  // Collections
  collectionCreated: "collection_created",
  collectionUpdated: "collection_updated",
  collectionDeleted: "collection_deleted",
  collectionMembershipChanged: "collection_membership_changed",

  // Completion. The loop the whole product exists to close, so it gets its own
  // funnel rather than hiding inside game_status_changed with no source on it.
  completionSweepViewed: "completion_sweep_viewed",
  completionClaimed: "completion_claimed",
  completionDismissed: "completion_dismissed",
  completionUndone: "completion_undone",

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
export function setAnalyticsAudience(accountType: "guest" | "steam" | "manual") {
  const isGuest = accountType === "guest";
  registerAnalyticsContext({
    is_guest: isGuest,
    data_scope: isGuest ? "guest_session" : "steam_library",
    account_type: accountType,
    identity_verified: accountType === "steam",
  });
}
