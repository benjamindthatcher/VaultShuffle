"use client";

const CONSENT_STORAGE_KEY = "vault-cookie-consent";

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
      api_host: "/ingest",
      ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST?.replace(".i.posthog.com", ".posthog.com"),
      defaults: "2026-01-30",
      persistence: "localStorage+cookie",
      opt_out_capturing_by_default: false,
      person_profiles: "identified_only",
      autocapture: true,
      capture_exceptions: true,
      capture_performance: {
        network_timing: true,
        web_vitals: true,
      },
      capture_pageview: false,
      capture_pageleave: true,
      capture_heatmaps: true,
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: true,
      },
      enable_recording_console_log: true,
      disable_surveys: false,
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

  // Explicitly override PostHog replay sampling / trigger gates: if analytics
  // are enabled, VaultShuffle records the session by default.
  posthog.startSessionRecording(true);
}

async function setProductAnalyticsMode(mode: ProductAnalyticsMode) {
  if (configuredMode === mode && client) return mode === "disabled" ? null : client;
  configuredMode = mode;

  if (mode === "disabled" && !client && !clientPromise) return null;
  const posthog = await loadClient();
  if (!posthog) return null;

  applyProductAnalyticsMode(posthog, configuredMode);
  return configuredMode === "disabled" ? null : posthog;
}

export async function enableProductAnalytics() {
  await setProductAnalyticsMode("enabled");
}

export function disableProductAnalytics() {
  configuredMode = "disabled";
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
  void ready.then((posthog) => posthog?.capture(event, properties, options));
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
