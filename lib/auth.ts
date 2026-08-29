import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { enforceAuthenticatedWriteRate } from "@/lib/rate-limit";
import type { AppUser, SteamPlayerSummary } from "@/lib/types";

export const SESSION_COOKIE = "vault_session";
const SESSION_DAYS = 30;

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
    user: appUser as AppUser
  };
}

/**
 * There is no session, so the caller must sign in. A class rather than a
 * message, because the message was how routes used to decide: any error whose
 * text contained "sign-in" became a 401.
 *
 * SteamLibraryUnavailableError says "Steam sign-in worked, but Steam returned no
 * visible games..." - so a private Steam profile was answered with a bare
 * unauthorized, and the instructions for fixing it were thrown away. Seventeen
 * of fifty-five accounts had no library and no import job; the ones who tried
 * again for hours were being told the wrong thing every time.
 */
export class SessionRequiredError extends Error {
  readonly code = "session_required";

  constructor() {
    super("Steam sign-in is required.");
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

  const { data: user, error: userError } = await supabase
    .from("app_users")
    .upsert(
      {
        steam_id: steamId,
        ...(profile?.display_name ? { display_name: profile.display_name } : {}),
        ...(profile?.avatar_url ? { avatar_url: profile.avatar_url } : {}),
        last_login_at: now.toISOString(),
        updated_at: now.toISOString()
      },
      { onConflict: "steam_id" }
    )
    .select("id, steam_id, display_name, avatar_url")
    .single();

  if (userError || !user) {
    throw new Error(describeSupabaseError(userError, "Could not create Steam user."));
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const { error: sessionError } = await supabase.from("sessions").insert({
    user_id: user.id,
    token_hash: hashToken(token),
    expires_at: expiresAt.toISOString()
  });

  if (sessionError) {
    throw new Error(describeSupabaseError(sessionError, "Could not create Steam session."));
  }

  return { token, user: user as AppUser };
}

export async function updateSteamUserProfile(userId: string, profile: SteamPlayerSummary) {
  const supabase = getSupabaseAdmin();
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
  return data as AppUser;
}

export async function deleteCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return;

  const supabase = getSupabaseAdmin();
  await supabase.from("sessions").delete().eq("token_hash", hashToken(token));
}

export function attachSessionCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    priority: "high",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60
  });
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
  return NextResponse.json({ error: "Steam sign-in is required." }, { status: 401 });
}
