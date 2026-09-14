import { type PgTimestamp } from "./scalars.ts";
import {
  asObject,
  canonicalUuid,
  checkRowLimit,
  checkRowRunIdentity,
  codePointLength,
  compareBigints,
  compareText,
  ConflictCollector,
  enumValue,
  ensureArray,
  indexAccountMap,
  jsonbUpperBoundBytes,
  libraryFailure,
  nullableSourceCell,
  optionalTimestamp,
  parsePgIntegerArray,
  pgBtrim,
  requiredInteger,
  requiredTimestamp,
  sourceCell,
  steamAccountId,
  steamAppId,
  STEAM_APP_ID_MAX,
  STEAM_APP_ID_MIN,
  TARGET_INTEGER_MAX,
  validateRunIdentity,
  type ConflictRecord,
  type LibraryCell,
  type LibraryRunIdentity,
} from "./library-shared.ts";
import type { FamilyAccessCandidate, ObservedInstantStatus } from "./library.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Steam Family lenders and the access they confer.
 *
 * Two rules dominate this module. A member row is never synthesised to make an
 * access row fit: legacy `user_games.family_owner_steam_id` has no foreign key,
 * so a lender that no longer exists produces orphan evidence that confers
 * nothing. And a lender's own playtime never becomes the account's playtime:
 * `app.family_game_access` carries no minutes at all, and this module writes
 * none.
 *
 * Simultaneous lenders are preserved: every member row and every member's
 * candidate AppID snapshot survives, and two members listing the same AppID are
 * never merged. Candidacy is not access, so a candidate AppID never creates an
 * `app.family_game_access` row on its own.
 */

const MEMBER_RELATION = "user_family_members";
const ACCESS_RELATION = "user_games";

const ZERO = BigInt(0);
/** `app.family_members` bounds from M1 plus the M3 lender columns. */
const MAX_CANDIDATE_ELEMENTS = 10_000;
const MAX_CANDIDATE_JSONB_BYTES = 262_144;
/** Conservative per-element JSONB upper bound (JEntry plus aligned numeric). */
const CANDIDATE_JSONB_BYTES_PER_ELEMENT = 24;
const CANDIDATE_JSONB_BYTES_OVERHEAD = 8;
/**
 * `app.family_members.display_name` is checked as
 * `length(btrim(display_name)) between 1 and 200`, so the bound is measured on
 * the trimmed text while the stored value stays the verbatim source.
 */
const MAX_DISPLAY_NAME_BTRIM_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_MEMBER_LAST_ERROR_LENGTH = 2_000;
const MAX_EVIDENCE_LAST_ERROR_LENGTH = 20_000;
/** Raw lender links/display text must fit the bounded evidence JSONB copy. */
const MAX_EVIDENCE_MEMBER_TEXT_LENGTH = 20_000;
/** Both evidence relations bound their payload at `pg_column_size <= 32768`. */
const MAX_EVIDENCE_JSONB_BYTES = 32_768;
/** `app.enforce_family_member_limit` rejects an insert once five rows exist. */
export const FAMILY_MEMBER_CAP = 5;
const DEFAULT_MAX_ROWS = 1_000_000;

