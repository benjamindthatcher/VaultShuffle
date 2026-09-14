/** A sanitized, retryable database boundary failure. */
export class DatabaseUnavailableError extends Error {
  readonly code = "database_unavailable";
  readonly retryable = true;

  constructor() {
    super("VaultShuffle data is temporarily unavailable. Please retry shortly.");
    this.name = "DatabaseUnavailableError";
  }
}
