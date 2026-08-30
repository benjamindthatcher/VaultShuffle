import assert from "node:assert/strict";
import test from "node:test";
import {
  asManualProfileSecurityError,
  manualProfileSecurityCodeFromError,
} from "./manual-profile-security.ts";

test("maps security RPC errors from every Supabase detail field", () => {
  assert.equal(
    manualProfileSecurityCodeFromError({ message: "P0001: LINK_INTENT_EXPIRED" }),
    "link_intent_expired",
  );
  assert.equal(
    manualProfileSecurityCodeFromError({ details: "STEAM_ACCOUNT_MISMATCH" }),
    "steam_account_mismatch",
  );
  assert.equal(
    manualProfileSecurityCodeFromError({ hint: "LINK_SESSION_MISSING" }),
    "link_session_missing",
  );
});

test("does not leak an unknown database error into the public code", () => {
  assert.equal(manualProfileSecurityCodeFromError({ message: "connection refused" }), null);
  assert.equal(
    asManualProfileSecurityError({ message: "connection refused" }, "link_merge_failed").code,
    "link_merge_failed",
  );
});

test("keeps the most specific marker when Supabase combines fields", () => {
  assert.equal(
    manualProfileSecurityCodeFromError({
      message: "Database request failed",
      details: "STEAM_IDENTITY_UNVERIFIED",
      code: "P0001",
    }),
    "steam_identity_unverified",
  );
});
