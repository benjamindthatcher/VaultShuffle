import { registeredSecretValues } from "./secret.ts";

/**
 * Every string this package writes to a terminal, a log file, a run state file
 * or a manifest passes through `redact` first.
 *
 * The rules below are ordered from most specific to least. They are deliberately
 * conservative in one direction only: it is acceptable to mask something that
 * was not a secret, and it is not acceptable to emit something that was.
 */

const MAX_REDACTED_LENGTH = 2000;

/**
 * `postgresql://user:password@host/db` and any other URI userinfo.
 *
 * The userinfo class is greedy and excludes only whitespace and `/`, so it
 * consumes up to the *last* `@` in the authority. A password containing an
 * unencoded `@` would otherwise have its tail printed as if it were the host.
 */
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/]+)@/gi;

/**
 * `password=...`, `PGPASSWORD=...`, `sslpassword = '...'`, `token: "..."`.
 *
 * The `Bearer`/`Basic` alternative has to come before the bare `\S+` one:
 * without it `Authorization: Bearer <token>` consumes only the word `Bearer`
 * as the value and prints the token that follows it.
 */
const KEYED_SECRET =
  /\b(pass(?:word)?|pwd|pgpassword|sslpassword|secret|token|apikey|api_key|authorization|bearer|service_role|anon_key)\b\s*[:=]\s*("[^"]*"|'[^']*'|(?:Bearer|Basic)\s+\S+|\S+)/gi;

/**
 * 32 or more hex characters. This is what a session digest looks like:
 * `hashToken` produces a 64-character HMAC-SHA-256 hex string, and
 * `manual_profile_sessions.token_hash` is `char(64)` of the same shape.
 *
 * Export file digests are also hex, so `redact` is applied to *messages*, never
 * to manifest digest fields, which are assembled from typed values instead.
 */
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;

/** JWT-shaped values (Supabase publishable/secret keys and access tokens). */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

/** Supabase-issued key prefixes. */
const SUPABASE_KEY = /\bsb(?:p|_secret|_publishable)_[A-Za-z0-9_-]{8,}\b/g;

/**
 * Email addresses are user records, not credentials, and are equally banned.
 *
 * The local part is restricted to the characters an address actually uses. A
 * permissive `[^\s<>@]+` also matches the `scheme://[redacted]` that the URI
 * rule leaves behind one line above, so a whole DSN collapsed to
 * `[redacted-email]` and the operator lost the host they needed to diagnose the
 * failure. Over-masking is safe but it is not free.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : String(input);

  for (const secret of registeredSecretValues()) {
    if (text.includes(secret)) {
      text = text.split(secret).join("[redacted]");
    }
  }

  text = text
    .replace(URI_CREDENTIALS, (_match, scheme: string) => `${scheme}[redacted]@`)
    .replace(KEYED_SECRET, (_match, key: string) => `${key}=[redacted]`)
    .replace(JWT, "[redacted]")
    .replace(SUPABASE_KEY, "[redacted]")
    .replace(LONG_HEX, "[redacted-hex]")
    .replace(EMAIL, "[redacted-email]");

  if (text.length > MAX_REDACTED_LENGTH) {
    text = `${text.slice(0, MAX_REDACTED_LENGTH)}… [truncated]`;
  }
  return text;
}

/**
 * A failure that is already safe to print.
 *
 * `code` is a stable machine-readable reason so the coordinator can act on a
 * failure class without anyone having to widen what the message may contain.
 */
export class ExportError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: string,
    message: string,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(redact(message));
    this.name = "ExportError";
    this.code = code;
    const safeDetails: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(details)) {
      safeDetails[key] = typeof value === "string" ? redact(value) : value;
    }
    this.details = Object.freeze(safeDetails);
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Turn anything thrown into a printable one-line reason.
 *
 * A raw `Error` from the network stack or the filesystem can carry a path or a
 * connection string, so even those go through `redact`. Stacks are dropped: they
 * add file paths and no diagnostic value the code and message do not already
 * carry.
 */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ExportError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const nodeCode = (error as NodeJS.ErrnoException).code;
    return {
      code: typeof nodeCode === "string" ? `node.${nodeCode}` : "unexpected_error",
      message: redact(error.message),
    };
  }
  return { code: "unexpected_error", message: redact(error) };
}
