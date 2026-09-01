import assert from "node:assert/strict";
import { test } from "node:test";
import {
  abandonSession,
  announceSessionProvider,
  awaitSession,
  hasSessionProvider,
  publishSession
} from "./analytics-session.ts";
import type { SessionPayload } from "./types.ts";

const session: SessionPayload = {
  logged_in: true,
  account_type: "steam",
  identity_verified: true,
  user_id: "user-1",
  steam_id: "7656119",
  display_name: "Someone",
  steam_display_name: "Someone",
  avatar_url: "",
  has_steam_key: true
};

test("no shell mounted means the caller fetches for itself", () => {
  assert.equal(hasSessionProvider(), false);
});

test("a mounted shell is announced before it knows the session", () => {
  const unmount = announceSessionProvider();
  assert.equal(hasSessionProvider(), true);
  unmount();
  assert.equal(hasSessionProvider(), false);
});

test("a waiter is released by the session the shell publishes", async () => {
  const unmount = announceSessionProvider();
  const pending = awaitSession(1000);
  publishSession(session);
  assert.equal((await pending)?.user_id, "user-1");
  unmount();
});

test("a session that already arrived resolves without waiting", async () => {
  const unmount = announceSessionProvider();
  publishSession(session);
  assert.equal((await awaitSession(1000))?.user_id, "user-1");
  unmount();
});

test("a failed bootstrap releases waiters immediately rather than on the timeout", async () => {
  const unmount = announceSessionProvider();
  // A timeout far beyond the test's own patience: if abandonSession did not
  // release the waiter, this would hang rather than resolve null.
  const pending = awaitSession(60_000);
  abandonSession();
  assert.equal(await pending, null);
  unmount();
});

test("unmounting clears the session so the next page does not read a stale one", async () => {
  const unmount = announceSessionProvider();
  publishSession(session);
  unmount();
  assert.equal(hasSessionProvider(), false);

  const secondUnmount = announceSessionProvider();
  const pending = awaitSession(50);
  assert.equal(await pending, null, "expected no carry-over from the previous mount");
  secondUnmount();
});
