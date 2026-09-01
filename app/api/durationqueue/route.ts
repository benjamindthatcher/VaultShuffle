import { NextResponse } from "next/server";
import { durationReviewSubmissionSchema } from "@/lib/duration-review-input";
import {
  getDurationReviewQueueState,
  hasDurationQueueAccess,
  saveDurationReview,
  undoDurationReview,
} from "@/lib/duration-review";

export const runtime = "nodejs";

function privateResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function GET() {
  if (!await hasDurationQueueAccess()) return privateResponse({ error: "Not found." }, 404);

  try {
    return privateResponse(await getDurationReviewQueueState());
  } catch (error) {
    console.error("Duration review queue failed to load", error);
    return privateResponse({ error: "The duration queue could not be loaded." }, 500);
  }
}

export async function POST(request: Request) {
  if (!await hasDurationQueueAccess()) return privateResponse({ error: "Not found." }, 404);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return privateResponse({ error: "That response could not be read." }, 400);
  }

  const parsed = durationReviewSubmissionSchema.safeParse(payload);
  if (!parsed.success) {
    return privateResponse({ error: parsed.error.issues[0]?.message ?? "Check the response and try again." }, 400);
  }

  try {
    await saveDurationReview(parsed.data);
    return privateResponse({ ok: true });
  } catch (error) {
    console.error("Duration review could not be saved", error);
    return privateResponse({ error: "That response was not saved. Try again." }, 500);
  }
}

export async function DELETE(request: Request) {
  if (!await hasDurationQueueAccess()) return privateResponse({ error: "Not found." }, 404);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return privateResponse({ error: "That undo request could not be read." }, 400);
  }

  const parsed = durationReviewSubmissionSchema.pick({ steamAppId: true }).safeParse(payload);
  if (!parsed.success) return privateResponse({ error: "That game could not be undone." }, 400);

  try {
    await undoDurationReview(parsed.data.steamAppId);
    return privateResponse({ ok: true });
  } catch (error) {
    console.error("Duration review could not be undone", error);
    return privateResponse({ error: "That review could not be undone." }, 500);
  }
}
