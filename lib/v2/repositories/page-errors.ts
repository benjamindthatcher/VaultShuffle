/** A bounded page request that cannot become valid by retrying unchanged. */
export class InvalidPageQueryError extends Error {
  readonly code: string = "invalid_query";
  readonly retryable = false;
  readonly status: number = 400;

  constructor(message = "The page query is invalid.") {
    super(message);
    this.name = "InvalidPageQueryError";
  }
}

/** The caller must discard its cursor and restart from the first page. */
export class PageCursorRestartRequiredError extends Error {
  readonly code = "cursor_restart_required";
  readonly retryable = false;
  readonly status = 409;

  constructor() {
    super("The page changed while it was being read. Restart from the first page.");
    this.name = "PageCursorRestartRequiredError";
  }
}
