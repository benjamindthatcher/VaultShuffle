// Product analytics are loaded lazily by lib/posthog-client.ts only after the
// visitor explicitly opts in. Keeping this instrumentation entrypoint empty
// prevents the PostHog SDK and replay extensions from entering the critical
// first-load path for visitors who have not granted consent.
export {};
