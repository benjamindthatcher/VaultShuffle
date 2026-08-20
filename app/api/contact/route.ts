import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { assertHumanSubmission, DuplicateSubmissionError, InvalidSubmissionError, requestFingerprint, saveContactMessage, SubmissionStorageError } from "@/lib/communications";
import { assertSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { contactMessageSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const fingerprint = requestFingerprint(request);
    await enforceRateLimit({
      bucket: "contact_submission",
      identity: fingerprint,
      limit: 3,
      windowSeconds: 30 * 60,
      message: "You have sent several support messages recently. Please wait before sending another."
    });
    const input = contactMessageSchema.parse(await readJsonBody(request, 16 * 1024));
    assertHumanSubmission(input.form_started_at, input.website);
    const session = await getCurrentSession();
    await saveContactMessage(session?.user.id ?? null, fingerprint, input);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    const status = error instanceof SubmissionStorageError ? 503
      : error instanceof DuplicateSubmissionError ? 409
      : error instanceof InvalidSubmissionError ? 400
      : 500;
    return jsonError(error, status);
  }
}
