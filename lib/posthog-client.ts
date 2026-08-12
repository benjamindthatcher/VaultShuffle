"use client";

const CONSENT_STORAGE_KEY = "vault-cookie-consent";

type PostHogClient = typeof import("posthog-js").default;

let client: PostHogClient | null = null;
let clientPromise: Promise<PostHogClient | null> | null = null;

function analyticsAllowed() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY) === "accepted";
  } catch {
    return false;
  }
}

async function loadClient() {
  if (!analyticsAllowed()) return null;
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

export async function enableProductAnalytics() {
  const posthog = await loadClient();
  if (!posthog) return;
  posthog.opt_in_capturing();
  posthog.startSessionRecording();
}

export function disableProductAnalytics() {
  if (!client) return;
  client.stopSessionRecording();
  client.opt_out_capturing();
}

export function captureProductEvent(event: string, properties?: Record<string, unknown>) {
  if (!analyticsAllowed()) return;
  void loadClient().then((posthog) => posthog?.capture(event, properties));
}

export function identifyProductUser(userId: string, properties?: Record<string, unknown>) {
  if (!analyticsAllowed()) return;
  void loadClient().then((posthog) => posthog?.identify(userId, properties));
}

export function resetProductAnalytics() {
  client?.reset();
}
