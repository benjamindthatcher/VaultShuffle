export const COOLDOWN_EVENT = "vault:cooldown";

export type CooldownNotice = {
  message: string;
  retryAfterSeconds: number;
};

type RateLimitPayload = {
  error?: unknown;
  code?: unknown;
  retry_after_seconds?: unknown;
};

export function readCooldown(response: Response, payload: RateLimitPayload): CooldownNotice | null {
  if (response.status !== 429 && payload.code !== "rate_limited") return null;

  const headerSeconds = Number(response.headers.get("Retry-After"));
  const payloadSeconds = Number(payload.retry_after_seconds);
  const retryAfterSeconds = Number.isFinite(payloadSeconds) && payloadSeconds > 0
    ? Math.ceil(payloadSeconds)
    : Number.isFinite(headerSeconds) && headerSeconds > 0
      ? Math.ceil(headerSeconds)
      : 60;

  return {
    message: typeof payload.error === "string" && payload.error.trim()
      ? payload.error
      : "That action is cooling down to protect VaultShuffle.",
    retryAfterSeconds: Math.min(24 * 60 * 60, retryAfterSeconds)
  };
}

/**
 * Thrown instead of a plain Error so callers can tell "wait a bit" apart from
 * "this broke". The Steam import used to collapse the two, so being refused for
 * four more minutes was reported as a paused import with a Retry button that
 * could not succeed - people pressed it until they gave up.
 */
export class CooldownError extends Error {
  readonly code: "rate_limited" | "steam_rate_limited";
  // Declared and assigned rather than a constructor parameter property: this
  // module is loaded by the test runner under --experimental-strip-types, which
  // cannot compile those.
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message: string, code?: string) {
    super(message);
    this.name = "CooldownError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = code === "steam_rate_limited" ? code : "rate_limited";
  }
}

/**
 * Steam accepted the sign-in but will not share the library, because the
 * account's game details are not public. Seventeen of the first fifty-five
 * accounts were in exactly this state and were told "unauthorized" instead.
 */
export class SteamLibraryPrivateError extends Error {
  readonly code = "steam_library_private";

  constructor(message: string) {
    super(message);
    this.name = "SteamLibraryPrivateError";
  }
}

export function announceCooldown(response: Response, payload: RateLimitPayload) {
  const notice = readCooldown(response, payload);
  if (!notice || typeof window === "undefined") return notice;
  window.dispatchEvent(new CustomEvent<CooldownNotice>(COOLDOWN_EVENT, { detail: notice }));
  return notice;
}
