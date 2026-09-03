"use client";

import { DIAGNOSTICS_COOKIE, diagnosticId } from "./diagnostics";

const CONSENT_STORAGE_KEY = "vault-cookie-consent";

/**
 * Normalised so a misconfigured env var cannot send a visitor's events to an
 * arbitrary origin: anything that is not a PostHog ingest host falls back to EU.
 */
function posthogApiHost() {
  const configured = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim().replace(/\/$/, "");
  if (!configured) return "https://eu.i.posthog.com";
  const host = configured.includes(".i.posthog.com")
    ? configured
    : configured.replace(".posthog.com", ".i.posthog.com");
  return /^https:\/\/[a-z0-9-]+\.i\.posthog\.com$/.test(host) ? host : "https://eu.i.posthog.com";
}

const POSTHOG_API_HOST = posthogApiHost();

type PostHogClient = typeof import("posthog-js").default;
type ProductAnalyticsMode = "enabled" | "disabled";

export type ProductUserIdentity = {
  userId: string;
  steamId: string;
  accountType: "steam" | "manual";
  identityVerified: boolean;
  displayName?: string | null;
  steamDisplayName?: string | null;
  avatarUrl?: string | null;
};

let client: PostHogClient | null = null;
let clientPromise: Promise<PostHogClient | null> | null = null;
let configuredMode: ProductAnalyticsMode | null = null;
let pendingIdentity: ProductUserIdentity | null = null;

function productAnalyticsMode(): ProductAnalyticsMode {
  if (typeof window === "undefined") return "disabled";
  try {
    // Analytics are opt-out: they run unless the visitor has turned them off.
    // "essential" is the legacy name for a decline.
    const choice = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return choice === "disabled" || choice === "essential" ? "disabled" : "enabled";
  } catch {
    return "disabled";
  }
}

function applyProductUserIdentity(posthog: PostHogClient, identity: ProductUserIdentity) {
  const properties: Record<string, string | boolean> = {
    vaultshuffle_user_id: identity.userId,
    steam_id: identity.steamId,
    steam_profile_url: `https://steamcommunity.com/profiles/${identity.steamId}`,
    account_type: identity.accountType,
    identity_verified: identity.identityVerified,
  };

  if (identity.displayName) {
    properties.name = identity.displayName;
  }
  if (identity.steamDisplayName) properties.steam_display_name = identity.steamDisplayName;
  if (identity.avatarUrl) properties.steam_avatar_url = identity.avatarUrl;

  posthog.identify(identity.userId, properties);
  syncDiagnosticConsent();
}

/** Only anonymous/account UUIDs and replay IDs, never the app session token. */
function syncDiagnosticConsent() {
  if (typeof document === "undefined") return;
  const permitted = productAnalyticsMode() === "enabled" && configuredMode !== "disabled"
    && navigator.doNotTrack !== "1" && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
    && client && !client.has_opted_out_capturing();
  const value = permitted
    ? `enabled.${diagnosticId(client?.get_distinct_id()) ?? ""}.${diagnosticId(client?.get_session_id()) ?? ""}`
    : "disabled";
  document.cookie = `${DIAGNOSTICS_COOKIE}=${value}; Path=/; SameSite=Lax; Max-Age=86400${location.protocol === "https:" ? "; Secure" : ""}`;
}

export function diagnosticRequestHeaders(operationId?: string): Record<string, string> {
  syncDiagnosticConsent();
  return { "X-Vault-Operation-Id": diagnosticId(operationId) ?? crypto.randomUUID() };
}

async function loadClient() {
  if (client) return client;

  const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!projectToken) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is not configured; product analytics are disabled.");
    }
    return null;
  }

  clientPromise ??= import("posthog-js").then(({ default: posthog }) => {
    posthog.init(projectToken, {
      // Straight to PostHog rather than through our own origin. The reverse
      // proxy existed so ad blockers could not drop analytics, but it put every
      // event batch, flags call and replay chunk through proxy.ts - and Vercel
      // bills Routing Middleware on the same Active CPU meter as functions, so
      // analytics traffic was the largest single source of invocations on the
      // project. Blocked clients are now simply not measured, which is the
      // trade we chose: it costs some coverage, not correctness.
      api_host: POSTHOG_API_HOST,
      ui_host: POSTHOG_API_HOST.replace(".i.posthog.com", ".posthog.com"),
      defaults: "2026-01-30",
      persistence: "localStorage+cookie",
      opt_out_capturing_by_default: false,
      person_profiles: "identified_only",
      // VaultShuffle names every interaction worth measuring as its own event, so
      // autocapture only added an untyped duplicate of them - it was 41% of all
      // events on its own, and dead/rage clicks another 7%, all of it proxied
      // through our own origin. Turning both off also stops $rageclick and
      // $dead_swipe, which are emitted by these same two modules.
      autocapture: false,
      capture_dead_clicks: false,
      capture_exceptions: true,
      // Vercel Speed Insights already measures web vitals, and network_timing
      // only feeds replay - where it was a large share of each recording's bytes
      // without changing what the recording shows. `false` turns off both, and
      // overrides the project's capture_performance_opt_in.
      capture_performance: false,
      capture_pageview: false,
      // Costs scroll depth and bounce rate in Web Analytics. Accepted: neither
      // was being read, and $pageleave was the third-largest remaining event.
      capture_pageleave: false,
      // Enabled in both client and project config and produced zero events in
      // 30 days - the recorder was carrying the listeners for nothing.
      capture_heatmaps: false,
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: true,
        // rrweb samples mouse position every 50ms by default, which on a page
        // people scroll and hover over is most of the event count in a
        // recording. 250ms still draws a legible cursor path.
        sampling: { mousemove: 250 },
        // A full snapshot is a complete re-serialisation of the DOM. Every 5
        // minutes is tuned for playback scrubbing on long sessions; our median
        // recording is under a minute, so it mostly buys a second copy of the
        // page. Ten minutes keeps one for genuinely long sessions.
        full_snapshot_interval_millis: 600_000,
      },
      // Recorded zero console lines across 1,440 recordings.
      enable_recording_console_log: false,
      // No surveys are configured on the project, so this only skipped a request.
      disable_surveys: true,
      // Deliberately left on. `true` would also stop remote config loading, and
      // the session-replay trigger groups arrive that way - disabling flags
      // would silently disarm replay along with the one live experiment.
      advanced_disable_flags: false,
      respect_dnt: true,
      tracing_headers: [window.location.hostname],
      debug: process.env.NODE_ENV === "development",
    });
    client = posthog;
    return posthog;
  }).catch((error) => {
    clientPromise = null;
    if (process.env.NODE_ENV !== "production") console.warn("PostHog could not be loaded.", error);
    return null;
  });

  return clientPromise;
}

