import type { CopyRow } from "../read/copy-text.ts";
import { ExportError } from "../shared/redaction.ts";
import {
  comparePgTimestamps,
  parsePgInteger,
  parsePgTimestamptz,
  type PgTimestamp,
  ScalarError,
} from "./scalars.ts";

/** COPY cells stay strings until this layer makes a reviewed conversion. */
export type IdentityCell = CopyRow[number];

export type IdentityErrorCode =
  | "identity_validation_failed"
  | "identity_run_invalid"
  | "identity_mixed_run_identity"
  | "identity_input_invalid"
  | "identity_account_count_limit"
  | "identity_duplicate_root"
  | "identity_duplicate_profile"
  | "identity_duplicate_merge"
  | "identity_unmatched_profile"
  | "identity_impossible_account_kind"
  | "identity_steam_profile_missing"
  | "identity_invalid_uuid"
  | "identity_invalid_steam_id"
  | "identity_steam_id_roundtrip"
  | "identity_verified_steam_collision"
  | "identity_invalid_timestamp"
  | "identity_invalid_merge"
  | "identity_merge_target_missing"
  | "identity_merge_steam_conflict"
  | "identity_tombstone_required"
  | "identity_tombstone_unproven"
  | "identity_tombstone_unneeded"
  | "identity_tombstone_invalid"
  | "identity_target_metadata_invalid"
  | "identity_account_id_overflow"
  | "identity_physical_gap";

const IDENTITY_MESSAGES: Readonly<Record<IdentityErrorCode, string>> = {
  identity_validation_failed: "The identity transform found one or more source reconciliation blockers.",
  identity_run_invalid: "The identity transform run identity is invalid.",
  identity_mixed_run_identity: "Identity rows do not belong to one explicit migration run.",
  identity_input_invalid: "The identity transform input shape is invalid.",
  identity_account_count_limit: "The identity transform account bound was exceeded.",
  identity_duplicate_root: "The source contains duplicate account roots.",
  identity_duplicate_profile: "The source contains duplicate or conflicting profile kinds.",
  identity_duplicate_merge: "The source contains duplicate merge evidence.",
  identity_unmatched_profile: "A source profile has no matching account root.",
  identity_impossible_account_kind: "A source profile kind cannot belong to its account root.",
  identity_steam_profile_missing: "A Steam account has no verified source profile.",
  identity_invalid_uuid: "A source identity UUID is invalid.",
  identity_invalid_steam_id: "A source Steam ID is invalid or outside the target domain.",
  identity_steam_id_roundtrip: "A source Steam ID cannot round-trip through the target bigint domain.",
  identity_verified_steam_collision: "Verified Steam identity is claimed by more than one source account.",
  identity_invalid_timestamp: "A source timestamp is invalid or unsupported.",
  identity_invalid_merge: "A source merge row violates the reviewed merge shape.",
  identity_merge_target_missing: "A merge target is absent from the source account union.",
  identity_merge_steam_conflict: "A merge row conflicts with the target verified Steam identity.",
  identity_tombstone_required: "A deleted merge source needs explicit tombstone evidence.",
  identity_tombstone_unproven: "Merge tombstone evidence is absent, incomplete, or unmatched.",
  identity_tombstone_unneeded: "Tombstone evidence was supplied for a source account that is present.",
  identity_tombstone_invalid: "Merge tombstone evidence is not a supported deleted-source proof.",
  identity_target_metadata_invalid: "Source profile metadata cannot satisfy the target bounds without loss.",
  identity_account_id_overflow: "The deterministic account identity does not fit the target integer range.",
  identity_physical_gap: "The current target contract cannot represent this identity fact safely.",
};

export type IdentityDiagnostic = Readonly<{
  code: IdentityErrorCode;
  relation: string;
  field: string | null;
  count: number;
}>;

/**
 * An identity error contains only a stable code, source relation/field and a
 * count.  It never contains a UUID, Steam ID, display name, URL or timestamp.
 */
export class IdentityTransformError extends ExportError {
  readonly identityCode: IdentityErrorCode;
  readonly diagnostics: readonly IdentityDiagnostic[];

  constructor(code: IdentityErrorCode, diagnostic: IdentityDiagnostic) {
    super(code, IDENTITY_MESSAGES[code], {
      relation: diagnostic.relation,
      field: diagnostic.field,
      count: diagnostic.count,
    });
    this.name = "IdentityTransformError";
    this.identityCode = code;
    this.diagnostics = Object.freeze([Object.freeze({ ...diagnostic })]);
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      diagnostics: this.diagnostics,
    };
  }
}

function identityFailure(code: IdentityErrorCode, relation: string, field: string | null = null, count = 1): never {
  throw new IdentityTransformError(code, { code, relation, field, count });
}

const UUID_TEXT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const STEAM_ID_TEXT = /^[0-9]{17}$/;
const RUN_ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_TEXT = /^[0-9a-f]{64}$/;
const PG_BIGINT_MAX = BigInt("9223372036854775807");
const TARGET_INTEGER_MAX = BigInt("2147483647");

export type IdentityRunIdentity = Readonly<{
  runId: string;
  snapshotHash: string;
  /** Optional source labels copied from the verified export manifest. */
  sourceProjectRef?: string;
  sourceDatabase?: string;
}>;

