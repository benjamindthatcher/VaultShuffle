import { createHmac } from "node:crypto";
import type { DatabaseClient, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";

const MANUAL_PREFIX = "manual.";

export const VAULT_SESSION_COOKIE_NAME = "vault_session";
export const MANUAL_SESSION_TOKEN_PREFIX = MANUAL_PREFIX;

export type ResolvedSession = Readonly<{
  principal: VerifiedServerPrincipal;
  expiresAt: string;
}>;

type ResolverRow = Readonly<{
  session_id: string | number;
  account_id: string | number;
  account_public_id: string;
  account_kind: string;
  session_kind: string;
  identity_verified: boolean;
  expires_at: string | Date;
}>;

/**
 * Resolves only the database-backed principal for a `vault_session` cookie.
 * No HTTP request data can supply an account principal; it is constructed only
 * from the narrow SECURITY DEFINER resolver's output.
 */
export class SessionRepository {
  private readonly database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.database = database;
  }

  async resolveCookie(cookieValue: string, sessionSecret: string): Promise<ResolvedSession | null> {
    if (typeof cookieValue !== "string" || cookieValue.length === 0 || typeof sessionSecret !== "string" || sessionSecret.length === 0) {
      throw new DatabaseUnavailableError();
    }

    const sessionKind = cookieValue.startsWith(MANUAL_PREFIX) ? "manual" : "verified_steam";
    const digest = createHmac("sha256", sessionSecret).update(cookieValue).digest();
    let rows: readonly ResolverRow[];
    try {
      rows = await this.database.sql<ResolverRow[]>`
        select session_id, account_id, account_public_id, account_kind,
               session_kind, identity_verified, expires_at
          from app.resolve_session(${digest}, ${sessionKind})
      `;
    } catch {
      throw new DatabaseUnavailableError();
    }
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new DatabaseUnavailableError();

    const resolved = parseResolverRow(rows[0], sessionKind);
    if (resolved === null) throw new DatabaseUnavailableError();
    if (sessionKind !== "manual") return resolved;

    const renewedExpiry = await this.touchManualSession(resolved.principal, digest);
    return renewedExpiry === null ? resolved : Object.freeze({ ...resolved, expiresAt: renewedExpiry });
  }

  private async touchManualSession(principal: VerifiedServerPrincipal, digest: Buffer): Promise<string | null> {
    try {
      return await this.database.withPrincipal(principal, async (tx) => {
        const rows = await tx<{ expires_at: string | Date }[]>`
          select expires_at
            from app.touch_manual_session(${digest}, ${principal.sessionId})
        `;
        if (rows.length !== 1) return null;
        const expiry = rows[0]?.expires_at instanceof Date ? rows[0].expires_at.toISOString() : rows[0]?.expires_at;
        return typeof expiry === "string" && !Number.isNaN(Date.parse(expiry)) ? expiry : null;
      });
    } catch {
      // A successful resolver result remains valid when an optional sliding
      // last-seen write cannot be completed.
      return null;
    }
  }
}

function parseResolverRow(row: ResolverRow, expectedKind: "manual" | "verified_steam"): ResolvedSession | null {
  const accountId = integer(row.account_id);
  const sessionId = bigint(row.session_id);
  const accountKind = row.account_kind === "manual" || row.account_kind === "steam" ? row.account_kind : null;
  const sessionKind = row.session_kind === "manual" || row.session_kind === "verified_steam" ? row.session_kind : null;
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
  if (accountId === null || sessionId === null || accountKind === null || sessionKind === null
    || typeof row.identity_verified !== "boolean" || typeof expiresAt !== "string"
    || Number.isNaN(Date.parse(expiresAt))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.account_public_id)
    || sessionKind !== expectedKind) return null;

  const identityInvariant = (sessionKind === "manual" && accountKind === "manual" && !row.identity_verified)
    || (sessionKind === "verified_steam" && accountKind === "steam" && row.identity_verified);
  if (!identityInvariant) return null;

  return Object.freeze({
    principal: Object.freeze({
      accountId,
      accountPublicId: row.account_public_id,
      accountKind,
      sessionId,
      sessionKind,
      identityVerified: row.identity_verified,
    }),
    expiresAt,
  });
}

function integer(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function bigint(value: string | number): string | null {
  const text = String(value);
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}
