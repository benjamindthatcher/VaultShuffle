export const MANUAL_PROFILE_SECURITY_ERROR_CODES = [
  "steam_sign_in_cancelled",
  "link_session_missing",
  "link_intent_invalid",
  "link_session_mismatch",
  "link_intent_consumed",
  "link_intent_expired",
  "steam_identity_unverified",
  "steam_account_mismatch",
  "link_merge_failed",
  "link_merge_conflict",
] as const;

export type ManualProfileSecurityErrorCode =
  (typeof MANUAL_PROFILE_SECURITY_ERROR_CODES)[number];

export const MANUAL_PROFILE_SECURITY_COOKIE = "vault_profile_security";

const DATABASE_ERROR_CODES = new Map<string, ManualProfileSecurityErrorCode>(
  MANUAL_PROFILE_SECURITY_ERROR_CODES.map((code) => [code.toUpperCase(), code]),
);

function errorDetail(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error) {
    const details = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    return [details.message, details.details, details.hint, details.code]
      .filter(Boolean)
      .map(String)
      .join(" | ");
  }
  return typeof error === "string" ? error : "";
}

/**
 * Supabase wraps Postgres exceptions in plain objects and may put the useful
 * marker in `message`, `details`, or `hint`. Keep the browser-facing contract
 * stable without exposing database text.
 */
export function manualProfileSecurityCodeFromError(
  error: unknown,
): ManualProfileSecurityErrorCode | null {
  const detail = errorDetail(error).toUpperCase();
  for (const [databaseCode, publicCode] of DATABASE_ERROR_CODES) {
    if (detail.includes(databaseCode)) return publicCode;
  }
  return null;
}

export class ManualProfileSecurityError extends Error {
  readonly code: ManualProfileSecurityErrorCode;

  constructor(code: ManualProfileSecurityErrorCode, options?: ErrorOptions) {
    super("VaultShuffle could not secure this profile. Nothing was changed.", options);
    this.name = "ManualProfileSecurityError";
    this.code = code;
  }
}

export function asManualProfileSecurityError(
  error: unknown,
  fallback: ManualProfileSecurityErrorCode,
) {
  if (error instanceof ManualProfileSecurityError) return error;
  return new ManualProfileSecurityError(
    manualProfileSecurityCodeFromError(error) ?? fallback,
    { cause: error },
  );
}
