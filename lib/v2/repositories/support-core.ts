import type { DatabaseClient, VerifiedServerPrincipal, TenantTransaction } from "../db/client.ts";

export class SubmissionStorageError extends Error {
  readonly code = "support_storage_unavailable";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SubmissionStorageError";
  }
}
export class DuplicateSubmissionError extends Error {}

type ContactSubmission = {
  enquiry_type: number;
  email: string;
  subject: string;
  message: string;
  dedupe_hash: string;
};
type FeedbackSubmission = {
  feedback_type: number;
  message: string;
  contact_allowed: boolean;
  contact_email: string | null;
  route: string | null;
  app_area: string | null;
  client_context: { viewport?: string; browser?: string; submitted_at?: string; source?: string } | null;
  dedupe_hash: string;
};

/** Narrow write helpers; the ordinary application role cannot read support content. */
export class SupportRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database = database; }

  async contact(principal: VerifiedServerPrincipal | null, input: ContactSubmission): Promise<void> {
    return this.run(principal, async tx => {
      const rows = await tx<{ accepted: boolean }[]>`select support.submit_contact(${tx.json(input)}) as accepted`;
      if (!rows[0]) throw new SubmissionStorageError("We couldn’t send your message. Please try again.");
      if (!rows[0].accepted) throw new DuplicateSubmissionError("This message was already sent.");
    });
  }

  async feedback(principal: VerifiedServerPrincipal | null, input: FeedbackSubmission): Promise<void> {
    return this.run(principal, async tx => {
      const rows = await tx<{ accepted: boolean }[]>`select support.submit_feedback(${tx.json(input)}) as accepted`;
      if (!rows[0]) throw new SubmissionStorageError("We couldn’t send your feedback. Please try again.");
      if (!rows[0].accepted) throw new DuplicateSubmissionError("This feedback was already sent.");
    });
  }

  private async run(principal: VerifiedServerPrincipal | null, operation: (tx: TenantTransaction) => Promise<void>) {
    try {
      if (principal) await this.database.withPrincipal(principal, operation);
      else await this.database.sql.begin(async tx => {
        // A pooled connection must never lend a previous account to a guest.
        await tx`select set_config('app.account_id', '', true)`;
        await operation(tx);
      });
    } catch (error) {
      if (error instanceof DuplicateSubmissionError || error instanceof SubmissionStorageError) throw error;
      throw new SubmissionStorageError("We couldn’t save your submission. Please try again.", error);
    }
  }
}