function applyProductAnalyticsMode(posthog: PostHogClient, mode: ProductAnalyticsMode) {
  const consentStatus = posthog.get_explicit_consent_status();

  if (mode === "disabled") {
    posthog.stopSessionRecording();
    posthog.reset();
    if (posthog.get_explicit_consent_status() !== "denied") posthog.opt_out_capturing();
    return;
  }

  if (consentStatus === "denied") posthog.opt_in_capturing();
  if (pendingIdentity) applyProductUserIdentity(posthog, pendingIdentity);

  // Re-arms replay after an opt-out, which sets disable_session_recording.
  //
  // Deliberately called with no argument. Passing `true` is shorthand for
  // { sampling: true, linked_flag: true }, which overrides those gates and makes
  // every session record regardless of the trigger groups configured in PostHog.
  // Without the override the recorder buffers and only keeps a session that
  // matches a trigger group, which is what keeps replay affordable at scale.
  posthog.startSessionRecording();
}

async function setProductAnalyticsMode(mode: ProductAnalyticsMode) {
  if (configuredMode === mode && client) return mode === "disabled" ? null : client;
  configuredMode = mode;

  if (mode === "disabled" && !client && !clientPromise) return null;
  const posthog = await loadClient();
  if (!posthog) return null;

  applyProductAnalyticsMode(posthog, configuredMode);
  syncDiagnosticConsent();
  return configuredMode === "disabled" ? null : posthog;
}

export async function enableProductAnalytics() {
  await setProductAnalyticsMode("enabled");
}

export function disableProductAnalytics() {
  configuredMode = "disabled";
  syncDiagnosticConsent();
  if (client) {
    applyProductAnalyticsMode(client, "disabled");
  } else if (clientPromise) {
    void clientPromise.then((posthog) => {
      if (posthog && configuredMode === "disabled") applyProductAnalyticsMode(posthog, "disabled");
    });
  }
}

export function identifyProductUser(identity: ProductUserIdentity) {
  pendingIdentity = identity;
  if (productAnalyticsMode() === "disabled") return;

  const mode: ProductAnalyticsMode = "enabled";
  const ready = configuredMode === mode && client
    ? Promise.resolve(client)
    : setProductAnalyticsMode(mode);

  void ready.then((posthog) => {
    if (posthog && pendingIdentity) applyProductUserIdentity(posthog, pendingIdentity);
  });
}

export function clearProductUserIdentity() {
  pendingIdentity = null;
  if (client && configuredMode === "enabled") client.reset();
  syncDiagnosticConsent();
}

export type CaptureOptions = { transport?: "XHR" | "sendBeacon" };

export function captureProductEvent(
  event: string,
  properties?: Record<string, unknown>,
  options?: CaptureOptions,
) {
  const mode = productAnalyticsMode();
  if (mode === "disabled") return;

  const ready = configuredMode === mode && client
    ? Promise.resolve(client)
    : setProductAnalyticsMode(mode);
  void ready.then((posthog) => { syncDiagnosticConsent(); posthog?.capture(event, properties, options); });
}

// Registered once per session so that every subsequent event can be segmented by
// guest vs signed-in without each call site having to pass it.
export function registerAnalyticsContext(properties: Record<string, unknown>) {
  if (productAnalyticsMode() === "disabled") return;

  const ready = configuredMode === "enabled" && client
    ? Promise.resolve(client)
    : setProductAnalyticsMode("enabled");
  void ready.then((posthog) => posthog?.register(properties));
}

/**
 * Subscribes to a boolean feature flag.
 *
 * Flags resolve asynchronously and only when analytics are switched on, so the
 * callback may fire more than once and will never fire at all for a visitor who
 * opted out. Every caller must therefore treat "off" as the safe default — which
 * is also what makes an opted-out user a clean control rather than a broken test.
 */
export function observeFeatureFlag(flag: string, onChange: (enabled: boolean) => void) {
  if (productAnalyticsMode() === "disabled") return () => {};

  let unsubscribe: (() => void) | null = null;
  let cancelled = false;

  const ready = configuredMode === "enabled" && client
    ? Promise.resolve(client)
    : setProductAnalyticsMode("enabled");

  void ready.then((posthog) => {
    if (!posthog || cancelled) return;
    unsubscribe = posthog.onFeatureFlags(() => onChange(posthog.isFeatureEnabled(flag) === true));
  });

  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}
