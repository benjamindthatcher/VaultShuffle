import { z } from "zod";

export const durationReviewSubmissionSchema = z.object({
  steamAppId: z.number().int().positive().safe(),
  response: z.string().trim().min(1, "Add a link or a short explanation first.").max(2000),
});

export type DurationReviewSubmission = z.infer<typeof durationReviewSubmissionSchema>;

export function classifyDurationReviewResponse(response: string) {
  const value = response.trim();

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      (url.protocol === "https:" || url.protocol === "http:")
      && host === "howlongtobeat.com"
      && /^\/game\/\d+\/?$/.test(url.pathname)
    ) {
      return { responseText: value, responseKind: "hltb_url" as const, sourceUrl: url.toString() };
    }
  } catch {
    // Anything that is not an exact HLTB game URL remains useful as a note.
  }

  return { responseText: value, responseKind: "note" as const, sourceUrl: null };
}
