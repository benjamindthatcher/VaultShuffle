"use client";

import type { SessionPayload } from "./types";

/**
 * Lets the analytics identity sync reuse the session the app shell has already
 * fetched, instead of asking for it a second time.
 *
 * Both /api/session and /api/app-data answer with the same getSessionPayload(),
 * so on a product page the session was being fetched twice per boot - once by
 * AppDataProvider for the app, once by SiteFrame to identify the PostHog user.
 * Each of those is a proxy invocation and a function invocation, and on an
 * authed request getSessionPayload() reads the database.
 *
 * On a marketing page there is no app shell, so nothing announces itself and
 * SiteFrame fetches exactly as it always did.
 */

let providerMounted = false;
let latest: SessionPayload | null = null;
const waiters = new Set<(session: SessionPayload | null) => void>();

/**
 * Called by the app shell as it mounts, before it knows the session, so that
 * SiteFrame can tell one is coming and wait rather than fetch.
 *
 * React runs a child's effects before its parent's, and SiteFrame's identity
 * effect is gated behind a state update from an earlier effect, so the shell
 * has always announced itself by the time that runs.
 */
export function announceSessionProvider() {
  providerMounted = true;
  return () => {
    providerMounted = false;
    latest = null;
  };
}

export function hasSessionProvider() {
  return providerMounted;
}

export function publishSession(session: SessionPayload) {
  latest = session;
  for (const waiter of waiters) waiter(session);
  waiters.clear();
}

/**
 * The bootstrap gave up, so no session is coming from it. Releases anyone
 * waiting straight away rather than making them sit out the timeout, which
 * would delay identifying a signed-in person for no reason.
 */
export function abandonSession() {
  for (const waiter of waiters) waiter(null);
  waiters.clear();
}

/**
 * Resolves with the shell's session, or null if it does not arrive in time -
 * a failed bootstrap must leave analytics identifying off its own request
 * rather than waiting forever for a session that is never coming.
 */
export function awaitSession(timeoutMs = 5000): Promise<SessionPayload | null> {
  if (latest) return Promise.resolve(latest);
  return new Promise((resolve) => {
    const waiter = (session: SessionPayload | null) => {
      clearTimeout(timer);
      resolve(session);
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      resolve(null);
    }, timeoutMs);
    waiters.add(waiter);
  });
}
