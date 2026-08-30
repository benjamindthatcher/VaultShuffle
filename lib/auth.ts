import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { enforceAuthenticatedWriteRate } from "@/lib/rate-limit";
import type { AppUser, SteamPlayerSummary } from "@/lib/types";
import { asManualProfileSecurityError } from "@/lib/manual-profile-security";

export const SESSION_COOKIE = "vault_session";
const SESSION_DAYS = 30;
const MANUAL_SESSION_DAYS = 365;
const MANUAL_TOKEN_PREFIX = "manual.";
const PROFILE_SECURITY_INTENT_MINUTES = 10;

function describeSupabaseError(error: unknown, fallback: string) {
  if (!error) return fallback;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const details = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    return [details.message, details.details, details.hint, details.code]
      .filter(Boolean)
      .map(String)
      .join(" | ") || fallback;
  }
  return String(error);
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: SESSION_SECRET");
  }
  return secret;
}

function hashToken(token: string) {
  return crypto
    .createHmac("sha256", sessionSecret())
    .update(token)
    .digest("hex");
}

/**
 * The session could not be checked, which is different from there being none.
 * Callers must not turn this into a 401: the person is signed in, we just could
 * not confirm it this time.
 */
export class SessionLookupError extends Error {
  readonly code = "session_lookup_failed";

  constructor(detail: string) {
    super("VaultShuffle could not verify your session just now. Please try again in a moment.");
    this.name = "SessionLookupError";
    console.error(JSON.stringify({ level: "error", message: "Session lookup failed", detail }));
  }
}

export async function getCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  return token.startsWith(MANUAL_TOKEN_PREFIX)
    ? getManualProfileSession(token)
    : getVerifiedSteamSession(token);
}

async function getVerifiedSteamSession(token: string) {
  const tokenHash = hashToken(token);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, user_id, expires_at, app_users ( id, steam_id, display_name, avatar_url )")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  // A failed lookup is not a signed-out user. This returned null for both, so a
  // transient database error - a pool under load, a cold connection - was
  // reported to the browser as 401 unauthorized while someone was signed in and
  // halfway through their first import. Every affected user in the logs hit this
  // during a Steam import that then completed perfectly.
  if (error) throw new SessionLookupError(error.message);
  if (!data) return null;

  const appUser = Array.isArray(data.app_users) ? data.app_users[0] : data.app_users;
  if (!appUser) return null;

  return {
    sessionId: data.id as string,
    user: { ...(appUser as Omit<AppUser, "account_type">), account_type: "steam" as const }
  };
}

async function getManualProfileSession(token: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("manual_profile_sessions")
    .select("id, profile_id, last_seen_at, expires_at, manual_steam_profiles ( id, steam_id, display_name, steam_display_name, avatar_url )")
    .eq("token_hash", hashToken(token))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw new SessionLookupError(error.message);
  if (!data) return null;

  const manualProfile = Array.isArray(data.manual_steam_profiles)
    ? data.manual_steam_profiles[0]
    : data.manual_steam_profiles;
  if (!manualProfile) return null;

  // A lightweight backend return signal for the separate manual-profile
  // cohort. At most one write per session per hour, rather than turning every
  // API call on a product page into a database update.
  const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (!data.last_seen_at || data.last_seen_at < staleBefore) {
    const refreshedExpiry = new Date(Date.now() + MANUAL_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: seenError } = await supabase
      .from("manual_profile_sessions")
      .update({ last_seen_at: new Date().toISOString(), expires_at: refreshedExpiry })
      .eq("id", data.id)
      .lt("last_seen_at", staleBefore);
    if (seenError) {
      console.warn(JSON.stringify({
        level: "warning",
        message: "Could not update manual-profile last seen time",
        session_id: data.id,
        detail: seenError.message,
      }));
    }
  }

  return {
    sessionId: data.id as string,
    user: {
      ...(manualProfile as Omit<AppUser, "account_type">),
      account_type: "manual" as const,
    },
  };
}

/**
 * There is no session, so the caller must sign in. A class rather than a
 * message, because the message was how routes used to decide: any error whose
 * text contained "sign-in" became a 401.
 *
 * SteamLibraryUnavailableError used to open "Steam sign-in worked, but..." - so
 * an account with non-public game details was answered with a bare unauthorized
 * and the instructions for fixing it were thrown away. Seventeen of fifty-five
 * accounts had no library and no import job; the ones who tried again for hours
 * were told the wrong thing every time. The wording has changed since, but the
 * type is what makes it impossible for any message to matter again.
 */
export class SessionRequiredError extends Error {
  readonly code = "session_required";

  constructor() {
    super("A VaultShuffle profile is required.");
    this.name = "SessionRequiredError";
  }
}

export async function requireSession() {
  const session = await getCurrentSession();
  if (!session) {
    throw new SessionRequiredError();
  }
  return session;
}

export async function requireWriteSession() {
  const session = await requireSession();
  await enforceAuthenticatedWriteRate(session.user.id);
  return session;
}

export async function createSessionForSteamId(steamId: string, profile?: SteamPlayerSummary | null) {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = crypto.randomBytes(32).toString("base64url");

  const { data: user, error: userError } = await supabase
    .rpc("create_verified_steam_session", {
      p_steam_id: steamId,
      p_display_name: profile?.display_name ?? null,
      p_avatar_url: profile?.avatar_url ?? null,
      p_token_hash: hashToken(token),
      p_expires_at: expiresAt.toISOString(),
    })
    .select("id, steam_id, display_name, avatar_url")
    .single();

  if (userError || !user) {
    throw new Error(describeSupabaseError(userError, "Could not create Steam user."));
  }

  return {
    token,
    user: { ...(user as Omit<AppUser, "account_type">), account_type: "steam" as const } satisfies AppUser,
  };
}