export type AppAccountSourceRow = Readonly<{
  id: IdentityCell;
  account_type: IdentityCell;
  created_at: IdentityCell;
  updated_at: IdentityCell;
  last_visited_at: IdentityCell;
  /** Optional row annotations used by tests/adapters to detect mixed runs. */
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export type AppUserSourceRow = Readonly<{
  id: IdentityCell;
  steam_id: IdentityCell;
  display_name: IdentityCell;
  avatar_url: IdentityCell;
  created_at: IdentityCell;
  updated_at: IdentityCell;
  last_login_at: IdentityCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export type ManualSteamProfileSourceRow = Readonly<{
  id: IdentityCell;
  steam_id: IdentityCell;
  steam_profile_url: IdentityCell;
  display_name: IdentityCell;
  steam_display_name: IdentityCell;
  avatar_url: IdentityCell;
  created_at: IdentityCell;
  updated_at: IdentityCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export type AccountMergeSourceRow = Readonly<{
  id: IdentityCell;
  source_account_id: IdentityCell;
  target_account_id: IdentityCell;
  verified_steam_id: IdentityCell;
  merge_mode: IdentityCell;
  created_at: IdentityCell;
  analytics_delivered_at: IdentityCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/**
 * Evidence supplied by the export/manifest layer when an account_merges row
 * points at a source account removed by the legacy merge function.  The
 * `created_at_meaning` marker is required because a merge observation is not
 * an account creation fact.  No current source row requires this branch.
 */
export type MergeSourceTombstoneEvidence = Readonly<{
  merge_id: IdentityCell;
  source_account_id: IdentityCell;
  target_account_id: IdentityCell;
  verified_steam_id: IdentityCell;
  merge_mode: IdentityCell;
  created_at: IdentityCell;
  source_deleted: boolean | IdentityCell;
  provenance: IdentityCell;
  created_at_meaning: IdentityCell;
  /** Optional exact source creation instant, only when separately evidenced. */
  source_created_at?: IdentityCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export type IdentityTransformInput = Readonly<{
  runIdentity: IdentityRunIdentity;
  appAccounts: readonly AppAccountSourceRow[];
  appUsers: readonly AppUserSourceRow[];
  manualSteamProfiles: readonly ManualSteamProfileSourceRow[];
  accountMerges?: readonly AccountMergeSourceRow[];
  mergeTombstones?: readonly MergeSourceTombstoneEvidence[];
}>;

export type IdentityTransformOptions = Readonly<{
  /** Maximum complete account union held by this bounded phase. */
  maxAccounts?: number;
}>;

type NormalizedRunIdentity = IdentityRunIdentity;

type NormalizedAccount = {
  publicId: string;
  canonicalId: string;
  accountKind: "manual" | "steam";
  createdAt: PgTimestamp;
  sourceUpdatedAt: PgTimestamp;
  lastSeenAt: PgTimestamp | null;
};

type NormalizedSteamProfile = {
  publicId: string;
  canonicalId: string;
  steamIdSource: string;
  steamId: string;
  displayName: string | null;
  steamDisplayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  createdAt: PgTimestamp;
  updatedAt: PgTimestamp;
  sourceKind: "app_users" | "manual_profile";
  lastLoginAt: PgTimestamp | null;
};

type NormalizedMerge = {
  mergeId: string;
  mergeIdCanonical: string;
  sourceId: string;
  sourceCanonicalId: string;
  targetId: string;
  targetCanonicalId: string;
  verifiedSteamIdSource: string;
  verifiedSteamId: string;
  mergeMode: "promoted" | "merged_existing";
  createdAt: PgTimestamp;
  analyticsDeliveredAt: PgTimestamp | null;
};

type NormalizedTombstone = {
  mergeId: string;
  mergeIdCanonical: string;
  sourceId: string;
  sourceCanonicalId: string;
  targetId: string;
  targetCanonicalId: string;
  verifiedSteamIdSource: string;
  verifiedSteamId: string;
  mergeObservedAt: PgTimestamp;
  createdAt: PgTimestamp;
  createdAtMeaning: "merge_observed_at" | "source_account_created_at";
};

type Candidate = {
  publicId: string;
  canonicalId: string;
  accountKind: "manual" | "steam";
  lifecycleStatus: "active" | "deleted";
  createdAt: PgTimestamp;
  creationTimeMeaning: "source_account_created_at" | "merge_observed_at";
  sourceAccount: NormalizedAccount | null;
  tombstone: NormalizedTombstone | null;
};

export type AccountTargetRecord = Readonly<{
  id: number;
  public_id: string;
  account_kind: "manual" | "steam";
  lifecycle_status: "active" | "deleted";
  display_name: string | null;
  created_at: PgTimestamp;
  last_seen_at: PgTimestamp | null;
  library_revision: string;
  state_revision: string;
  locale: string | null;
  store_country: string | null;
  currency: string | null;
  last_login_at: PgTimestamp | null;
  /** Transform evidence for a synthetic deleted source; absent for live roots. */
  tombstone?: Readonly<{
    merge_id: string;
    source_deleted: true;
    verified: false;
    created_at_meaning: "merge_observed_at" | "source_account_created_at";
  }>;
}>;

export type SteamProfileTargetRecord = Readonly<{
  account_id: number;
  steam_id: string;
  /** Original source text retained for checked text-to-bigint conversion. */
  steam_id_source: string;
  verified: boolean;
  display_name: string | null;
  steam_display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
  source_kind: "app_users" | "manual_profile";
}>;

export type AccountMapTargetRecord = Readonly<{
  legacy_id: string;
  account_id: number;
  /** `unknown` marks a UUID-only deleted-source tombstone with no live root row. */
  source_kind: "app_accounts" | "unknown";
  source_snapshot_hash: string;
}>;

export type MergeEvidenceRecord = Readonly<{
  legacy_merge_id: string;
  source_public_id: string;
  target_public_id: string;
  verified_steam_id: string;
  verified_steam_id_source: string;
  merge_mode: "promoted" | "merged_existing";
  created_at: PgTimestamp;
  analytics_delivered_at: PgTimestamp | null;
  source_tombstone_present: boolean;
  source_tombstone_account_id: number | null;
}>;

export type IdentityTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  accounts: readonly AccountTargetRecord[];
  steam_profiles: readonly SteamProfileTargetRecord[];
  account_map: readonly AccountMapTargetRecord[];
  merge_evidence: readonly MergeEvidenceRecord[];
}>;

function asObject(value: unknown, relation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    identityFailure("identity_input_invalid", relation);
  }
  return value as Record<string, unknown>;
}

function sourceCell(row: object, key: string, relation: string): string {
  const value = (row as Record<string, unknown>)[key];
  if (typeof value !== "string") identityFailure("identity_input_invalid", relation, key);
  return value;
}

function nullableSourceCell(row: object, key: string, relation: string): string | null {
  const value = (row as Record<string, unknown>)[key];
  if (value === null) return null;
  if (typeof value !== "string") identityFailure("identity_input_invalid", relation, key);
  return value;
}

function tombstoneCell(row: object, key: string): string {
  const value = (row as Record<string, unknown>)[key];
  if (typeof value !== "string") identityFailure("identity_tombstone_invalid", "merge_tombstones", key);
  return value;
}

function optionalAlias(row: object, first: string, second: string): unknown {
  const record = row as Record<string, unknown>;
  const left = record[first];
  const right = record[second];
  if (left !== undefined && right !== undefined && left !== right) {
    return { mismatch: true };
  }
  return left ?? right;
}

function checkRowRunIdentity(row: object, run: NormalizedRunIdentity, relation: string): void {
  const rowRunId = optionalAlias(row, "runId", "run_id");
  const rowSnapshotHash = optionalAlias(row, "snapshotHash", "snapshot_hash");
  if (
    typeof rowRunId === "object" ||
    typeof rowSnapshotHash === "object" ||
    (rowRunId !== undefined && typeof rowRunId !== "string") ||
    (rowSnapshotHash !== undefined && typeof rowSnapshotHash !== "string")
  ) {
    identityFailure("identity_mixed_run_identity", relation);
  }
  if (
    (rowRunId !== undefined && rowRunId !== run.runId) ||
    (rowSnapshotHash !== undefined && rowSnapshotHash !== run.snapshotHash)
  ) {
    identityFailure("identity_mixed_run_identity", relation);
  }
}

function canonicalUuid(value: string, relation: string, field: string): { original: string; canonical: string } {
  if (!UUID_TEXT.test(value)) identityFailure("identity_invalid_uuid", relation, field);
  return { original: value, canonical: value.toLowerCase() };
}

function timestamp(value: string | null, relation: string, field: string, required: boolean): PgTimestamp | null {
  if (value === null && required) identityFailure("identity_invalid_timestamp", relation, field);
  try {
    return parsePgTimestamptz(value, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof ScalarError) identityFailure("identity_invalid_timestamp", relation, field);
    throw error;
  }
}

function steamId(value: string, relation: string, field: string): { source: string; target: string } {
  if (!STEAM_ID_TEXT.test(value)) identityFailure("identity_invalid_steam_id", relation, field);
  let parsed: bigint | null;
  try {
    parsed = parsePgInteger(value, {
      minInclusive: BigInt(1),
      maxInclusive: PG_BIGINT_MAX,
      field: `${relation}.${field}`,
    });
  } catch (error) {
    if (error instanceof ScalarError) identityFailure("identity_invalid_steam_id", relation, field);
    throw error;
  }
  if (parsed === null || parsed.toString(10) !== value) {
    identityFailure("identity_steam_id_roundtrip", relation, field);
  }
  return { source: value, target: parsed.toString(10) };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** PostgreSQL btrim(text) with its default single-space trim character. */
function pgBtrim(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

function boundedTargetText(
  value: string | null,
  relation: string,
  field: string,
  options: { nullable: boolean; maxLength: number; requireTrimmedContent: boolean },
): string | null {
  if (value === null) {
    if (options.nullable) return null;
    identityFailure("identity_target_metadata_invalid", relation, field);
  }
  if (codePointLength(value) > options.maxLength) {
    identityFailure("identity_target_metadata_invalid", relation, field);
  }
  if (options.requireTrimmedContent && codePointLength(pgBtrim(value)) < 1) {
    // The source value is retained as a private blocker.  Turning it into NULL
    // would lose a nonempty source text merely to satisfy the target check.
    identityFailure("identity_target_metadata_invalid", relation, field);
  }
  return value;
}

function validateRunIdentity(value: unknown): NormalizedRunIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    identityFailure("identity_run_invalid", "run_identity");
  }
  const candidate = value as Record<string, unknown>;
  // Check runtime types before the regexes. RegExp.test coerces undefined,
  // null, numbers and objects to text, which could otherwise make malformed
  // identity input look valid or produce unstable diagnostics.
  if (typeof candidate.runId !== "string" || typeof candidate.snapshotHash !== "string") {
    identityFailure("identity_run_invalid", "run_identity");
  }
  if (!RUN_ID_TEXT.test(candidate.runId) || !SHA256_TEXT.test(candidate.snapshotHash)) {
    identityFailure("identity_run_invalid", "run_identity");
  }
  const sourceProjectRef = candidate.sourceProjectRef;
  const sourceDatabase = candidate.sourceDatabase;
  if (
    (sourceProjectRef !== undefined && (typeof sourceProjectRef !== "string" || sourceProjectRef.length === 0)) ||
    (sourceDatabase !== undefined && (typeof sourceDatabase !== "string" || sourceDatabase.length === 0))
  ) {
    identityFailure("identity_run_invalid", "run_identity");
  }
  const normalized: IdentityRunIdentity = {
    runId: candidate.runId,
    snapshotHash: candidate.snapshotHash,
    ...(sourceProjectRef === undefined ? {} : { sourceProjectRef }),
    ...(sourceDatabase === undefined ? {} : { sourceDatabase }),
  };
  return Object.freeze(normalized);
}

function ensureArray(value: unknown, relation: string): readonly object[] {
  if (!Array.isArray(value)) identityFailure("identity_input_invalid", relation);
  return value as readonly object[];
}

function normalizeAccounts(rows: readonly AppAccountSourceRow[], run: NormalizedRunIdentity): Map<string, NormalizedAccount> {
  const accounts = new Map<string, NormalizedAccount>();
  for (const raw of rows) {
    const row = asObject(raw, "app_accounts");
    checkRowRunIdentity(row, run, "app_accounts");
    const id = canonicalUuid(sourceCell(row, "id", "app_accounts"), "app_accounts", "id");
    const accountType = sourceCell(row, "account_type", "app_accounts");
    if (accountType !== "manual" && accountType !== "steam") {
      identityFailure("identity_impossible_account_kind", "app_accounts", "account_type");
    }
    const createdAt = timestamp(sourceCell(row, "created_at", "app_accounts"), "app_accounts", "created_at", true);
    const sourceUpdatedAt = timestamp(sourceCell(row, "updated_at", "app_accounts"), "app_accounts", "updated_at", true);
    const lastSeenAt = timestamp(nullableSourceCell(row, "last_visited_at", "app_accounts"), "app_accounts", "last_visited_at", false);
    if (!createdAt || !sourceUpdatedAt) identityFailure("identity_invalid_timestamp", "app_accounts");
    if (accounts.has(id.canonical)) identityFailure("identity_duplicate_root", "app_accounts", "id");
    accounts.set(
      id.canonical,
      {
        publicId: id.original,
        canonicalId: id.canonical,
        accountKind: accountType,
        createdAt,
        sourceUpdatedAt,
        lastSeenAt,
      },
    );
  }
  return accounts;
}

function normalizeAppUsers(rows: readonly AppUserSourceRow[], run: NormalizedRunIdentity): Map<string, NormalizedSteamProfile> {
  const users = new Map<string, NormalizedSteamProfile>();
  const verifiedSteamIds = new Map<string, string>();
  for (const raw of rows) {
    const row = asObject(raw, "app_users");
    checkRowRunIdentity(row, run, "app_users");
    const id = canonicalUuid(sourceCell(row, "id", "app_users"), "app_users", "id");
    if (users.has(id.canonical)) identityFailure("identity_duplicate_profile", "app_users", "id");
    const parsedSteamId = steamId(sourceCell(row, "steam_id", "app_users"), "app_users", "steam_id");
    const existingSteamOwner = verifiedSteamIds.get(parsedSteamId.target);
    if (existingSteamOwner !== undefined && existingSteamOwner !== id.canonical) {
      identityFailure("identity_verified_steam_collision", "app_users", "steam_id");
    }
    verifiedSteamIds.set(parsedSteamId.target, id.canonical);
    const displayName = boundedTargetText(
      nullableSourceCell(row, "display_name", "app_users"),
      "app_users",
      "display_name",
      { nullable: true, maxLength: 80, requireTrimmedContent: true },
    );
    const avatarUrl = boundedTargetText(
      nullableSourceCell(row, "avatar_url", "app_users"),
      "app_users",
      "avatar_url",
      { nullable: true, maxLength: 2048, requireTrimmedContent: false },
    );
    const createdAt = timestamp(sourceCell(row, "created_at", "app_users"), "app_users", "created_at", true);
    const updatedAt = timestamp(sourceCell(row, "updated_at", "app_users"), "app_users", "updated_at", true);
    const lastLoginAt = timestamp(nullableSourceCell(row, "last_login_at", "app_users"), "app_users", "last_login_at", false);
    if (!createdAt || !updatedAt) identityFailure("identity_invalid_timestamp", "app_users");
    users.set(id.canonical, {
      publicId: id.original,
      canonicalId: id.canonical,
      steamIdSource: parsedSteamId.source,
      steamId: parsedSteamId.target,
      displayName,
      steamDisplayName: null,
      avatarUrl,
      profileUrl: null,
      createdAt,
      updatedAt,
      sourceKind: "app_users",
      lastLoginAt,
    });
  }
  return users;
}

function normalizeManualProfiles(
  rows: readonly ManualSteamProfileSourceRow[],
  run: NormalizedRunIdentity,
): Map<string, NormalizedSteamProfile> {
  const profiles = new Map<string, NormalizedSteamProfile>();
  for (const raw of rows) {
    const row = asObject(raw, "manual_steam_profiles");
    checkRowRunIdentity(row, run, "manual_steam_profiles");
    const id = canonicalUuid(sourceCell(row, "id", "manual_steam_profiles"), "manual_steam_profiles", "id");
    if (profiles.has(id.canonical)) identityFailure("identity_duplicate_profile", "manual_steam_profiles", "id");
    const parsedSteamId = steamId(sourceCell(row, "steam_id", "manual_steam_profiles"), "manual_steam_profiles", "steam_id");
    const profileUrl = sourceCell(row, "steam_profile_url", "manual_steam_profiles");
    if (profileUrl !== `https://steamcommunity.com/profiles/${parsedSteamId.source}`) {
      identityFailure("identity_target_metadata_invalid", "manual_steam_profiles", "steam_profile_url");
    }
    const displayName = boundedTargetText(
      sourceCell(row, "display_name", "manual_steam_profiles"),
      "manual_steam_profiles",
      "display_name",
      { nullable: false, maxLength: 80, requireTrimmedContent: true },
    );
    const steamDisplayName = boundedTargetText(
      sourceCell(row, "steam_display_name", "manual_steam_profiles"),
      "manual_steam_profiles",
      "steam_display_name",
      { nullable: false, maxLength: 80, requireTrimmedContent: true },
    );
    const avatarUrl = boundedTargetText(
      nullableSourceCell(row, "avatar_url", "manual_steam_profiles"),
      "manual_steam_profiles",
      "avatar_url",
      { nullable: true, maxLength: 2048, requireTrimmedContent: false },
    );
    if (codePointLength(profileUrl) > 2048) {
      identityFailure("identity_target_metadata_invalid", "manual_steam_profiles", "steam_profile_url");
    }
    const createdAt = timestamp(sourceCell(row, "created_at", "manual_steam_profiles"), "manual_steam_profiles", "created_at", true);
    const updatedAt = timestamp(sourceCell(row, "updated_at", "manual_steam_profiles"), "manual_steam_profiles", "updated_at", true);
    if (!createdAt || !updatedAt) identityFailure("identity_invalid_timestamp", "manual_steam_profiles");
    profiles.set(id.canonical, {
      publicId: id.original,
      canonicalId: id.canonical,
      steamIdSource: parsedSteamId.source,
      steamId: parsedSteamId.target,
      displayName,
      steamDisplayName,
      avatarUrl,
      profileUrl,
      createdAt,
      updatedAt,
      sourceKind: "manual_profile",
      lastLoginAt: null,
    });
  }
  return profiles;
}

function normalizeMergeRows(rows: readonly AccountMergeSourceRow[], run: NormalizedRunIdentity): NormalizedMerge[] {
  const merges: NormalizedMerge[] = [];
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const raw of rows) {
    const row = asObject(raw, "account_merges");
    checkRowRunIdentity(row, run, "account_merges");
    const mergeId = canonicalUuid(sourceCell(row, "id", "account_merges"), "account_merges", "id");
    const sourceId = canonicalUuid(sourceCell(row, "source_account_id", "account_merges"), "account_merges", "source_account_id");
    const targetId = canonicalUuid(sourceCell(row, "target_account_id", "account_merges"), "account_merges", "target_account_id");
    if (ids.has(mergeId.canonical) || sources.has(sourceId.canonical)) {
      identityFailure("identity_duplicate_merge", "account_merges", "id");
    }
    ids.add(mergeId.canonical);
    sources.add(sourceId.canonical);
    const parsedSteamId = steamId(sourceCell(row, "verified_steam_id", "account_merges"), "account_merges", "verified_steam_id");
    const mergeMode = sourceCell(row, "merge_mode", "account_merges");
    if (mergeMode !== "promoted" && mergeMode !== "merged_existing") {
      identityFailure("identity_invalid_merge", "account_merges", "merge_mode");
    }
    if ((mergeMode === "promoted" && sourceId.canonical !== targetId.canonical) || (mergeMode === "merged_existing" && sourceId.canonical === targetId.canonical)) {
      identityFailure("identity_invalid_merge", "account_merges", "merge_mode");
    }
    const createdAt = timestamp(sourceCell(row, "created_at", "account_merges"), "account_merges", "created_at", true);
    const analyticsDeliveredAt = timestamp(nullableSourceCell(row, "analytics_delivered_at", "account_merges"), "account_merges", "analytics_delivered_at", false);
    if (!createdAt) identityFailure("identity_invalid_timestamp", "account_merges", "created_at");
    merges.push({
      mergeId: mergeId.original,
      mergeIdCanonical: mergeId.canonical,
      sourceId: sourceId.original,
      sourceCanonicalId: sourceId.canonical,
      targetId: targetId.original,
      targetCanonicalId: targetId.canonical,
      verifiedSteamIdSource: parsedSteamId.source,
      verifiedSteamId: parsedSteamId.target,
      mergeMode,
      createdAt,
      analyticsDeliveredAt,
    });
  }
  return merges;
}

function normalizeTombstones(
  rows: readonly MergeSourceTombstoneEvidence[],
  run: NormalizedRunIdentity,
): Map<string, NormalizedTombstone> {
  const tombstones = new Map<string, NormalizedTombstone>();
  for (const raw of rows) {
    const row = asObject(raw, "merge_tombstones");
    checkRowRunIdentity(row, run, "merge_tombstones");
    const mergeId = canonicalUuid(tombstoneCell(row, "merge_id"), "merge_tombstones", "merge_id");
    const sourceId = canonicalUuid(tombstoneCell(row, "source_account_id"), "merge_tombstones", "source_account_id");
    const targetId = canonicalUuid(tombstoneCell(row, "target_account_id"), "merge_tombstones", "target_account_id");
    if (tombstones.has(mergeId.canonical)) identityFailure("identity_duplicate_merge", "merge_tombstones", "merge_id");
    const verifiedSteamId = steamId(tombstoneCell(row, "verified_steam_id"), "merge_tombstones", "verified_steam_id");
    if (tombstoneCell(row, "merge_mode") !== "merged_existing") {
      identityFailure("identity_tombstone_invalid", "merge_tombstones", "merge_mode");
    }
    const sourceDeleted = (row as Record<string, unknown>).source_deleted;
    if (sourceDeleted !== true && sourceDeleted !== "true") {
      identityFailure("identity_tombstone_invalid", "merge_tombstones", "source_deleted");
    }
    if (tombstoneCell(row, "provenance") !== "account_merge_source_deleted") {
      identityFailure("identity_tombstone_invalid", "merge_tombstones", "provenance");
    }
    const meaning = tombstoneCell(row, "created_at_meaning");
    if (meaning !== "merge_observed_at" && meaning !== "source_account_created_at") {
      identityFailure("identity_tombstone_invalid", "merge_tombstones", "created_at_meaning");
    }
    const observedAtText = tombstoneCell(row, "created_at");
    const mergeObservedAt = timestamp(observedAtText, "merge_tombstones", "created_at", true);
    if (!mergeObservedAt) identityFailure("identity_invalid_timestamp", "merge_tombstones", "created_at");
    let createdAt = mergeObservedAt;
    if (meaning === "source_account_created_at") {
      const sourceCreatedAt = (row as Record<string, unknown>).source_created_at;
      if (typeof sourceCreatedAt !== "string") identityFailure("identity_tombstone_invalid", "merge_tombstones", "source_created_at");
      const parsedSourceCreatedAt = timestamp(sourceCreatedAt, "merge_tombstones", "source_created_at", true);
      if (!parsedSourceCreatedAt) identityFailure("identity_invalid_timestamp", "merge_tombstones", "source_created_at");
      createdAt = parsedSourceCreatedAt;
    }
    tombstones.set(mergeId.canonical, {
      mergeId: mergeId.original,
      mergeIdCanonical: mergeId.canonical,
      sourceId: sourceId.original,
      sourceCanonicalId: sourceId.canonical,
      targetId: targetId.original,
      targetCanonicalId: targetId.canonical,
      verifiedSteamIdSource: verifiedSteamId.source,
      verifiedSteamId: verifiedSteamId.target,
      mergeObservedAt,
      createdAt,
      createdAtMeaning: meaning,
    });
  }
  return tombstones;
}

function compareCandidate(left: Candidate, right: Candidate): number {
  const byTime = comparePgTimestamps(left.createdAt, right.createdAt);
  if (byTime !== 0) return byTime;
  return left.canonicalId < right.canonicalId ? -1 : left.canonicalId > right.canonicalId ? 1 : 0;
}

function compareMerge(left: NormalizedMerge, right: NormalizedMerge): number {
  return left.mergeIdCanonical < right.mergeIdCanonical ? -1 : left.mergeIdCanonical > right.mergeIdCanonical ? 1 : 0;
}

function freezeResult(result: {
  run_identity: { run_id: string; snapshot_hash: string };
  accounts: AccountTargetRecord[];
  steam_profiles: SteamProfileTargetRecord[];
  account_map: AccountMapTargetRecord[];
  merge_evidence: MergeEvidenceRecord[];
}): IdentityTransformResult {
  return Object.freeze({
    run_identity: Object.freeze(result.run_identity),
    accounts: Object.freeze(result.accounts),
    steam_profiles: Object.freeze(result.steam_profiles),
    account_map: Object.freeze(result.account_map),
    merge_evidence: Object.freeze(result.merge_evidence),
  });
}

/**
 * Convert the complete account/profile union into deterministic target rows.
 * This function is pure: it performs no filesystem, database, network or
 * target writes.  The caller supplies one verified run identity and may bound
 * the complete account-sized working set with `maxAccounts`.
 */
export function transformIdentityBatch(
  input: IdentityTransformInput,
  options: IdentityTransformOptions = {},
): IdentityTransformResult {
  const root = asObject(input, "identity_input");
  const run = validateRunIdentity(root.runIdentity);
  const maxAccounts = options.maxAccounts ?? 1_000_000;
  if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > Number(TARGET_INTEGER_MAX)) {
    identityFailure("identity_account_count_limit", "identity_input", "maxAccounts");
  }
  const accountRows = ensureArray(root.appAccounts, "app_accounts") as readonly AppAccountSourceRow[];
  const userRows = ensureArray(root.appUsers, "app_users") as readonly AppUserSourceRow[];
  const manualRows = ensureArray(root.manualSteamProfiles, "manual_steam_profiles") as readonly ManualSteamProfileSourceRow[];
  const mergeRows = root.accountMerges === undefined ? [] : ensureArray(root.accountMerges, "account_merges") as readonly AccountMergeSourceRow[];
  const tombstoneRows = root.mergeTombstones === undefined ? [] : ensureArray(root.mergeTombstones, "merge_tombstones") as readonly MergeSourceTombstoneEvidence[];

  // Refuse an obviously oversized input before allocating normalized maps.  The
  // union check below remains authoritative for duplicate source IDs.
  if (
    accountRows.length > maxAccounts ||
    userRows.length > maxAccounts ||
    manualRows.length > maxAccounts ||
    mergeRows.length > maxAccounts ||
    tombstoneRows.length > maxAccounts ||
    accountRows.length + tombstoneRows.length > maxAccounts
  ) {
    identityFailure("identity_account_count_limit", "identity_input", "maxAccounts");
  }

  const accounts = normalizeAccounts(accountRows, run);
  const users = normalizeAppUsers(userRows, run);
  const manualProfiles = normalizeManualProfiles(manualRows, run);
  const merges = normalizeMergeRows(mergeRows, run);
  const tombstones = normalizeTombstones(tombstoneRows, run);

  for (const [id] of accounts) {
    if (users.has(id) && manualProfiles.has(id)) identityFailure("identity_duplicate_profile", "identity_union", "id");
  }
  for (const [id] of users) {
    const account = accounts.get(id);
    if (!account) identityFailure("identity_unmatched_profile", "app_users", "id");
    if (account.accountKind !== "steam") identityFailure("identity_impossible_account_kind", "app_users", "id");
  }
  for (const [id] of manualProfiles) {
    const account = accounts.get(id);
    if (!account) identityFailure("identity_unmatched_profile", "manual_steam_profiles", "id");
    if (account.accountKind !== "manual") identityFailure("identity_impossible_account_kind", "manual_steam_profiles", "id");
  }
  for (const [id, account] of accounts) {
    if (account.accountKind === "steam" && !users.has(id)) identityFailure("identity_steam_profile_missing", "app_accounts", "id");
  }

  const candidates = [...accounts.values()].map((account): Candidate => ({
    publicId: account.publicId,
    canonicalId: account.canonicalId,
    accountKind: account.accountKind,
    lifecycleStatus: "active",
    createdAt: account.createdAt,
    creationTimeMeaning: "source_account_created_at",
    sourceAccount: account,
    tombstone: null,
  }));
  const candidateById = new Map(candidates.map((candidate) => [candidate.canonicalId, candidate]));

  const mergeById = new Map(merges.map((merge) => [merge.mergeIdCanonical, merge]));
  for (const merge of merges) {
    const target = accounts.get(merge.targetCanonicalId);
    if (!target) identityFailure("identity_merge_target_missing", "account_merges", "target_account_id");
    const targetUser = users.get(merge.targetCanonicalId);
    if (!targetUser || target.accountKind !== "steam" || targetUser.steamId !== merge.verifiedSteamId) {
      identityFailure("identity_merge_steam_conflict", "account_merges", "verified_steam_id");
    }
    const source = accounts.get(merge.sourceCanonicalId);
    const evidence = tombstones.get(merge.mergeIdCanonical);
    if (merge.mergeMode === "promoted") {
      if (!source || !users.has(merge.sourceCanonicalId) || source.accountKind !== "steam") {
        identityFailure("identity_invalid_merge", "account_merges", "source_account_id");
      }
      if (evidence) identityFailure("identity_tombstone_unneeded", "merge_tombstones", "merge_id");
      const promotedUser = users.get(merge.sourceCanonicalId);
      if (!promotedUser || promotedUser.steamId !== merge.verifiedSteamId) {
        identityFailure("identity_merge_steam_conflict", "account_merges", "verified_steam_id");
      }
      continue;
    }
    if (source) {
      if (source.accountKind !== "manual" || evidence) {
        identityFailure(evidence ? "identity_tombstone_unneeded" : "identity_invalid_merge", evidence ? "merge_tombstones" : "account_merges", evidence ? "merge_id" : "source_account_id");
      }
      const sourceProfile = manualProfiles.get(merge.sourceCanonicalId);
      if (sourceProfile && sourceProfile.steamId !== merge.verifiedSteamId) {
        identityFailure("identity_merge_steam_conflict", "account_merges", "verified_steam_id");
      }
      continue;
    }
    if (!evidence) identityFailure("identity_tombstone_required", "account_merges", "source_account_id");
    if (
      evidence.sourceCanonicalId !== merge.sourceCanonicalId ||
      evidence.targetCanonicalId !== merge.targetCanonicalId ||
      evidence.verifiedSteamId !== merge.verifiedSteamId ||
      evidence.mergeIdCanonical !== merge.mergeIdCanonical
    ) {
      identityFailure("identity_tombstone_unproven", "merge_tombstones", "merge_id");
    }
    if (evidence.mergeObservedAt.epochMicros !== merge.createdAt.epochMicros) {
      identityFailure("identity_tombstone_unproven", "merge_tombstones", "created_at");
    }
    if (!candidateById.has(merge.sourceCanonicalId)) {
      const tombstoneAccount: NormalizedAccount = {
        publicId: evidence.sourceId,
        canonicalId: evidence.sourceCanonicalId,
        accountKind: "manual",
        createdAt: evidence.createdAt,
        sourceUpdatedAt: evidence.createdAt,
        lastSeenAt: null,
      };
      const candidate: Candidate = {
        publicId: evidence.sourceId,
        canonicalId: evidence.sourceCanonicalId,
        accountKind: "manual",
        lifecycleStatus: "deleted",
        createdAt: evidence.createdAt,
        creationTimeMeaning: evidence.createdAtMeaning,
        sourceAccount: tombstoneAccount,
        tombstone: evidence,
      };
      candidates.push(candidate);
      candidateById.set(candidate.canonicalId, candidate);
    }
  }
  for (const [mergeId] of tombstones) {
    if (!mergeById.has(mergeId)) identityFailure("identity_tombstone_unproven", "merge_tombstones", "merge_id");
  }
  if (candidates.length > maxAccounts) identityFailure("identity_account_count_limit", "identity_input", "maxAccounts");
  if (candidates.length > Number(TARGET_INTEGER_MAX)) identityFailure("identity_account_id_overflow", "identity_union", "id");

  candidates.sort(compareCandidate);
  const accountIdByPublicId = new Map<string, number>();
  candidates.forEach((candidate, index) => accountIdByPublicId.set(candidate.canonicalId, index + 1));

  const outputAccounts: AccountTargetRecord[] = [];
  const outputProfiles: SteamProfileTargetRecord[] = [];
  const outputMap: AccountMapTargetRecord[] = [];
  for (const candidate of candidates) {
    const accountId = accountIdByPublicId.get(candidate.canonicalId);
    if (accountId === undefined || accountId < 1 || accountId > Number(TARGET_INTEGER_MAX)) {
      identityFailure("identity_account_id_overflow", "identity_union", "id");
    }
    const sourceAccount = candidate.sourceAccount;
    const sourceUser = users.get(candidate.canonicalId);
    const sourceManualProfile = manualProfiles.get(candidate.canonicalId);
    const accountRecord: AccountTargetRecord = {
      id: accountId,
      public_id: candidate.publicId,
      account_kind: candidate.accountKind,
      lifecycle_status: candidate.lifecycleStatus,
      display_name: null,
      created_at: candidate.createdAt,
      last_seen_at: candidate.lifecycleStatus === "deleted" ? null : sourceAccount?.lastSeenAt ?? null,
      library_revision: "0",
      state_revision: "0",
      locale: null,
      store_country: null,
      currency: null,
      last_login_at: candidate.lifecycleStatus === "deleted" ? null : sourceUser?.lastLoginAt ?? null,
      ...(candidate.tombstone
        ? {
            tombstone: Object.freeze({
              merge_id: candidate.tombstone.mergeId,
              source_deleted: true as const,
              verified: false as const,
              created_at_meaning: candidate.tombstone.createdAtMeaning,
            }),
          }
        : {}),
    };
    outputAccounts.push(Object.freeze(accountRecord));
    outputMap.push(
      Object.freeze({
        legacy_id: candidate.publicId,
        account_id: accountId,
        source_kind: candidate.tombstone ? "unknown" : "app_accounts",
        source_snapshot_hash: run.snapshotHash,
      }),
    );

    const sourceProfile = sourceUser ?? sourceManualProfile;
    if (sourceProfile && candidate.lifecycleStatus === "active") {
      outputProfiles.push(
        Object.freeze({
          account_id: accountId,
          steam_id: sourceProfile.steamId,
          steam_id_source: sourceProfile.steamIdSource,
          verified: sourceProfile.sourceKind === "app_users",
          display_name: sourceProfile.displayName,
          steam_display_name: sourceProfile.steamDisplayName,
          avatar_url: sourceProfile.avatarUrl,
          profile_url: sourceProfile.profileUrl,
          created_at: sourceProfile.createdAt,
          updated_at: sourceProfile.updatedAt,
          source_kind: sourceProfile.sourceKind,
        }),
      );
    }
  }

  const outputMergeEvidence: MergeEvidenceRecord[] = [];
  for (const merge of [...merges].sort(compareMerge)) {
    const sourceAccountId = accountIdByPublicId.get(merge.sourceCanonicalId);
    const targetAccountId = accountIdByPublicId.get(merge.targetCanonicalId);
    if (sourceAccountId === undefined || targetAccountId === undefined) {
      identityFailure("identity_physical_gap", "account_merges", "source_account_id");
    }
    outputMergeEvidence.push(
      Object.freeze({
        legacy_merge_id: merge.mergeId,
        source_public_id: merge.sourceId,
        target_public_id: merge.targetId,
        verified_steam_id: merge.verifiedSteamId,
        verified_steam_id_source: merge.verifiedSteamIdSource,
        merge_mode: merge.mergeMode,
        created_at: merge.createdAt,
        analytics_delivered_at: merge.analyticsDeliveredAt,
        source_tombstone_present: candidateById.get(merge.sourceCanonicalId)?.tombstone !== null && candidateById.get(merge.sourceCanonicalId)?.tombstone !== undefined,
        source_tombstone_account_id: candidateById.get(merge.sourceCanonicalId)?.tombstone ? sourceAccountId : null,
      }),
    );
  }

  return freezeResult({
    run_identity: { run_id: run.runId, snapshot_hash: run.snapshotHash },
    accounts: outputAccounts,
    steam_profiles: outputProfiles,
    account_map: outputMap,
    merge_evidence: outputMergeEvidence,
  });
}

export const transformAccounts = transformIdentityBatch;

/** Make comparisons in tests and reports independent of object insertion order. */
export function canonicalIdentityResult(result: IdentityTransformResult): string {
  const canonical = {
    run_identity: result.run_identity,
    accounts: [...result.accounts].sort((left, right) => left.id - right.id),
    steam_profiles: [...result.steam_profiles].sort((left, right) => left.account_id - right.account_id),
    account_map: [...result.account_map].sort((left, right) => left.account_id - right.account_id),
    merge_evidence: [...result.merge_evidence].sort((left, right) => (left.legacy_merge_id < right.legacy_merge_id ? -1 : left.legacy_merge_id > right.legacy_merge_id ? 1 : 0)),
  };
  return JSON.stringify(canonical);
}
