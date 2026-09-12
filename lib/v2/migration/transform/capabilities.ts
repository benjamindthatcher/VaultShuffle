import { ExportError } from "../shared/redaction.ts";
import {
  DEFAULT_TRANSFORM_LIMITS,
  decodeSnapshotHash,
  indexTransformAccounts,
  normalizeTransformRun,
  parseTransformCount,
  parseTransformInstant,
  sameTransformRun,
  type AccountKind,
  type AccountMap,
  type AccountMapEntry,
  type TransformRunIdentity,
} from "./sessions.ts";
import type { PgTimestamp } from "./scalars.ts";

/** The exact five-cell observation retained for both legacy provenance sides. */
export type CapabilityTuple = Readonly<{
  libraryVisible: boolean | "t" | "f" | "true" | "false" | null;
  playtimeVisible: boolean | "t" | "f" | "true" | "false" | null;
  lastPlayedVisible: boolean | "t" | "f" | "true" | "false" | null;
  checkedAt: string | null;
  gamesSeen: string | number | null;
}>;

/** A row from legacy `app_accounts`, including the source account kind. */
export type LegacyAccountCapabilityRow = CapabilityTuple & Readonly<{
  legacyId: string;
  accountType: AccountKind;
  run?: TransformRunIdentity;
}>;

/** A row from legacy `app_users`; it is evidence-only and never authoritative. */
export type LegacyProfileCapabilityRow = CapabilityTuple & Readonly<{
  legacyId: string;
  run?: TransformRunIdentity;
}>;

export type CapabilityTransformLimits = Readonly<{
  maxAccounts?: number;
  maxRows?: number;
}>;

const DEFAULT_MAX_ROWS = 200_000;

export type CapabilityTransformErrorCode =
  | "capability_run_invalid"
  | "capability_run_mismatch"
  | "capability_limit_invalid"
  | "capability_input_bound_exceeded"
  | "capability_account_map_invalid"
  | "capability_legacy_id_invalid"
  | "capability_duplicate_account_row"
  | "capability_duplicate_profile_row"
  | "capability_account_missing"
  | "capability_deleted_tombstone_row"
  | "capability_profile_only"
  | "capability_profile_only_dated"
  | "capability_profile_owner"
  | "capability_profile_owner_lifecycle"
  | "capability_account_kind"
  | "capability_row_run_mismatch"
  | "capability_boolean_invalid"
  | "capability_timestamp_invalid"
  | "capability_count_invalid"
  | "capability_profile_newer"
  | "capability_equal_time_conflict";

const CAPABILITY_MESSAGES: Readonly<Record<CapabilityTransformErrorCode, string>> = {
  capability_run_invalid: "The capability transform run identity is invalid.",
  capability_run_mismatch: "The capability input and account map belong to different runs.",
  capability_limit_invalid: "The capability transform bound is invalid.",
  capability_input_bound_exceeded: "The capability transform input exceeds its configured bound.",
  capability_account_map_invalid: "The account map is invalid for the capability transform.",
  capability_legacy_id_invalid: "A capability source identity is invalid.",
  capability_duplicate_account_row: "The account capability source contains duplicate account rows.",
  capability_duplicate_profile_row: "The profile capability source contains duplicate profile rows.",
  capability_account_missing: "An account capability row is absent from the account map or source.",
  capability_deleted_tombstone_row: "A capability source row targets a deleted identity tombstone.",
  capability_profile_only: "A profile capability observation has no account-side observation.",
  capability_profile_only_dated: "A dated profile capability observation has no dated account-side observation.",
  capability_profile_owner: "A profile capability observation has the wrong account identity kind.",
  capability_profile_owner_lifecycle: "A profile capability observation belongs to a non-active account.",
  capability_account_kind: "An account capability row has the wrong account kind.",
  capability_row_run_mismatch: "A capability source row belongs to a different run.",
  capability_boolean_invalid: "A capability boolean cell is malformed.",
  capability_timestamp_invalid: "A capability timestamp cell is malformed or unsupported.",
  capability_count_invalid: "A capability count cell is malformed or outside the target integer range.",
  capability_profile_newer: "A profile capability observation is newer than the account-side tuple.",
  capability_equal_time_conflict: "Equal-time or undated capability tuples conflict.",
};

/** A stable failure with only a code and bounded safe counts in its details. */
export class CapabilityTransformError extends ExportError {
  readonly capabilityCode: CapabilityTransformErrorCode;

  constructor(
    code: CapabilityTransformErrorCode,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(code, CAPABILITY_MESSAGES[code], details);
    this.name = "CapabilityTransformError";
    this.capabilityCode = code;
  }
}

function fail(
  code: CapabilityTransformErrorCode,
  details: Record<string, string | number | boolean | null> = {},
): never {
  throw new CapabilityTransformError(code, details);
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_TEXT.test(value)) fail("capability_legacy_id_invalid");
  return value.toLowerCase();
}