export type FamilyMemberSourceRow = Readonly<{
  id: LibraryCell;
  user_id: LibraryCell;
  steam_id: LibraryCell;
  display_name: LibraryCell;
  avatar_url: LibraryCell;
  profile_url: LibraryCell;
  candidate_appids: LibraryCell;
  library_seen: LibraryCell;
  games_imported: LibraryCell;
  last_synced_at: LibraryCell;
  last_error: LibraryCell;
  created_at: LibraryCell;
  updated_at: LibraryCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export type FamilyErrorStatus = "private" | "error" | "ok" | "unknown";
export type CapStatus = "within_cap" | "over_cap";
export type CandidateCapStatus = "within_cap" | "over_cap";

/** `app.family_members`, including every M3 lender column. */
export type FamilyMemberRecord = Readonly<{
  id: number;
  account_id: number;
  /** Exact source text for the checked text-to-bigint conversion. */
  steam_id: string;
  candidate_app_ids: readonly number[];
  candidate_count: number;
  checked_at: PgTimestamp | null;
  error_status: FamilyErrorStatus;
  legacy_member_id: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  legacy_library_seen: number | null;
  legacy_games_imported: number | null;
  last_synced_at: PgTimestamp | null;
  last_error: string | null;
  /** Transform evidence: the row exceeds the M1 five-member trigger cap. */
  cap_status: CapStatus;
  /** Transform evidence: the candidate array exceeds the M1 10000 cap. */
  candidate_cap_status: CandidateCapStatus;
  /** Proven JSONB upper bound for the candidate array. */
  candidate_jsonb_bytes_upper_bound: number;
}>;

/** `migration.legacy_family_member_evidence`. Bounded staging. */
export type LegacyFamilyMemberEvidenceRecord = Readonly<{
  legacy_member_id: string;
  account_id: number;
  steam_id: string;
  created_at: PgTimestamp;
  raw_last_error: string | null;
  raw_library_seen: number | null;
  raw_games_imported: number | null;
  source_snapshot_hash: string;
  retention_class: "staging-30d-post-cutover";
  evidence: Readonly<Record<string, string | number | boolean>>;
}>;

/** `app.family_game_access`. Resolved lender access only. */
export type FamilyGameAccessRecord = Readonly<{
  account_id: number;
  member_id: number;
  game_id: number;
  observed_at: PgTimestamp | null;
  observed_at_status: ObservedInstantStatus;
  provenance: "verified" | "inferred";
}>;

/**
 * `app.family_access_orphans`. Durable account-domain quarantine evidence.
 *
 * `disposition = 'retired'` (root's 11 September follow-up, requires the
 * paired proposal migration) is a resolved lender whose access the source
 * explicitly ended -- `supabase/migrations/20260901193000_share_a_family_library.sql:
 * 237-280` (`remove_user_family_member_games`) rewrites an engaged row to
 * `ownership='Wishlist'` while leaving `access_source='family'` and
 * `family_owner_steam_id` intact, rather than deleting or restoring it. This
 * is not the `'quarantine'` case (unresolved/malformed lender identity): the
 * lender is known; the source revoked the access anyway. `confers_access`
 * stays `false` either way.
 */
export type FamilyAccessOrphanRecord = Readonly<{
  account_id: number;
  game_id: number;
  steam_app_id: string;
  lender_steam_id: string | null;
  observed_at: PgTimestamp | null;
  disposition: "quarantine" | "retired";
  confers_access: false;
  source_snapshot_hash: string;
}>;

/** `migration.legacy_family_access_orphans`. Bounded staging. */
export type LegacyFamilyAccessOrphanRecord = Readonly<{
  account_id: number;
  source_user_id: string;
  source_member_id: null;
  source_steam_id: string | null;
  steam_appid: string;
  observed_at: PgTimestamp | null;
  raw_games_imported: null;
  disposition: "quarantine" | "retired";
  source_snapshot_hash: string;
  evidence: Readonly<Record<string, string | number | boolean>>;
}>;

export type FamilyTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  family_members: readonly FamilyMemberRecord[];
  legacy_family_member_evidence: readonly LegacyFamilyMemberEvidenceRecord[];
  family_game_access: readonly FamilyGameAccessRecord[];
  family_access_orphans: readonly FamilyAccessOrphanRecord[];
  legacy_family_access_orphans: readonly LegacyFamilyAccessOrphanRecord[];
  conflicts: readonly ConflictRecord[];
}>;

export type FamilyTransformInput = Readonly<{
  runIdentity: LibraryRunIdentity;
  accountMap: readonly AccountMapTargetRecord[];
  familyMembers: readonly FamilyMemberSourceRow[];
  /** Access facts banked by the library transform; never re-derived here. */
  familyAccessCandidates: readonly FamilyAccessCandidate[];
}>;

export type FamilyTransformOptions = Readonly<{ maxRows?: number }>;

/**
 * A privacy refusal is recognised only by an explicit word in the lender sync
 * error. Everything else that is nonempty is an error, which is the direction
 * that under-claims rather than over-claims.
 */
const PRIVACY_REFUSAL = /\b(?:private|privacy)\b/i;

function classifyError(lastError: string | null, lastSyncedAt: PgTimestamp | null): FamilyErrorStatus {
  if (lastError === null || pgBtrim(lastError).length === 0) {
    return lastSyncedAt === null ? "unknown" : "ok";
  }
  return PRIVACY_REFUSAL.test(lastError) ? "private" : "error";
}

type NormalizedMember = {
  legacyId: string;
  legacyIdCanonical: string;
  sourceUserId: string;
  accountId: number;
  steamIdText: string;
  steamId: bigint;
  candidates: readonly bigint[];
  librarySeen: bigint;
  gamesImported: bigint;
  displayNameRaw: string;
  displayName: string | null;
  avatarUrlRaw: string | null;
  avatarUrl: string | null;
  profileUrlRaw: string | null;
  profileUrl: string | null;
  lastSyncedAt: PgTimestamp | null;
  lastErrorRaw: string | null;
  lastErrorForMember: string | null;
  createdAt: PgTimestamp;
  updatedAt: PgTimestamp;
  errorStatus: FamilyErrorStatus;
  candidateCapStatus: CandidateCapStatus;
};

