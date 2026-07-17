import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { assertHumanSubmission, assertSubmissionRate, DuplicateSubmissionError, requestFingerprint, saveContactMessage, SubmissionRateLimitError, SubmissionStorageError } from "@/lib/communications";
import { jsonError, readJsonBody } from "@/lib/http";
import { contactMessageSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    const fingerprint = requestFingerprint(request);
    assertSubmissionRate(`contact:${fingerprint}`, 3, 30 * 60 * 1000);
    const input = contactMessageSchema.parse(await readJsonBody(request, 16 * 1024));
    assertHumanSubmission(input.form_started_at, input.website);
    const session = await getCurrentSession();
    await saveContactMessage(session?.user.id ?? null, fingerprint, input);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    if (error instanceof SubmissionRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } });
    }
    const status = error instanceof SubmissionStorageError ? 503
      : error instanceof DuplicateSubmissionError ? 409
      : 400;
    return jsonError(error, status);
  }
}