function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > fallback) {
    fail("capability_limit_invalid");
  }
  return result;
}

function booleanCell(value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(?:t|true)$/i.test(value)) return true;
    if (/^(?:f|false)$/i.test(value)) return false;
  }
  fail("capability_boolean_invalid");
}

type NormalizedTuple = Readonly<{
  libraryVisible: boolean | null;
  playtimeVisible: boolean | null;
  lastPlayedVisible: boolean | null;
  checkedAt: string | null;
  checked: PgTimestamp | null;
  gamesSeen: number | null;
}>;

function timestampCell(value: unknown): { text: string | null; parsed: PgTimestamp | null } {
  if (value === null) return { text: null, parsed: null };
  if (typeof value !== "string") fail("capability_timestamp_invalid");
  try {
    const parsed = parseTransformInstant(value);
    if (!parsed) fail("capability_timestamp_invalid");
    return { text: value, parsed };
  } catch {
    fail("capability_timestamp_invalid");
  }
}

function countCell(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") fail("capability_count_invalid");
  try {
    return parseTransformCount(value);
  } catch {
    fail("capability_count_invalid");
  }
}

function tuple(row: CapabilityTuple): NormalizedTuple {
  const checkedAt = timestampCell(row.checkedAt);
  return Object.freeze({
    libraryVisible: booleanCell(row.libraryVisible),
    playtimeVisible: booleanCell(row.playtimeVisible),
    lastPlayedVisible: booleanCell(row.lastPlayedVisible),
    checkedAt: checkedAt.text,
    checked: checkedAt.parsed,
    gamesSeen: countCell(row.gamesSeen),
  });
}

function tupleEqual(left: NormalizedTuple, right: NormalizedTuple): boolean {
  const checkedEqual =
    left.checked === null
      ? right.checked === null
      : right.checked !== null && left.checked.epochMicros === right.checked.epochMicros;
  return (
    left.libraryVisible === right.libraryVisible &&
    left.playtimeVisible === right.playtimeVisible &&
    left.lastPlayedVisible === right.lastPlayedVisible &&
    left.gamesSeen === right.gamesSeen &&
    checkedEqual
  );
}

function sourceRunMatches(rowRun: TransformRunIdentity | undefined, run: TransformRunIdentity): void {
  if (rowRun !== undefined) {
    try {
      if (!sameTransformRun(rowRun, run)) fail("capability_row_run_mismatch");
    } catch (error) {
      if (error instanceof CapabilityTransformError) throw error;
      fail("capability_row_run_mismatch");
    }
  }
}

type IndexedAccount = AccountMapEntry & Readonly<{ normalizedLegacyId: string }>;

function accountIndex(
  accountMap: AccountMap,
  run: TransformRunIdentity,
  maxAccounts: number,
): ReadonlyMap<string, IndexedAccount> {
  if (!accountMap || typeof accountMap !== "object" || Array.isArray(accountMap)) {
    fail("capability_account_map_invalid");
  }
  try {
    if (!sameTransformRun(accountMap.run, run)) fail("capability_run_mismatch");
    const indexed = indexTransformAccounts(accountMap, run, maxAccounts);
    const output = new Map<string, IndexedAccount>();
    for (const [legacyId, entry] of indexed.entries()) {
      if (
        entry.lifecycleStatus === "deleted" &&
        (entry.tombstone === undefined ||
          entry.accountKind !== "manual" ||
          entry.identityVerified)
      ) {
        fail("capability_account_map_invalid");
      }
      if (entry.lifecycleStatus === "merged") {
        fail("capability_account_map_invalid");
      }
      if (entry.accountKind === "manual" && entry.identityVerified) {
        fail("capability_account_map_invalid");
      }
      output.set(legacyId, Object.freeze({ ...entry, normalizedLegacyId: legacyId }));
    }
    return output;
  } catch (error) {
    if (error instanceof CapabilityTransformError) throw error;
    fail("capability_account_map_invalid");
  }
}

type NormalizedSourceRow = Readonly<{
  legacyId: string;
  tuple: NormalizedTuple;
  accountType?: AccountKind;
}>;

function normalizeAccountRow(
  row: LegacyAccountCapabilityRow,
  run: TransformRunIdentity,
): NormalizedSourceRow {
  if (!row || typeof row !== "object") fail("capability_account_map_invalid");
  sourceRunMatches(row.run, run);
  const legacyId = normalizedUuid(row.legacyId);
  if (row.accountType !== "manual" && row.accountType !== "steam") {
    fail("capability_account_kind");
  }
  return Object.freeze({ legacyId, tuple: tuple(row), accountType: row.accountType });
}

