import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requestFingerprint } from "@/lib/rate-limit";
import type { z } from "zod";
import type { contactMessageSchema, feedbackSubmissionSchema } from "@/lib/validation";

type FeedbackInput = z.infer<typeof feedbackSubmissionSchema>;
type ContactInput = z.infer<typeof contactMessageSchema>;
const SUPPORT_INBOX = process.env.SUPPORT_INBOX_EMAIL || "support@vaultshuffle.com";

export class SubmissionStorageError extends Error {}

export class DuplicateSubmissionError extends Error {}

export class InvalidSubmissionError extends Error {}

export function assertHumanSubmission(startedAt: number, website = "") {
  const elapsed = Date.now() - startedAt;
  if (website || elapsed < 800 || elapsed > 24 * 60 * 60 * 1000) {
    throw new InvalidSubmissionError("Please refresh the form and try again.");
  }
}

export { requestFingerprint };

function contentHash(parts: Array<string | null | undefined>) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("\u001f")).digest("hex");
}

async function notifySupport(subject: string, text: string, replyTo?: string | null) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SUPPORT_FROM_EMAIL;
  if (!apiKey || !from) return;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [SUPPORT_INBOX], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    if (!response.ok) throw new Error(`Support notification failed with status ${response.status}.`);
  } catch {
    // The database insert is authoritative; notification failures must not lose submissions.
  }
}

export async function saveFeedback(userId: string | null, fingerprint: string, input: FeedbackInput) {
  const supabase = getSupabaseAdmin();
  const dedupeHash = contentHash([fingerprint, input.feedback_type, input.message.toLowerCase()]);
  const { data: duplicate } = await supabase
    .from("feedback_submissions")
    .select("id")
    .eq("dedupe_hash", dedupeHash)
    .gte("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .maybeSingle();
  if (duplicate) throw new DuplicateSubmissionError("This feedback was already sent.");

  const { error } = await supabase.from("feedback_submissions").insert({
    user_id: userId,
    feedback_type: input.feedback_type === "bug" ? 1 : 0,
    message: input.message,
    contact_allowed: input.contact_allowed,
    contact_email: input.contact_allowed ? input.contact_email || null : null,
    route: input.route || null,
    app_area: input.app_area || null,
    client_context: input.client_context || null,
    dedupe_hash: dedupeHash
  });
  if (error) throw new SubmissionStorageError("We couldn’t send your feedback. Please try again.");
  await notifySupport(
    `[VaultShuffle ${input.feedback_type === "bug" ? "Bug Report" : "Feedback"}] ${input.app_area || input.route || "Website"}`,
    `${input.message}\n\nRoute: ${input.route || "Unknown"}\nArea: ${input.app_area || "Unknown"}\nFollow-up allowed: ${input.contact_allowed ? "Yes" : "No"}`,
    input.contact_allowed ? input.contact_email : null
  );
}

export async function saveContactMessage(userId: string | null, fingerprint: string, input: ContactInput) {
  const supabase = getSupabaseAdmin();
  const dedupeHash = contentHash([fingerprint, input.email.toLowerCase(), input.subject.toLowerCase(), input.message.toLowerCase()]);
  const { data: duplicate } = await supabase
    .from("contact_messages")
    .select("id")
    .eq("dedupe_hash", dedupeHash)
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .maybeSingle();
  if (duplicate) throw new DuplicateSubmissionError("This message was already sent.");

  const { error } = await supabase.from("contact_messages").insert({
    user_id: userId,
    enquiry_type: ["account", "steam-data", "privacy", "technical", "business", "other"].indexOf(input.enquiry_type),
    email: input.email,
    subject: input.subject,
    message: input.message,
    dedupe_hash: dedupeHash
  });
  if (error) throw new SubmissionStorageError("We couldn’t send your message. Please try again.");
  await notifySupport(`[VaultShuffle Contact] ${input.subject}`, `${input.message}\n\nEnquiry: ${input.enquiry_type}\nFrom: ${input.email}`, input.email);
}