/**
 * A bounded compact text column whose target check is on the trimmed length.
 * The stored value stays the verbatim source; only the bound is measured after
 * `btrim`, so a value the target accepts is not rejected here.
 */
function boundedText(
  value: string | null,
  maxBtrimLength: number,
  relation: string,
  field: string,
  conflicts: ConflictCollector,
  destination: string,
): string | null {
  if (value === null) return null;
  if (pgBtrim(value).length === 0) {
    conflicts.record({
      conflict_class: "family_member_text_empty",
      source_relation: relation,
      source_column: field,
      decision:
        "A whitespace-only lender text cannot satisfy the target btrim check and carries no display value; stored as NULL and counted.",
      details: { status: "resolved", destination },
    });
    return null;
  }
  if (codePointLength(pgBtrim(value)) > maxBtrimLength) {
    // Truncation would silently change a lender's identity or link, so the
    // target column stays NULL and the full text stays in staging evidence.
    conflicts.record({
      conflict_class: "family_member_text_over_length",
      source_relation: relation,
      source_column: field,
      decision:
        "UNRESOLVED for root: the source text exceeds the target bound. It is never truncated; the compact column is left NULL and the raw text remains in migration.legacy_family_member_evidence.",
      details: { status: "unresolved", destination },
    });
    return null;
  }
  return value;
}

/** URL/profile fields have no btrim check; preserve whitespace exactly. */
function boundedUrl(
  value: string | null,
  maxLength: number,
  relation: string,
  field: string,
  conflicts: ConflictCollector,
  destination: string,
): string | null {
  if (value === null) return null;
  if (codePointLength(value) > maxLength) {
    conflicts.record({
      conflict_class: "family_member_text_over_length",
      source_relation: relation,
      source_column: field,
      decision:
        "UNRESOLVED for root: the source URL exceeds the target bound. It is never truncated; the compact column is left NULL and the raw URL remains in migration.legacy_family_member_evidence.",
      details: { status: "unresolved", destination },
    });
    return null;
  }
  return value;
}

function validateEvidenceText(value: string | null, field: string): void {
  if (value !== null && codePointLength(value) > MAX_EVIDENCE_MEMBER_TEXT_LENGTH) {
    libraryFailure("library_unrepresentable_value", MEMBER_RELATION, field);
  }
}

