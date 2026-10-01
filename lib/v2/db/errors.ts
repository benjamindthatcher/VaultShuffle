/** A sanitized, retryable database boundary failure. */
export class DatabaseUnavailableError extends Error {
  readonly code = "database_unavailable";
  readonly retryable = true;

  constructor(cause?: unknown) {
    super("VaultShuffle data is temporarily unavailable. Please retry shortly.", { cause });
    this.name = "DatabaseUnavailableError";
  }
}

export class RequestLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Please wait before making more changes.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
