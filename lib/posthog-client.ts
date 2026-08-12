"use client";

const CONSENT_STORAGE_KEY = "vault-cookie-consent";

type PostHogClient = typeof import("posthog-js").default;
type ProductAnalyticsMode = "full" | "cookieless" | "disabled";

let client: PostHogClient | null = null;
let clientPromise: Promise<PostHogClient | null> | null = null;
let configuredMode: ProductAnalyticsMode | null = null;

function productAnalyticsMode(): ProductAnalyticsMode {
  if (typeof window === "undefined") return "disabled";
  try {
    const choice = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (choice === "accepted") return "full";
    if (choice === "cookieless") return "cookieless";
    return "disabled";
  } catch {
    return "disabled";
  }
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
      cookieless_mode: "on_reject",
      opt_out_capturing_by_default: true,
      person_profiles: "identified_only",
      autocapture: true,
      capture_exceptions: true,
      capture_pageview: false,
      capture_pageleave: true,
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
    // PostHog's set_config deliberately ignores undefined values, so clear the
    // optional mode directly before using its standard complete opt-out path.
    const wasCookieless = posthog.config.cookieless_mode === "on_reject";
    posthog.config.cookieless_mode = undefined;
    posthog.stopSessionRecording();
    if (consentStatus !== "denied" || wasCookieless) {
      posthog.reset();
      posthog.opt_out_capturing();
    }
    return;
  }

  const alreadyCookieless = posthog.config.cookieless_mode === "on_reject" && consentStatus === "denied";
  posthog.set_config({ cookieless_mode: "on_reject" });
  if (mode === "full") {
    if (consentStatus !== "granted") posthog.opt_in_capturing();
    posthog.startSessionRecording();
  } else {
    posthog.stopSessionRecording();
    if (!alreadyCookieless) posthog.opt_out_capturing();
  }
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
  await setProductAnalyticsMode("full");
}

export async function enableCookielessProductAnalytics() {
  await setProductAnalyticsMode("cookieless");
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

export function captureProductEvent(event: string, properties?: Record<string, unknown>) {
  const mode = productAnalyticsMode();
  if (mode === "disabled") return;

  const ready = configuredMode === mode && client
    ? Promise.resolve(client)
    : setProductAnalyticsMode(mode);
  void ready.then((posthog) => posthog?.capture(event, properties));
}

export function identifyProductUser(userId: string, properties?: Record<string, unknown>) {
  if (productAnalyticsMode() !== "full") return;

  const ready = configuredMode === "full" && client
    ? Promise.resolve(client)
    : setProductAnalyticsMode("full");
  void ready.then((posthog) => posthog?.identify(userId, properties));
}

export function resetProductAnalytics() {
  if (productAnalyticsMode() === "full") client?.reset();
}