export async function createManualProfileSecurityIntent(input: {
  accountId: string;
  manualSessionId: string;
}) {
  const supabase = getSupabaseAdmin();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PROFILE_SECURITY_INTENT_MINUTES * 60 * 1000);
  const { error } = await supabase.rpc("create_manual_profile_security_intent", {
    p_source_account_id: input.accountId,
    p_source_manual_session_id: input.manualSessionId,
    p_token_hash: hashToken(token),
    p_expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw asManualProfileSecurityError(error, "link_intent_invalid");
  }
  return { token, expiresAt };
}

export async function completeManualProfileSecurity(input: {
  intentToken: string;
  manualSessionId: string;
  verifiedSteamId: string;
  profile?: SteamPlayerSummary | null;
  openIdResponseNonce: string;
}) {
  const supabase = getSupabaseAdmin();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .rpc("complete_manual_profile_security", {
      p_intent_token_hash: hashToken(input.intentToken),
      p_manual_session_id: input.manualSessionId,
      p_verified_steam_id: input.verifiedSteamId,
      p_steam_display_name: input.profile?.display_name ?? null,
      p_avatar_url: input.profile?.avatar_url ?? null,
      p_new_session_token_hash: hashToken(token),
      p_new_session_expires_at: expiresAt.toISOString(),
      p_openid_response_nonce: input.openIdResponseNonce,
    })
    .single();

  if (error || !data) {
    throw asManualProfileSecurityError(error, "link_merge_failed");
  }

  const result = data as {
    account_id: unknown;
    merge_mode: unknown;
    merged_from_account_id: unknown;
  };
  const mergeMode = String(result.merge_mode);
  if (mergeMode !== "promoted" && mergeMode !== "merged_existing") {
    throw asManualProfileSecurityError(null, "link_merge_failed");
  }

  return {
    token,
    accountId: String(result.account_id),
    sourceAccountId: String(result.merged_from_account_id),
    mergeMode,
  } as const;
}

export async function createManualProfileSession(input: {
  steamId: string;
  profileUrl: string;
  displayName: string;
  steamDisplayName: string;
  avatarUrl: string | null;
}) {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MANUAL_SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = `${MANUAL_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const { data, error } = await supabase
    .rpc("create_manual_profile_session", {
      p_steam_id: input.steamId,
      p_profile_url: input.profileUrl,
      p_display_name: input.displayName,
      p_steam_display_name: input.steamDisplayName,
      p_avatar_url: input.avatarUrl,
      p_token_hash: hashToken(token),
      p_expires_at: expiresAt.toISOString(),
    })
    .single();

  if (error || !data) {
    throw new Error(describeSupabaseError(error, "Could not create the VaultShuffle profile."));
  }

  const row = data as {
    id: unknown;
    steam_id: unknown;
    display_name?: unknown;
    avatar_url?: unknown;
  };
  const user = {
    id: String(row.id),
    steam_id: String(row.steam_id),
    display_name: row.display_name ? String(row.display_name) : null,
    steam_display_name: input.steamDisplayName,
    avatar_url: row.avatar_url ? String(row.avatar_url) : null,
    account_type: "manual" as const,
  } satisfies AppUser;
  return { token, user };
}

export async function updateSteamUserProfile(
  userId: string,
  accountType: AppUser["account_type"],
  profile: SteamPlayerSummary,
) {
  const supabase = getSupabaseAdmin();
  if (accountType === "manual") {
    const { data, error } = await supabase
      .from("manual_steam_profiles")
      .update({
        ...(profile.display_name ? { steam_display_name: profile.display_name } : {}),
        ...(profile.avatar_url ? { avatar_url: profile.avatar_url } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select("id, steam_id, display_name, steam_display_name, avatar_url")
      .single();
    if (error) throw new Error(describeSupabaseError(error, "Could not update Steam profile."));
    return { ...(data as Omit<AppUser, "account_type">), account_type: accountType };
  }

  const { data, error } = await supabase
    .from("app_users")
    .update({
      ...(profile.display_name ? { display_name: profile.display_name } : {}),
      ...(profile.avatar_url ? { avatar_url: profile.avatar_url } : {}),
      updated_at: new Date().toISOString()
    })
    .eq("id", userId)
    .select("id, steam_id, display_name, avatar_url")
    .single();

  if (error) throw new Error(describeSupabaseError(error, "Could not update Steam profile."));
  return { ...(data as Omit<AppUser, "account_type">), account_type: accountType };
}

export async function deleteCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return;

  const supabase = getSupabaseAdmin();
  await supabase
    .from(token.startsWith(MANUAL_TOKEN_PREFIX) ? "manual_profile_sessions" : "sessions")
    .delete()
    .eq("token_hash", hashToken(token));
}

export function attachSessionCookie(response: NextResponse, token: string) {
  const maxAgeDays = token.startsWith(MANUAL_TOKEN_PREFIX) ? MANUAL_SESSION_DAYS : SESSION_DAYS;
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    priority: "high",
    path: "/",
    maxAge: maxAgeDays * 24 * 60 * 60
  });
  return response;
}

/** Refreshes the browser lifetime of an active manual-profile session. */
export async function refreshCurrentManualSessionCookie(response: NextResponse) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token?.startsWith(MANUAL_TOKEN_PREFIX)) attachSessionCookie(response, token);
  return response;
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    priority: "high",
    path: "/",
    maxAge: 0
  });
  return response;
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: "A VaultShuffle profile is required." }, { status: 401 });
}
