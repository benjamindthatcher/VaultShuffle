import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { AppUser } from "@/lib/types";

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

  if (error || !data) return null;

  const appUser = Array.isArray(data.app_users) ? data.app_users[0] : data.app_users;
  if (!appUser) return null;

  return {
    sessionId: data.id as string,
    user: appUser as AppUser
  };
}

export async function requireSession() {
  const session = await getCurrentSession();
  if (!session) {
    throw new Error("Steam sign-in is required.");
  }
  return session;
}

export async function createSessionForSteamId(steamId: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  const { data: user, error: userError } = await supabase
    .from("app_users")
    .upsert(
      {
        steam_id: steamId,
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
    path: "/",
    maxAge: 0
  });
  return response;
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: "Steam sign-in is required." }, { status: 401 });
}
