import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase";

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

export async function enforceAuthenticatedWriteRate(userId: string) {
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
