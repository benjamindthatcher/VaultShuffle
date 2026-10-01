import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isV2Authority } from "@/lib/database-authority";
import { getV2Runtime } from "@/lib/v2/runtime";
import { currentV2Session } from "@/lib/v2/current-session";

type RateLimitOptions = {
  bucket: string;
  identity: string;
  limit: number;
  windowSeconds: number;
  message?: string;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
};

export class RateLimitExceededError extends Error {
  readonly code = "rate_limited";

  constructor(
    public readonly retryAfterSeconds: number,
    message = "That action has been used too often. Please wait before trying again."
  ) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

function rateLimitSecret() {
  const secret = process.env.RATE_LIMIT_SECRET || process.env.SESSION_SECRET;
  if (!secret) throw new Error("Missing required environment variable: RATE_LIMIT_SECRET or SESSION_SECRET");
  return secret;
}

function digestIdentity(bucket: string, identity: string) {
  return crypto
    .createHmac("sha256", rateLimitSecret())
    .update(`${bucket}\u001f${identity}`)
    .digest("hex");
}

export async function enforceRateLimit(options: RateLimitOptions) {
  if (isV2Authority()) {
    const runtime = await getV2Runtime();
    const digest = Buffer.from(digestIdentity(options.bucket,options.identity),"hex");
    const rows = await runtime.database.sql<RateLimitResult[]>`
      select allowed,remaining,retry_after_seconds from app.consume_request_limit(${options.bucket},${digest},${options.limit},${options.windowSeconds})
    `;
    const row = rows[0];
    if (!row) throw new Error("The request limit could not be checked.");
    if (!row.allowed) throw new RateLimitExceededError(Math.max(1,row.retry_after_seconds),options.message);
    return { remaining: row.remaining };
  }
  const { data, error } = await getSupabaseAdmin().rpc("consume_api_rate_limit", {
    p_bucket: options.bucket,
    p_key_hash: digestIdentity(options.bucket, options.identity),
    p_limit: options.limit,
    p_window_seconds: options.windowSeconds
  });

  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as RateLimitResult | null;
  if (!row) throw new Error("The request limit could not be checked.");

  if (!row.allowed) {
    const retryAfterSeconds = Math.max(1, Number(row.retry_after_seconds) || 1);
    console.warn(JSON.stringify({
      level: "warning",
      message: "API request rate limited",
      bucket: options.bucket,
      retry_after_seconds: retryAfterSeconds
    }));
    throw new RateLimitExceededError(retryAfterSeconds, options.message);
  }

  return {
    remaining: Math.max(0, Number(row.remaining) || 0)
  };
}

/**
 * Hands back a request counted against a limit when the work it was guarding
 * never happened.
 *
 * The Steam refresh limit is one per five minutes, and it is spent before the
 * call to Steam. So a single failed fetch used to cost someone their only
 * attempt and lock them out for five minutes on their first ever import - the
 * request was counted, and nothing was imported for it.
 *
 * Best effort on purpose: if the refund fails the user waits, which is the
 * behaviour we already had. It must never turn a recoverable error into a
 * different one.
 */
export async function releaseRateLimit(options: Pick<RateLimitOptions, "bucket" | "identity">) {
  try {
    if (isV2Authority()) {
      const digest = Buffer.from(digestIdentity(options.bucket,options.identity),"hex");
      await (await getV2Runtime()).database.sql`select app.refund_request_limit(${options.bucket},${digest})`;
      return;
    }
    const keyHash = digestIdentity(options.bucket, options.identity);
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("api_rate_limits")
      .select("request_count")
      .eq("bucket", options.bucket)
      .eq("key_hash", keyHash)
      .maybeSingle();

    const count = Number(data?.request_count) || 0;
    if (count <= 0) return;

    // request_count carries a `> 0` check constraint, so the last one out
    // deletes the row rather than decrementing to zero.
    if (count === 1) {
      await supabase.from("api_rate_limits").delete().eq("bucket", options.bucket).eq("key_hash", keyHash);
      return;
    }
    await supabase
      .from("api_rate_limits")
      .update({ request_count: count - 1 })
      .eq("bucket", options.bucket)
      .eq("key_hash", keyHash);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warning",
      message: "Could not release a rate limit reservation",
      bucket: options.bucket,
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

export async function enforceAuthenticatedWriteRate(userId: string) {
  if (isV2Authority()) {
    const session = await currentV2Session();
    if (!session || session.user.id!==userId) throw new Error("A current account is required.");
    const digest = Buffer.from(digestIdentity("authenticated_write",`user:${userId}`),"hex");
    const rows = await (await getV2Runtime()).database.withPrincipal(session.principal, tx =>
      tx<RateLimitResult[]>`select allowed,remaining,retry_after_seconds from app.consume_request_limit('authenticated_write',${digest},120,60)`);
    if (!rows[0]) throw new Error("The request limit could not be checked.");
    if (!rows[0].allowed) throw new RateLimitExceededError(Math.max(1,rows[0].retry_after_seconds),"Your account is making changes too quickly. Please wait a moment before trying again.");
    return { remaining: rows[0].remaining };
  }
  return enforceRateLimit({
    bucket: "authenticated_write",
    identity: `user:${userId}`,
    limit: 120,
    windowSeconds: 60,
    message: "Your account is making changes too quickly. Please wait a moment before trying again."
  });
}

export function requestFingerprint(request: Request) {
  const source = request.headers.get("x-vercel-forwarded-for")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "local";
  return digestIdentity("request_ip", source);
}
