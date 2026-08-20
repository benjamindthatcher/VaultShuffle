import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { assertHumanSubmission, DuplicateSubmissionError, InvalidSubmissionError, requestFingerprint, saveFeedback, SubmissionStorageError } from "@/lib/communications";
import { assertSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { feedbackSubmissionSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const fingerprint = requestFingerprint(request);
    await enforceRateLimit({
      bucket: "feedback_submission",
      identity: fingerprint,
      limit: 5,
      windowSeconds: 10 * 60,
      message: "You have sent several feedback notes recently. Please wait before sending another."
    });
    const input = feedbackSubmissionSchema.parse(await readJsonBody(request, 16 * 1024));
    assertHumanSubmission(input.form_started_at, input.website);
    const session = await getCurrentSession();
    await saveFeedback(session?.user.id ?? null, fingerprint, input);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    const status = error instanceof SubmissionStorageError ? 503
      : error instanceof DuplicateSubmissionError ? 409
      : error instanceof InvalidSubmissionError ? 400
      : 500;
    return jsonError(error, status);
  }
}
