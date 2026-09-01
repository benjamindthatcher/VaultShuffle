import { NextResponse } from "next/server";
import { z } from "zod";
import { grantDurationQueueAccess, verifyDurationQueuePassword } from "@/lib/duration-review";
import { enforceRateLimit, RateLimitExceededError, requestFingerprint } from "@/lib/rate-limit";

const passwordSchema = z.object({ password: z.string().min(1).max(128) });

function privateResponse(body: unknown, status = 200, retryAfter?: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
    },
  });
}

export async function POST(request: Request) {
  try {
    await enforceRateLimit({
      bucket: "duration_queue_password",
      identity: requestFingerprint(request),
      limit: 5,
      windowSeconds: 15 * 60,
      message: "Too many password attempts. Wait a little while and try again.",
    });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return privateResponse({ error: error.message }, 429, error.retryAfterSeconds);
    }
    return privateResponse({ error: "The password could not be checked just now." }, 503);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return privateResponse({ error: "That password could not be read." }, 400);
  }

  const parsed = passwordSchema.safeParse(payload);
  if (!parsed.success || !verifyDurationQueuePassword(parsed.data.password)) {
    return privateResponse({ error: "Wrong password." }, 401);
  }

  await grantDurationQueueAccess();
  return privateResponse({ ok: true });
}