function normalizeMember(
  raw: FamilyMemberSourceRow,
  run: LibraryRunIdentity,
  accountLookup: (legacyId: string) => number,
  conflicts: ConflictCollector,
): NormalizedMember {
  const row = asObject(raw, MEMBER_RELATION);
  checkRowRunIdentity(row, run, MEMBER_RELATION);
  const legacyId = canonicalUuid(sourceCell(row, "id", MEMBER_RELATION), MEMBER_RELATION, "id");
  const sourceUserId = canonicalUuid(sourceCell(row, "user_id", MEMBER_RELATION), MEMBER_RELATION, "user_id");
  const accountId = accountLookup(sourceUserId.original);
  const steamId = steamAccountId(sourceCell(row, "steam_id", MEMBER_RELATION), MEMBER_RELATION, "steam_id");

  const candidates = parsePgIntegerArray(
    sourceCell(row, "candidate_appids", MEMBER_RELATION),
    MEMBER_RELATION,
    "candidate_appids",
    { min: STEAM_APP_ID_MIN, max: STEAM_APP_ID_MAX },
    // Parsing is bounded well above the target cap so an over-cap array is a
    // reported conflict rather than a truncated array or an unbounded read.
    MAX_CANDIDATE_ELEMENTS * 10,
  );
  let candidateCapStatus: CandidateCapStatus = "within_cap";
  if (candidates.length > MAX_CANDIDATE_ELEMENTS) {
    candidateCapStatus = "over_cap";
    conflicts.record({
      conflict_class: "family_candidate_array_over_cap",
      source_relation: MEMBER_RELATION,
      source_column: "candidate_appids",
      decision:
        "UNRESOLVED for root: the candidate AppID array exceeds the M1 10000-element cap. The array is preserved whole and never truncated; the row cannot be inserted until the cap decision is recorded.",
      details: { status: "unresolved", destination: "app.family_members" },
    });
  }

  const librarySeen = requiredInteger(sourceCell(row, "library_seen", MEMBER_RELATION), MEMBER_RELATION, "library_seen", {
    min: ZERO,
    max: TARGET_INTEGER_MAX,
  });
  const gamesImported = requiredInteger(
    sourceCell(row, "games_imported", MEMBER_RELATION),
    MEMBER_RELATION,
    "games_imported",
    { min: ZERO, max: TARGET_INTEGER_MAX },
  );
  if (librarySeen !== BigInt(candidates.length)) {
    conflicts.record({
      conflict_class: "family_library_seen_vs_candidates",
      source_relation: MEMBER_RELATION,
      source_column: "library_seen",
      decision:
        "Legacy library_seen is the lender's observed library size and disagrees with the candidate array length. app.family_members.candidate_count is set from the array it describes and the raw library_seen is preserved in legacy_library_seen; neither value is clamped.",
      details: { status: "resolved" },
    });
  }

  const lastSyncedAt = optionalTimestamp(
    nullableSourceCell(row, "last_synced_at", MEMBER_RELATION),
    MEMBER_RELATION,
    "last_synced_at",
  );
  const lastErrorRaw = nullableSourceCell(row, "last_error", MEMBER_RELATION);
  if (lastErrorRaw !== null && codePointLength(lastErrorRaw) > MAX_EVIDENCE_LAST_ERROR_LENGTH) {
    libraryFailure("library_unrepresentable_value", MEMBER_RELATION, "last_error");
  }
  let lastErrorForMember: string | null = null;
  if (lastErrorRaw !== null && pgBtrim(lastErrorRaw).length > 0) {
    if (codePointLength(lastErrorRaw) > MAX_MEMBER_LAST_ERROR_LENGTH) {
      conflicts.record({
        conflict_class: "family_last_error_over_length",
        source_relation: MEMBER_RELATION,
        source_column: "last_error",
        decision:
          "The raw sync error exceeds the 2000-character compact bound and is never truncated. It stays in migration.legacy_family_member_evidence.raw_last_error and the compact column is NULL; error_status still records that a failure occurred.",
        details: { status: "resolved" },
      });
    } else {
      lastErrorForMember = lastErrorRaw;
    }
  }

  const displayNameRaw = sourceCell(row, "display_name", MEMBER_RELATION);
  const avatarUrlRaw = nullableSourceCell(row, "avatar_url", MEMBER_RELATION);
  const profileUrlRaw = nullableSourceCell(row, "profile_url", MEMBER_RELATION);
  validateEvidenceText(displayNameRaw, "display_name");
  validateEvidenceText(avatarUrlRaw, "avatar_url");
  validateEvidenceText(profileUrlRaw, "profile_url");

  return {
    legacyId: legacyId.original,
    legacyIdCanonical: legacyId.canonical,
    sourceUserId: sourceUserId.original,
    accountId,
    steamIdText: steamId.source,
    steamId: steamId.target,
    candidates,
    librarySeen,
    gamesImported,
    displayNameRaw,
    displayName: boundedText(
      displayNameRaw,
      MAX_DISPLAY_NAME_BTRIM_LENGTH,
      MEMBER_RELATION,
      "display_name",
      conflicts,
      "app.family_members.display_name",
    ),
    avatarUrlRaw,
    avatarUrl: boundedUrl(
      avatarUrlRaw,
      MAX_URL_LENGTH,
      MEMBER_RELATION,
      "avatar_url",
      conflicts,
      "app.family_members.avatar_url",
    ),
    profileUrlRaw,
    profileUrl: boundedUrl(
      profileUrlRaw,
      MAX_URL_LENGTH,
      MEMBER_RELATION,
      "profile_url",
      conflicts,
      "app.family_members.profile_url",
    ),
    lastSyncedAt,
    lastErrorRaw,
    lastErrorForMember,
    createdAt: requiredTimestamp(sourceCell(row, "created_at", MEMBER_RELATION), MEMBER_RELATION, "created_at"),
    updatedAt: requiredTimestamp(sourceCell(row, "updated_at", MEMBER_RELATION), MEMBER_RELATION, "updated_at"),
    errorStatus: classifyError(lastErrorRaw, lastSyncedAt),
    candidateCapStatus,
  };
}

function candidateTimestamp(value: unknown, field: string): PgTimestamp | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, field);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.epochMicros !== "bigint" ||
    typeof candidate.epochMicrosText !== "string" ||
    typeof candidate.canonicalUtc !== "string" ||
    typeof candidate.sourceText !== "string" ||
    typeof candidate.toJSON !== "function"
  ) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, field);
  }
  if (candidate.epochMicrosText !== candidate.epochMicros.toString(10)) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, field);
  }
  const parsed = optionalTimestamp(candidate.sourceText, ACCESS_RELATION, field);
  if (
    parsed === null ||
    parsed.epochMicros !== candidate.epochMicros ||
    parsed.epochMicrosText !== candidate.epochMicrosText ||
    parsed.canonicalUtc !== candidate.canonicalUtc
  ) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, field);
  }
  return value as PgTimestamp;
}

