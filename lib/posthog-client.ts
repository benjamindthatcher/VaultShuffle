"use client";

const CONSENT_STORAGE_KEY = "vault-cookie-consent";

type PostHogClient = typeof import("posthog-js").default;
type ProductAnalyticsMode = "cookieless" | "disabled";

let client: PostHogClient | null = null;
let clientPromise: Promise<PostHogClient | null> | null = null;
let configuredMode: ProductAnalyticsMode | null = null;

function productAnalyticsMode(): ProductAnalyticsMode {
  if (typeof window === "undefined") return "disabled";
  try {
    const choice = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return choice === "disabled" || choice === "essential" ? "disabled" : "cookieless";
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
      person_profiles: "never",
      autocapture: true,
      capture_exceptions: false,
      capture_pageview: false,
      capture_pageleave: true,
      capture_heatmaps: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
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
  posthog.stopSessionRecording();
  if (!alreadyCookieless) posthog.opt_out_capturing();
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
