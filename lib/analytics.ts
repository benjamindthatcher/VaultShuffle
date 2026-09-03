"use client";

import { captureProductEvent, registerAnalyticsContext, type CaptureOptions } from "@/lib/posthog-client";

/**
 * Every product event VaultShuffle sends, grouped by the surface it belongs to.
 *
 * Three rules keep this list readable in PostHog, and small enough to afford:
 *
 *  1. Anything that is a step in a funnel gets its own event name. Outcomes buried
 *     in a property cannot be charted without writing HogQL by hand, which is how
 *     `opened_on_steam` stayed invisible inside `vault_draw_action` for a month.
 *  2. Anything that is a dimension of an event stays a property. Mood, session and
 *     goal describe a draw; they are not separate kinds of draw.
 *  3. An event has to change a decision. This list grew to 67 names and roughly
 *     110,000 events a month, most of them describing clicks nobody ever charted
 *     - filter toggles, preview banners, fifteen separate steps of one form. What
 *     is left is the acquisition funnel, the Vault loop, the completion loop, and
 *     the handful of failures worth being paged about. Anything that only
 *     describes where somebody clicked is answered by $pageview and a property.
 *
 * A bulk action is ONE event carrying a count, never one event per game. That
 * fan-out was a third of all remaining volume and it made per-user rates
 * meaningless: one person could produce eight hundred events in a month.
 */
export const ANALYTICS_EVENTS = {
  // Acquisition and activation. The funnel that acquisition work actually moves:
  // landing -> chosen path -> library imported -> first draw -> launched.
  landingChoiceMade: "landing_choice_made",
  signInStarted: "sign_in_started",
  steamLibrarySynced: "steam_library_synced",
  steamImportFailed: "steam_import_failed",
  // The alternate activation path, and the one failure on it worth watching:
  // roughly a third of profile lookups do not find a usable library.
  manualProfileCreated: "manual_profile_created",
  manualProfileLookupFailed: "manual_profile_lookup_failed",

  // The Vault loop. vault_pick_launched is the north-star metric: it is the point
  // at which VaultShuffle has actually solved the user's decision problem.
  vaultDrawRequested: "vault_draw_requested",
  vaultDrawFailed: "vault_draw_failed",
  vaultPickLaunched: "vault_pick_launched",

  // Completion. The loop the whole product exists to close.
  completionClaimed: "completion_claimed",
  completionDismissed: "completion_dismissed",

  // Library and collections.
  gameStatusChanged: "game_status_changed",
  collectionCreated: "collection_created",
  collectionMembershipChanged: "collection_membership_changed",

  // Steam Families. Experimental and flag-gated, so these exist to answer one
  // question before it ships: does anybody actually add a family member.
  familyMemberAdded: "family_member_added",
  familyMemberRemoved: "family_member_removed",

  // Site conversions. Rare enough to cost nothing, direct enough to act on.
  feedbackSubmitted: "feedback_submitted",
  contactSubmitted: "contact_submitted",
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

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
