import posthog from "posthog-js";

const consent = readAnalyticsConsent();

if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is configured"
    );
  }
} else {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, {
    api_host: "/ingest",
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST?.replace(".i.posthog.com", ".posthog.com"),
    defaults: "2026-01-30",
    capture_exceptions: true,
    autocapture: consent === "accepted",
    capture_pageview: consent === "accepted",
    capture_pageleave: consent === "accepted",
    tracing_headers: [window.location.hostname],
    debug: process.env.NODE_ENV === "development",
  });

  if (consent !== "accepted") posthog.stopSessionRecording();
}

function readAnalyticsConsent() {
  try {
    return window.localStorage.getItem("vault-cookie-consent");
  } catch {
    return null;
  }
}