function normalizeProfileRow(
  row: LegacyProfileCapabilityRow,
  run: TransformRunIdentity,
): NormalizedSourceRow {
  if (!row || typeof row !== "object") fail("capability_account_map_invalid");
  sourceRunMatches(row.run, run);
  return Object.freeze({ legacyId: normalizedUuid(row.legacyId), tuple: tuple(row) });
}

function projection(value: boolean | null): "unknown" | "visible" {
  return value === true ? "visible" : "unknown";
}

function anyVisible(value: NormalizedTuple): boolean {
  return value.libraryVisible === true || value.playtimeVisible === true || value.lastPlayedVisible === true;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export type AccountCapabilityRecord = Readonly<{
  accountId: number;
  libraryVisibility: "unknown" | "visible";
  playtimeVisibility: "unknown" | "visible";
  lastPlayedVisibility: "unknown" | "visible";
  checkedAt: string | null;
  /** `ok` means a positive capability was observed; no privacy state is inferred. */
  status: "unknown" | "ok";
  sourceSnapshotHash: Uint8Array;
}>;

export type CapabilityEvidenceRecord = Readonly<{
  accountId: number;
  sourceAccountKind: "steam" | "manual" | "unknown";
  evidencePrecedence: "account_writer" | "profile_reader";
  rawLibraryVisible: boolean | null;
  rawPlaytimeVisible: boolean | null;
  rawLastPlayedVisible: boolean | null;
  rawCheckedAt: string | null;
  rawGamesCount: number | null;
  /** The legacy inventory has no validated privacy status, so this is null. */
  rawVisibilityStatus: null;
  projectionStatus: "visible" | "unknown";
  conflictCode: null;
  sourceSnapshotHash: Uint8Array;
  /** Explicitly labelled snapshot capture time, distinct from rawCheckedAt. */
  capturedAt: string;
  evidence: Readonly<{
    sourceRelation: "app_accounts" | "app_users";
    projectionRule: "legacy-boolean-to-capability";
    feedsCompactCapability: boolean;
  }>;
}>;

export type CapabilityTransformInput = Readonly<{
  run: TransformRunIdentity;
  accountMap: AccountMap;
  accountRows: readonly LegacyAccountCapabilityRow[];
  profileRows: readonly LegacyProfileCapabilityRow[];
  limits?: CapabilityTransformLimits;
}>;

export type CapabilityTransformResult = Readonly<{
  run: TransformRunIdentity;
  capabilities: readonly AccountCapabilityRecord[];
  evidence: readonly CapabilityEvidenceRecord[];
  counts: Readonly<{
    accounts: number;
    accountEvidence: number;
    profileEvidence: number;
    visibleAccounts: number;
    unknownAccounts: number;
  }>;
}>;

function evidenceRecord(
  account: IndexedAccount,
  source: "account_writer" | "profile_reader",
  value: NormalizedTuple,
  run: TransformRunIdentity,
  sourceSnapshotHash: Uint8Array,
): CapabilityEvidenceRecord {
  const sourceRelation = source === "account_writer" ? "app_accounts" : "app_users";
  return Object.freeze({
    accountId: account.accountId,
    sourceAccountKind: account.accountKind,
    evidencePrecedence: source,
    rawLibraryVisible: value.libraryVisible,
    rawPlaytimeVisible: value.playtimeVisible,
    rawLastPlayedVisible: value.lastPlayedVisible,
    rawCheckedAt: value.checkedAt,
    rawGamesCount: value.gamesSeen,
    rawVisibilityStatus: null,
    projectionStatus: anyVisible(value) ? "visible" : "unknown",
    conflictCode: null,
    sourceSnapshotHash: cloneBytes(sourceSnapshotHash),
    capturedAt: run.observedAt,
    evidence: Object.freeze({
      sourceRelation,
      projectionRule: "legacy-boolean-to-capability",
      feedsCompactCapability: source === "account_writer",
    }),
  });
}

function comparePrecedence(
  account: NormalizedTuple,
  profile: NormalizedTuple,
): void {
  if (account.checked === null && profile.checked !== null) {
    fail("capability_profile_only_dated");
  }
  if (
    account.checked !== null &&
    profile.checked !== null &&
    profile.checked.epochMicros > account.checked.epochMicros
  ) {
    fail("capability_profile_newer");
  }
  const equalTimeOrBothUnknown =
    account.checked === null && profile.checked === null
      ? true
      : account.checked !== null &&
        profile.checked !== null &&
        account.checked.epochMicros === profile.checked.epochMicros;
  if (equalTimeOrBothUnknown && !tupleEqual(account, profile)) {
    fail("capability_equal_time_conflict");
  }
}

/**
 * Transform the account-side capability tuple and retain profile-side
 * provenance. The account tuple is authoritative as a unit. Profile-only,
 * newer, and equal-time conflicting observations fail closed; an older or
 * undated profile observation is retained without changing the projection.
 */
export function transformCapabilities(input: CapabilityTransformInput): CapabilityTransformResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("capability_account_map_invalid");
  }
  if (
    !input.accountMap ||
    typeof input.accountMap !== "object" ||
    Array.isArray(input.accountMap)
  ) {
    fail("capability_account_map_invalid");
  }
  let run: TransformRunIdentity;
  try {
    run = normalizeTransformRun(input.run);
  } catch {
    fail("capability_run_invalid");
  }
  const maxAccounts = limit(input.limits?.maxAccounts, DEFAULT_TRANSFORM_LIMITS.maxAccounts);
  const maxRows = limit(input.limits?.maxRows, DEFAULT_MAX_ROWS);
  const accounts = accountIndex(input.accountMap, run, maxAccounts);
  if (!Array.isArray(input.accountRows) || !Array.isArray(input.profileRows)) {
    fail("capability_account_map_invalid");
  }
  if (input.accountRows.length + input.profileRows.length > maxRows) {
    fail("capability_input_bound_exceeded", { maxRows });
  }

  const accountRows = new Map<string, NormalizedSourceRow>();
  for (const row of input.accountRows) {
    const normalized = normalizeAccountRow(row, run);
    if (accountRows.has(normalized.legacyId)) fail("capability_duplicate_account_row");
    const account = accounts.get(normalized.legacyId);
    if (!account) fail("capability_account_missing");
    if (account.lifecycleStatus === "deleted") {
      fail("capability_deleted_tombstone_row");
    }
    if (normalized.accountType !== account.accountKind) fail("capability_account_kind");
    accountRows.set(normalized.legacyId, normalized);
  }

  const profileRows = new Map<string, NormalizedSourceRow>();
  for (const row of input.profileRows) {
    const normalized = normalizeProfileRow(row, run);
    if (profileRows.has(normalized.legacyId)) fail("capability_duplicate_profile_row");
    const account = accounts.get(normalized.legacyId);
    if (!account) fail("capability_profile_only");
    if (account.lifecycleStatus === "deleted") {
      fail("capability_deleted_tombstone_row");
    }
    if (account.accountKind !== "steam" || !account.identityVerified) {
      fail("capability_profile_owner");
    }
    if (account.lifecycleStatus !== "active") fail("capability_profile_owner_lifecycle");
    const accountRow = accountRows.get(normalized.legacyId);
    if (!accountRow) {
      fail(
        normalized.tuple.checked === null
          ? "capability_profile_only"
          : "capability_profile_only_dated",
      );
    }
    profileRows.set(normalized.legacyId, normalized);
  }

  for (const [legacyId, account] of accounts) {
    if (account.lifecycleStatus === "deleted") continue;
    if (!accountRows.has(legacyId)) fail("capability_account_missing");
  }

  const sourceSnapshotHash = decodeSnapshotHash(run);
  const orderedAccounts = [...accounts.values()]
    .filter((account) => account.lifecycleStatus === "active")
    .sort((left, right) => left.accountId - right.accountId);
  const capabilities: AccountCapabilityRecord[] = [];
  const evidence: CapabilityEvidenceRecord[] = [];

  for (const account of orderedAccounts) {
    const accountSource = accountRows.get(account.normalizedLegacyId);
    if (!accountSource) fail("capability_account_missing");
    const profileSource = profileRows.get(account.normalizedLegacyId);
    if (profileSource) comparePrecedence(accountSource.tuple, profileSource.tuple);
    const value = accountSource.tuple;
    capabilities.push(Object.freeze({
      accountId: account.accountId,
      libraryVisibility: projection(value.libraryVisible),
      playtimeVisibility: projection(value.playtimeVisible),
      lastPlayedVisibility: projection(value.lastPlayedVisible),
      checkedAt: value.checkedAt,
      status: anyVisible(value) ? "ok" : "unknown",
      sourceSnapshotHash: cloneBytes(sourceSnapshotHash),
    }));
    evidence.push(evidenceRecord(account, "account_writer", value, run, sourceSnapshotHash));
    if (profileSource) {
      evidence.push(evidenceRecord(account, "profile_reader", profileSource.tuple, run, sourceSnapshotHash));
    }
  }

  const visibleAccounts = capabilities.filter((record) => record.status === "ok").length;
  const result: CapabilityTransformResult = {
    run,
    capabilities: Object.freeze(capabilities),
    evidence: Object.freeze(evidence),
    counts: Object.freeze({
      accounts: capabilities.length,
      accountEvidence: capabilities.length,
      profileEvidence: profileRows.size,
      visibleAccounts,
      unknownAccounts: capabilities.length - visibleAccounts,
    }),
  };
  return Object.freeze(result);
}

export const transformCapabilityRows = transformCapabilities;
export type CapabilityTransform = CapabilityTransformInput;