/** Validate the library-to-family hand-off before sorting or joining it. */
function validateAccessCandidate(
  raw: unknown,
  run: LibraryRunIdentity,
  accounts: ReturnType<typeof indexAccountMap>,
): FamilyAccessCandidate {
  const candidate = asObject(raw, ACCESS_RELATION);
  const legacyRowId = canonicalUuid(candidate.legacy_row_id as string, ACCESS_RELATION, "legacy_row_id");
  const sourceUserId = canonicalUuid(candidate.source_user_id as string, ACCESS_RELATION, "source_user_id");
  if (
    typeof candidate.account_id !== "number" ||
    !Number.isSafeInteger(candidate.account_id) ||
    candidate.account_id < 1 ||
    !accounts.hasTarget(candidate.account_id)
  ) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "account_id");
  }
  if (accounts.lookup(sourceUserId.original) !== candidate.account_id) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "source_user_id");
  }
  if (typeof candidate.steam_app_id !== "string") {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "steam_app_id");
  }
  const appId = steamAppId(candidate.steam_app_id, ACCESS_RELATION, "steam_app_id");
  if (
    typeof candidate.game_id !== "number" ||
    !Number.isSafeInteger(candidate.game_id) ||
    candidate.game_id < 1 ||
    BigInt(candidate.game_id) > TARGET_INTEGER_MAX
  ) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "game_id");
  }
  if (typeof candidate.source_snapshot_hash !== "string") {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "source_snapshot_hash");
  }
  if (candidate.source_snapshot_hash !== run.snapshotHash) {
    libraryFailure("library_mixed_run_identity", ACCESS_RELATION, "source_snapshot_hash");
  }

  if (candidate.lender_steam_id !== null && typeof candidate.lender_steam_id !== "string") {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "lender_steam_id");
  }
  if (candidate.lender_steam_id_raw !== null && typeof candidate.lender_steam_id_raw !== "string") {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "lender_steam_id_raw");
  }
  const lenderStatus = enumValue(
    candidate.lender_steam_id_status as string,
    ["source", "missing", "malformed"] as const,
    ACCESS_RELATION,
    "lender_steam_id_status",
  );
  if (lenderStatus === "source") {
    if (candidate.lender_steam_id === null || candidate.lender_steam_id_raw !== null) {
      libraryFailure("library_input_invalid", ACCESS_RELATION, "lender_steam_id");
    }
    steamAccountId(candidate.lender_steam_id, ACCESS_RELATION, "lender_steam_id");
  } else if (lenderStatus === "missing") {
    if (candidate.lender_steam_id !== null || candidate.lender_steam_id_raw !== null) {
      libraryFailure("library_input_invalid", ACCESS_RELATION, "lender_steam_id");
    }
  } else {
    if (candidate.lender_steam_id !== null || candidate.lender_steam_id_raw === null) {
      libraryFailure("library_input_invalid", ACCESS_RELATION, "lender_steam_id_raw");
    }
    validateEvidenceText(candidate.lender_steam_id_raw, "lender_steam_id_raw");
  }

  const provenance = enumValue(
    candidate.provenance as string,
    ["verified", "inferred"] as const,
    ACCESS_RELATION,
    "provenance",
  );
  const observedAtStatus = enumValue(
    candidate.observed_at_status as string,
    ["source", "unprovable_source_instant"] as const,
    ACCESS_RELATION,
    "observed_at_status",
  );
  const observedAt = candidateTimestamp(candidate.observed_at, "observed_at");
  if (observedAtStatus === "source" && observedAt === null) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "observed_at");
  }
  if (observedAtStatus === "unprovable_source_instant" && observedAt !== null) {
    libraryFailure("library_input_invalid", ACCESS_RELATION, "observed_at_status");
  }
  const ownership = enumValue(
    candidate.ownership as string,
    ["Owned", "Wishlist"] as const,
    ACCESS_RELATION,
    "ownership",
  );

  return Object.freeze({
    legacy_row_id: legacyRowId.original,
    source_user_id: sourceUserId.original,
    account_id: candidate.account_id,
    game_id: candidate.game_id,
    steam_app_id: appId.source,
    lender_steam_id: candidate.lender_steam_id as string | null,
    lender_steam_id_status: lenderStatus,
    lender_steam_id_raw: candidate.lender_steam_id_raw as string | null,
    provenance,
    observed_at: observedAt,
    observed_at_status: observedAtStatus,
    ownership,
    source_snapshot_hash: run.snapshotHash,
  });
}

function compareMembers(left: NormalizedMember, right: NormalizedMember): number {
  if (left.accountId !== right.accountId) return left.accountId - right.accountId;
  return compareBigints(left.steamId, right.steamId);
}

/**
 * Convert lenders and the library's family access facts into deterministic
 * target records. Pure: no filesystem, database, network or target write, and
 * no wall clock.
 */
