import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { classifyDurationReviewResponse, type DurationReviewSubmission } from "@/lib/duration-review-input";
import { getSupabaseAdmin } from "@/lib/supabase";

const DURATION_QUEUE_COOKIE = "vault_duration_queue";
const DURATION_QUEUE_COOKIE_SECONDS = 30 * 24 * 60 * 60;

export type DurationReviewGame = {
  steamAppId: number;
  name: string;
  artworkUrl: string;
  durationStatus: string;
  durationKind: string;
  durationSource: string | null;
  usersThatImported: number;
  reviewTotal: number;
};

export type DurationReviewQueueState = {
  game: DurationReviewGame | null;
  total: number;
  reviewed: number;
  remaining: number;
};

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function durationQueueCookieValue() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Missing required environment variable: SESSION_SECRET");
  return crypto.createHmac("sha256", secret).update("vault-duration-queue:v1").digest("base64url");
}

export function verifyDurationQueuePassword(candidate: string) {
  const password = process.env.DURATION_QUEUE_PASSWORD;
  return Boolean(password && safeEqual(candidate, password));
}

export async function hasDurationQueueAccess() {
  const supplied = (await cookies()).get(DURATION_QUEUE_COOKIE)?.value;
  return Boolean(supplied && safeEqual(supplied, durationQueueCookieValue()));
}

export async function grantDurationQueueAccess() {
  (await cookies()).set({
    name: DURATION_QUEUE_COOKIE,
    value: durationQueueCookieValue(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: DURATION_QUEUE_COOKIE_SECONDS,
    priority: "high",
  });
}

function asQueueGame(row: Record<string, unknown>): DurationReviewGame {
  return {
    steamAppId: Number(row.steam_appid),
    name: String(row.name ?? "Untitled Steam game"),
    artworkUrl: String(row.header_url || row.capsule_url || ""),
    durationStatus: String(row.duration_status ?? "unknown"),
    durationKind: String(row.duration_kind ?? "unknown"),
    durationSource: row.duration_source ? String(row.duration_source) : null,
    usersThatImported: Number(row.users_that_imported ?? 0),
    reviewTotal: Number(row.review_total ?? 0),
  };
}

export async function getDurationReviewQueueState(): Promise<DurationReviewQueueState> {
  const supabase = getSupabaseAdmin();
  const baseColumns = "steam_appid,name,header_url,capsule_url,duration_status,duration_kind,duration_source,users_that_imported,review_total";
  const [totalResult, remainingResult, gameResult] = await Promise.all([
    supabase.from("catalog_duration_review_queue").select("steam_appid", { count: "exact", head: true }),
    supabase.from("catalog_duration_review_queue").select("steam_appid", { count: "exact", head: true }).is("reviewed_at", null),
    supabase
      .from("catalog_duration_review_queue")
      .select(baseColumns)
      .is("reviewed_at", null)
      .order("users_that_imported", { ascending: false, nullsFirst: false })
      .order("review_total", { ascending: false, nullsFirst: false })
      .order("steam_appid", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const error = totalResult.error || remainingResult.error || gameResult.error;
  if (error) throw new Error("Could not load the duration review queue.", { cause: error });

  const total = totalResult.count ?? 0;
  const remaining = remainingResult.count ?? 0;
  return {
    game: gameResult.data ? asQueueGame(gameResult.data as Record<string, unknown>) : null,
    total,
    reviewed: Math.max(0, total - remaining),
    remaining,
  };
}

export async function saveDurationReview(
  submission: DurationReviewSubmission,
) {
  const supabase = getSupabaseAdmin();
  const classified = classifyDurationReviewResponse(submission.response);
  const { data: unresolvedGame, error: lookupError } = await supabase
    .from("catalog_duration_review_queue")
    .select("steam_appid")
    .eq("steam_appid", submission.steamAppId)
    .is("reviewed_at", null)
    .maybeSingle();

  if (lookupError) throw new Error("Could not verify this duration review.", { cause: lookupError });
  if (!unresolvedGame) throw new Error("This game is no longer waiting for a duration review.");

  const { error } = await supabase.from("catalog_duration_reviews").upsert({
    steam_appid: submission.steamAppId,
    response_text: classified.responseText,
    response_kind: classified.responseKind,
    source_url: classified.sourceUrl,
    reviewer_user_id: null,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "steam_appid" });

  if (error) throw new Error("Could not save this duration review.", { cause: error });
}
