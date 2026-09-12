import { ExportError } from "../shared/redaction.ts";

export type LoaderErrorCode =
  | "loader_contract_invalid"
  | "loader_remote_refused"
  | "loader_stage_failed"
  | "loader_stage_changed"
  | "loader_stage_limit"
  | "loader_copy_invalid"
  | "loader_fingerprint_mismatch"
  | "loader_run_mismatch"
  | "loader_replay_mismatch"
  | "loader_conflicts_unresolved"
  | "loader_snapshot_evidence_missing"
  | "loader_source_coverage"
  | "loader_target_coverage"
  | "loader_target_failed"
  | "loader_reconciliation_failed"
  | "loader_publication_refused";

const MESSAGES: Readonly<Record<LoaderErrorCode, string>> = Object.freeze({
  loader_contract_invalid: "The migration loader contract is invalid.",
  loader_remote_refused: "The migration loader accepts only an explicit local Unix-socket target.",
  loader_stage_failed: "The verified export could not be staged privately.",
  loader_stage_changed: "The private staging artifact changed after verification.",
  loader_stage_limit: "A staged relation exceeded its configured row or byte bound.",
  loader_copy_invalid: "A target value cannot be represented by the declared PostgreSQL COPY contract.",
  loader_fingerprint_mismatch: "The migration schema, manifest, code, or transform fingerprint does not match.",
  loader_run_mismatch: "The migration state belongs to a different run or source snapshot.",
  loader_replay_mismatch: "A replay attempted to change an already recorded migration step.",
  loader_conflicts_unresolved: "One or more transform conflicts or preservation exceptions remain unresolved.",
  loader_snapshot_evidence_missing: "A required snapshot-sensitive source decision has no supplied evidence.",
  loader_source_coverage: "The source relation or column disposition is incomplete.",
  loader_target_coverage: "The target relation or column load contract is incomplete.",
  loader_target_failed: "The local PostgreSQL target refused the migration transaction.",
  loader_reconciliation_failed: "The loaded target does not match the expected canonical reconciliation.",
  loader_publication_refused: "The loader refused to publish a run that did not pass every final gate.",
});

/** Stable diagnostics contain only fixed codes and allowlisted field names. */
export class LoaderError extends ExportError {
  readonly loaderCode: LoaderErrorCode;

  constructor(code: LoaderErrorCode, details: Readonly<Record<string, string | number | boolean | null>> = {}) {
    super(code, MESSAGES[code], details);
    this.name = "LoaderError";
    this.loaderCode = code;
  }
}

export function loaderFailure(
  code: LoaderErrorCode,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): LoaderError {
  return new LoaderError(code, details);
}

export function asLoaderError(error: unknown, fallback: LoaderErrorCode): LoaderError {
  return error instanceof LoaderError ? error : loaderFailure(fallback);
}