export function transformFamilyBatch(
  input: FamilyTransformInput,
  options: FamilyTransformOptions = {},
): FamilyTransformResult {
  const root = asObject(input, "family_input");
  const run = validateRunIdentity(root.runIdentity);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const accounts = indexAccountMap(root.accountMap, run);
  const memberRows = ensureArray(root.familyMembers, MEMBER_RELATION) as readonly FamilyMemberSourceRow[];
  checkRowLimit(memberRows, MEMBER_RELATION, maxRows);
  const candidates = ensureArray(root.familyAccessCandidates, ACCESS_RELATION) as readonly FamilyAccessCandidate[];
  checkRowLimit(candidates, ACCESS_RELATION, maxRows);

  const conflicts = new ConflictCollector();
  const normalized: NormalizedMember[] = [];
  const seenLegacyIds = new Set<string>();
  const seenAccountSteam = new Set<string>();
  for (const raw of memberRows) {
    const member = normalizeMember(raw, run, accounts.lookup, conflicts);
    if (seenLegacyIds.has(member.legacyIdCanonical)) {
      libraryFailure("library_duplicate_identity", MEMBER_RELATION, "id");
    }
    seenLegacyIds.add(member.legacyIdCanonical);
    const key = `${member.accountId}:${member.steamIdText}`;
    if (seenAccountSteam.has(key)) libraryFailure("library_duplicate_identity", MEMBER_RELATION, "steam_id");
    seenAccountSteam.add(key);
    normalized.push(member);
  }

  normalized.sort(compareMembers);

  const validatedCandidates = candidates.map((candidate) => validateAccessCandidate(candidate, run, accounts));

  const memberIdByKey = new Map<string, number>();
  const perAccountIndex = new Map<number, number>();
  const members: FamilyMemberRecord[] = [];
  const memberEvidence: LegacyFamilyMemberEvidenceRecord[] = [];

  normalized.forEach((member, index) => {
    const memberId = index + 1;
    if (BigInt(memberId) > TARGET_INTEGER_MAX) libraryFailure("library_target_overflow", MEMBER_RELATION, "id");
    const positionInAccount = perAccountIndex.get(member.accountId) ?? 0;
    perAccountIndex.set(member.accountId, positionInAccount + 1);
    const capStatus: CapStatus = positionInAccount < FAMILY_MEMBER_CAP ? "within_cap" : "over_cap";
    if (capStatus === "over_cap") {
      conflicts.record({
        conflict_class: "family_member_cap_exceeded",
        source_relation: MEMBER_RELATION,
        source_column: "user_id",
        decision:
          "UNRESOLVED for root: the account has more lenders than the M1 five-member trigger allows. Every lender is preserved and none is dropped; the load is blocked until the overflow policy is recorded.",
        details: { status: "unresolved", cap: FAMILY_MEMBER_CAP },
      });
    }
    memberIdByKey.set(`${member.accountId}:${member.steamIdText}`, memberId);

    const candidateAppIds = member.candidates.map((value) => {
      const numeric = Number(value);
      // Steam AppIDs are bounded to 4294967295, so this stays exact, but the
      // round trip is asserted per element rather than assumed.
      if (!Number.isSafeInteger(numeric) || BigInt(numeric) !== value) {
        libraryFailure("library_target_overflow", MEMBER_RELATION, "candidate_appids");
      }
      return numeric;
    });
    const jsonbUpperBound =
      CANDIDATE_JSONB_BYTES_OVERHEAD + candidateAppIds.length * CANDIDATE_JSONB_BYTES_PER_ELEMENT;
    if (jsonbUpperBound > MAX_CANDIDATE_JSONB_BYTES) {
      conflicts.record({
        conflict_class: "family_candidate_size_unprovable",
        source_relation: MEMBER_RELATION,
        source_column: "candidate_appids",
        decision:
          "A pure precheck cannot prove the encoded JSONB size for this array, so the M1 pg_column_size check is a required SQL gate before the row is loaded. No element is dropped to make it fit.",
        details: { status: "unresolved", bound: MAX_CANDIDATE_JSONB_BYTES },
      });
    }

    members.push(
      Object.freeze({
        id: memberId,
        account_id: member.accountId,
        steam_id: member.steamIdText,
        candidate_app_ids: Object.freeze(candidateAppIds),
        candidate_count: candidateAppIds.length,
        checked_at: member.lastSyncedAt,
        error_status: member.errorStatus,
        legacy_member_id: member.legacyId,
        display_name: member.displayName,
        avatar_url: member.avatarUrl,
        profile_url: member.profileUrl,
        legacy_library_seen: Number(member.librarySeen),
        legacy_games_imported: Number(member.gamesImported),
        last_synced_at: member.lastSyncedAt,
        last_error: member.lastErrorForMember,
        cap_status: capStatus,
        candidate_cap_status: member.candidateCapStatus,
        candidate_jsonb_bytes_upper_bound: jsonbUpperBound,
      }),
    );

    const evidenceDetails: Record<string, string | number | boolean> = {
      source_updated_at: member.updatedAt.canonicalUtc,
      candidate_count: candidateAppIds.length,
      error_status: member.errorStatus,
    };
    if (member.displayName !== member.displayNameRaw) evidenceDetails.raw_display_name = member.displayNameRaw;
    if (member.avatarUrl !== member.avatarUrlRaw && member.avatarUrlRaw !== null) {
      evidenceDetails.raw_avatar_url = member.avatarUrlRaw;
    }
    if (member.profileUrl !== member.profileUrlRaw && member.profileUrlRaw !== null) {
      evidenceDetails.raw_profile_url = member.profileUrlRaw;
    }
    if (jsonbUpperBoundBytes(evidenceDetails) > MAX_EVIDENCE_JSONB_BYTES) {
      libraryFailure("library_unrepresentable_value", MEMBER_RELATION, "evidence");
    }

    memberEvidence.push(
      Object.freeze({
        legacy_member_id: member.legacyId,
        account_id: member.accountId,
        steam_id: member.steamIdText,
        created_at: member.createdAt,
        raw_last_error: member.lastErrorRaw,
        raw_library_seen: Number(member.librarySeen),
        raw_games_imported: Number(member.gamesImported),
        source_snapshot_hash: run.snapshotHash,
        retention_class: "staging-30d-post-cutover" as const,
        evidence: Object.freeze(evidenceDetails),
      }),
    );
  });

  const access: FamilyGameAccessRecord[] = [];
  const orphans: FamilyAccessOrphanRecord[] = [];
  const orphanStaging: LegacyFamilyAccessOrphanRecord[] = [];
  const seenAccess = new Set<string>();
  const seenOrphan = new Set<string>();
  const accessCountByMember = new Map<number, number>();

  const ordered = [...validatedCandidates].sort((leftRow, rightRow) => {
    if (leftRow.account_id !== rightRow.account_id) return leftRow.account_id - rightRow.account_id;
    if (leftRow.steam_app_id.length !== rightRow.steam_app_id.length) {
      return leftRow.steam_app_id.length - rightRow.steam_app_id.length;
    }
    if (leftRow.steam_app_id !== rightRow.steam_app_id) {
      return leftRow.steam_app_id < rightRow.steam_app_id ? -1 : 1;
    }
    if (leftRow.game_id !== rightRow.game_id) return leftRow.game_id - rightRow.game_id;
    if (leftRow.legacy_row_id !== rightRow.legacy_row_id) {
      return leftRow.legacy_row_id < rightRow.legacy_row_id ? -1 : 1;
    }
    // Code-unit order, never `localeCompare`: collation depends on the host's
    // ICU data, and deterministic output may not depend on the environment.
    return compareText(leftRow.lender_steam_id ?? "", rightRow.lender_steam_id ?? "");
  });

  for (const candidate of ordered) {
    const memberId =
      candidate.lender_steam_id === null
        ? undefined
        : memberIdByKey.get(`${candidate.account_id}:${candidate.lender_steam_id}`);
    // 20260901193000_share_a_family_library.sql:237-280
    // (remove_user_family_member_games) rewrites an engaged row to
    // ownership='Wishlist' on member removal without clearing
    // access_source/family_owner_steam_id. A resolvable lender here is not
    // grounds to restore access: the source explicitly ended it.
    const retiredByOwnership = candidate.ownership === "Wishlist";
    if (memberId !== undefined && !retiredByOwnership) {
      const key = `${candidate.account_id}:${memberId}:${candidate.game_id}`;
      if (seenAccess.has(key)) libraryFailure("library_duplicate_identity", ACCESS_RELATION, "family_owner_steam_id");
      seenAccess.add(key);
      accessCountByMember.set(memberId, (accessCountByMember.get(memberId) ?? 0) + 1);
      access.push(
        Object.freeze({
          account_id: candidate.account_id,
          member_id: memberId,
          game_id: candidate.game_id,
          observed_at: candidate.observed_at,
          observed_at_status: candidate.observed_at_status,
          provenance: candidate.provenance,
        }),
      );
      continue;
    }

    if (candidate.lender_steam_id !== null && memberId === undefined) {
      conflicts.record({
        conflict_class: "family_access_orphan_lender_absent",
        source_relation: ACCESS_RELATION,
        source_column: "family_owner_steam_id",
        decision:
          "The named lender has no surviving user_family_members row. app.family_game_access needs a composite member key, so the access is retained as orphan evidence with confers_access=false; no member row is synthesised.",
        details: { status: "resolved", destination: "app.family_access_orphans" },
      });
    }
    if (retiredByOwnership) {
      conflicts.record({
        conflict_class: "family_access_retired_by_ownership",
        source_relation: ACCESS_RELATION,
        source_column: "ownership",
        decision:
          "ownership='Wishlist' with access_source='family' is a supported source tombstone (remove_user_family_member_games), not an unresolved combination and not grounds to restore access. No app.family_game_access row is written regardless of whether the lender resolves; the tombstone is retained in app.family_access_orphans with disposition='retired' (root's proposal migration adds this literal) and confers_access=false. Lender minutes are never converted to a personal measurement: app.family_game_access carries no minutes and this row never reaches app.library_games or app.retired_library_games.",
        details: { status: "resolved", destination: "app.family_access_orphans" },
      });
    }

    const orphanKey = `${candidate.account_id}:${candidate.steam_app_id}:${candidate.lender_steam_id ?? ""}`;
    if (seenOrphan.has(orphanKey)) {
      libraryFailure("library_duplicate_identity", ACCESS_RELATION, "family_owner_steam_id");
    }
    seenOrphan.add(orphanKey);

    orphans.push(
      Object.freeze({
        account_id: candidate.account_id,
        game_id: candidate.game_id,
        steam_app_id: candidate.steam_app_id,
        lender_steam_id: candidate.lender_steam_id,
        observed_at: candidate.observed_at,
        disposition: retiredByOwnership ? ("retired" as const) : ("quarantine" as const),
        confers_access: false as const,
        source_snapshot_hash: run.snapshotHash,
      }),
    );

    const evidence: Record<string, string | number | boolean> = {
      lender_identity_status: candidate.lender_steam_id_status,
      provenance: candidate.provenance,
      ownership: candidate.ownership,
      legacy_row_id: candidate.legacy_row_id,
    };
    if (candidate.lender_steam_id_raw !== null) {
      evidence.lender_steam_id_raw = candidate.lender_steam_id_raw;
    }
    // A malformed lender identity is raw source text with no length bound of
    // its own, and this is its only destination.  The JSONB payload bound is
    // therefore proved here rather than assumed; truncating the raw text would
    // destroy the evidence the orphan row exists to keep.
    if (jsonbUpperBoundBytes(evidence) > MAX_EVIDENCE_JSONB_BYTES) {
      libraryFailure("library_unrepresentable_value", ACCESS_RELATION, "evidence");
    }
    orphanStaging.push(
      Object.freeze({
        account_id: candidate.account_id,
        source_user_id: candidate.source_user_id,
        source_member_id: null,
        source_steam_id: candidate.lender_steam_id,
        steam_appid: candidate.steam_app_id,
        observed_at: candidate.observed_at,
        raw_games_imported: null,
        disposition: retiredByOwnership ? ("retired" as const) : ("quarantine" as const),
        source_snapshot_hash: run.snapshotHash,
        evidence: Object.freeze(evidence),
      }),
    );
  }

  // The legacy counter is historical evidence, independently retained from
  // the current resolved-access count. A disagreement is expected evidence,
  // not permission to rewrite either count.
  for (const member of members) {
    const recomputed = accessCountByMember.get(member.id) ?? 0;
    if (member.legacy_games_imported !== null && member.legacy_games_imported !== recomputed) {
      conflicts.record({
        conflict_class: "family_games_imported_not_recomputable",
        source_relation: MEMBER_RELATION,
        source_column: "games_imported",
        decision:
          "RESOLVED: legacy_games_imported preserves the historical source counter independently of the current app.family_game_access count. Neither count is rewritten or treated as a reconstruction of the other.",
        details: { status: "resolved" },
      });
    }
  }

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    family_members: Object.freeze(members),
    legacy_family_member_evidence: Object.freeze(memberEvidence),
    family_game_access: Object.freeze(access),
    family_access_orphans: Object.freeze(orphans),
    legacy_family_access_orphans: Object.freeze(orphanStaging),
    conflicts: conflicts.toRecords(),
  });
}

/** Stable JSON for order-independent comparisons in tests and reports. */
export function canonicalFamilyResult(result: FamilyTransformResult): string {
  return JSON.stringify({
    run_identity: result.run_identity,
    family_members: result.family_members,
    legacy_family_member_evidence: result.legacy_family_member_evidence,
    family_game_access: result.family_game_access,
    family_access_orphans: result.family_access_orphans,
    legacy_family_access_orphans: result.legacy_family_access_orphans,
    conflicts: result.conflicts,
  });
}
