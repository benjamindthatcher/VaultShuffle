import { createHmac, randomBytes } from "node:crypto";
import type { AppUser, SteamPlayerSummary } from "../../types.ts";
import type { DatabaseClient, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { SessionRepository } from "./session-core.ts";

type UserRow = { public_id: string; account_kind: "steam" | "manual"; steam_id: string | null; display_name: string | null; steam_display_name: string | null; avatar_url: string | null; playtime_visibility: string | null };
export type SessionUser = Readonly<{ user: AppUser; steamPlaytimeVisible: boolean | null }>;

export class AuthRepository {
  private readonly database: DatabaseClient;
  private readonly sessions: SessionRepository;
  constructor(database: DatabaseClient) { this.database = database; this.sessions = new SessionRepository(database); }

  /** Called only after the existing Steam OpenID verification succeeds. */
  async startVerified(steamId: string, secret: string, profile?: SteamPlayerSummary | null) {
    return this.start(steamId, secret, "verified_steam", profile?.display_name ?? null, profile?.display_name ?? null, profile?.avatar_url ?? null, null);
  }

  async startManual(input: { steamId: string; profileUrl: string; displayName: string; steamDisplayName: string; avatarUrl: string | null }, secret: string) {
    return this.start(input.steamId, secret, "manual", input.displayName, input.steamDisplayName, input.avatarUrl, input.profileUrl);
  }

  private async start(steamId: string, secret: string, kind: "manual" | "verified_steam", displayName: string | null, steamDisplayName: string | null, avatarUrl: string | null, profileUrl: string | null) {
    validSteamId(steamId);
    if (!secret) throw new DatabaseUnavailableError();
    const token = (kind === "manual" ? "manual." : "") + randomBytes(32).toString("base64url");
    const digest = createHmac("sha256", secret).update(token).digest();
    const expiresAt = new Date(Date.now() + (kind === "manual" ? 365 : 30) * 86_400_000).toISOString();
    try {
      const rows = await this.database.sql<{ resumed: boolean }[]>`
        select resumed from app.start_session(${steamId}::bigint,${kind},${digest},${expiresAt}::timestamptz,
          ${displayName},${steamDisplayName},${avatarUrl},${profileUrl})
      `;
      if (rows.length !== 1) throw new DatabaseUnavailableError();
      const resolved = await this.sessions.resolveCookie(token, secret);
      if (!resolved) throw new DatabaseUnavailableError();
      const { user } = await this.readUser(resolved.principal);
      return { token, user, resumed: rows[0].resumed };
    } catch { throw new DatabaseUnavailableError(); }
  }

  async readUser(principal: VerifiedServerPrincipal): Promise<SessionUser> {
    try {
      return await this.database.withPrincipal(principal, async tx => {
        const rows = await tx<UserRow[]>`
          select a.public_id,a.account_kind,a.display_name,sp.steam_id::text,sp.steam_display_name,sp.avatar_url,c.playtime_visibility
          from app.accounts a left join app.steam_profiles sp on sp.account_id=a.id
          left join app.account_capabilities c on c.account_id=a.id
          where a.id=${principal.accountId} and a.lifecycle_status='active'
        `;
        if (rows.length !== 1) throw new DatabaseUnavailableError();
        const row = rows[0];
        return { user: { id: row.public_id, account_type: row.account_kind, steam_id: row.steam_id ?? "",
          display_name: row.display_name, steam_display_name: row.steam_display_name, avatar_url: row.avatar_url },
        steamPlaytimeVisible: row.playtime_visibility === "visible" ? true : row.playtime_visibility === "hidden" ? false : null };
      });
    } catch { throw new DatabaseUnavailableError(); }
  }

  async lookupManual(steamId: string) {
    validSteamId(steamId);
    try {
      const rows = await this.database.sql<{ display_name: string | null; steam_display_name: string | null; avatar_url: string | null }[]>`
        select display_name,steam_display_name,avatar_url from app.lookup_manual_profile(${steamId}::bigint)
      `;
      return rows[0] ? { displayName: rows[0].display_name ?? "", steamDisplayName: rows[0].steam_display_name ?? "", avatarUrl: rows[0].avatar_url } : null;
    } catch { throw new DatabaseUnavailableError(); }
  }

  async revoke(principal: VerifiedServerPrincipal, token: string, secret: string) {
    if (!secret) throw new DatabaseUnavailableError();
    const digest = createHmac("sha256", secret).update(token).digest();
    try { await this.database.withPrincipal(principal, async tx => {
      await tx`select app.revoke_current_session(${principal.sessionId}::bigint,${digest})`;
    }); } catch { throw new DatabaseUnavailableError(); }
  }

  async updateProfile(principal: VerifiedServerPrincipal, profile: SteamPlayerSummary): Promise<AppUser> {
    try { await this.database.withPrincipal(principal, async tx => {
      await tx`select app.update_current_profile(${profile.display_name},${profile.avatar_url})`;
    }); } catch { throw new DatabaseUnavailableError(); }
    return (await this.readUser(principal)).user;
  }

  async recordVisit(principal: VerifiedServerPrincipal) {
    await this.database.withPrincipal(principal, async tx => {
      await tx`update app.accounts set last_seen_at=statement_timestamp() where id=${principal.accountId}
        and (last_seen_at is null or last_seen_at<=statement_timestamp()-interval '1 hour')`;
    });
  }
}

function validSteamId(value: string) {
  if (!/^[0-9]{17}$/.test(value)) throw new DatabaseUnavailableError();
}
