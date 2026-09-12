import { ExportError } from "../shared/redaction.ts";
import {
  parsePgInteger,
  parsePgTimestamptz,
  type PgTimestamp,
} from "./scalars.ts";

/**
 * A run is the identity boundary for every pure migration transform.  The
 * observation instant is deliberately part of the identity: it is the
 * supplied, labelled cutover observation retained for audit joins.  It is
 * never filled from the wall clock.
 */
export type TransformRunIdentity = Readonly<{
  runId: string;
  /** Name matches the identity transform's `run_identity.snapshot_hash`. */
  snapshotHash: string;
  observedAt: string;
}>;

export type AccountKind = "manual" | "steam";
export type AccountLifecycle = "active" | "merged" | "deleted";

/**
 * Explicit proof carried by the identity adapter for a deleted merge source.
 * A capability transform may treat this entry as absent only when this proof
 * is present; a lifecycle value by itself is not sufficient evidence.
 */
export type AccountTombstoneProof = Readonly<{
  mergeId: string;
  sourceDeleted: true;
  verified: false;
  createdAtMeaning: "merge_observed_at" | "source_account_created_at";
}>;

/**
 * This is the narrow account API shared with the identity transform.  The
 * account transform owns construction of this map; session and capability
 * transforms only validate and consume it.  `run` is optional on an entry for
 * compatibility with a map whose run is asserted once at the top level.  If
 * supplied, it must equal the map run.
 */
export type AccountMapEntry = Readonly<{
  legacyId: string;
  accountId: number;
  accountKind: AccountKind;
  identityVerified: boolean;
  lifecycleStatus: AccountLifecycle;
  /** Present only when the identity adapter proved a deleted merge source. */
  tombstone?: AccountTombstoneProof;
  run?: TransformRunIdentity;
}>;

export type AccountMap = Readonly<{
  run: TransformRunIdentity;
  entries: readonly AccountMapEntry[];
}>;

export type TransformLimits = Readonly<{
  maxAccounts?: number;
  maxSessions?: number;
}>;

export const DEFAULT_TRANSFORM_LIMITS = Object.freeze({
  maxAccounts: 100_000,
  maxSessions: 200_000,
});

export type SessionTransformErrorCode =
  | "session_run_invalid"
  | "session_run_mismatch"
  | "session_limit_invalid"
  | "session_input_bound_exceeded"
  | "session_account_map_invalid"
  | "session_account_map_duplicate_legacy"
  | "session_account_map_duplicate_target"
  | "session_account_map_entry_run_mismatch"
  | "session_source_id_invalid"
  | "session_source_id_collision"
  | "session_owner_missing"
  | "session_owner_kind"
  | "session_owner_verification"
  | "session_owner_lifecycle"
  | "session_digest_invalid"
  | "session_digest_collision"
  | "session_timestamp_invalid"
  | "session_expiry_order"
  | "session_revocation_order"
  | "session_manual_last_seen_missing"
  | "session_manual_disposition_required"
  | "session_row_invalid";

const SESSION_MESSAGES: Readonly<Record<SessionTransformErrorCode, string>> = {
  session_run_invalid: "The session transform run identity is invalid.",
  session_run_mismatch: "The session input and account map belong to different runs.",
  session_limit_invalid: "The session transform bound is invalid.",
  session_input_bound_exceeded: "The session transform input exceeds its configured bound.",
  session_account_map_invalid: "The account map is invalid for the session transform.",
  session_account_map_duplicate_legacy: "The account map contains duplicate legacy identities.",
  session_account_map_duplicate_target: "The account map contains duplicate target identities.",
  session_account_map_entry_run_mismatch: "An account map entry belongs to a different run.",
  session_source_id_invalid: "A session source identity is invalid.",
  session_source_id_collision: "Session source identities collide across the input tables.",
  session_owner_missing: "A session owner is absent from the account map.",
  session_owner_kind: "A session owner has the wrong account kind.",
  session_owner_verification: "A verified session owner lacks verified identity evidence.",
  session_owner_lifecycle: "A session owner is not active at the migration boundary.",
  session_digest_invalid: "A session token digest is not valid 64-character hexadecimal text.",
  session_digest_collision: "Session token digests collide after decoding.",
  session_timestamp_invalid: "A session timestamp is malformed or unsupported.",
  session_expiry_order: "A session expiry does not occur after its creation instant.",
  session_revocation_order: "A session revocation precedes its creation instant.",
  session_manual_last_seen_missing: "A manual session is missing its required last-seen instant.",
  session_manual_disposition_required: "Manual sessions require the fixed continuity disposition.",
  session_row_invalid: "A session source row is malformed.",
};

/** A stable failure whose public fields contain no source UUID or digest. */
export class SessionTransformError extends ExportError {
  readonly sessionCode: SessionTransformErrorCode;

  constructor(
    code: SessionTransformErrorCode,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(code, SESSION_MESSAGES[code], details);
    this.name = "SessionTransformError";
    this.sessionCode = code;
  }
}

function fail(
  code: SessionTransformErrorCode,
  details: Record<string, string | number | boolean | null> = {},
): never {
  throw new SessionTransformError(code, details);
}

// PostgreSQL's uuid type accepts any 128-bit UUID-shaped value; version and
// variant bits are not part of this transform's source contract.
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

function normalizedUuid(value: unknown, code: SessionTransformErrorCode): string {
  if (typeof value !== "string" || !UUID_TEXT.test(value)) fail(code);
  return value.toLowerCase();
}

function validatedTombstoneProof(value: unknown): AccountTombstoneProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("session_account_map_invalid");
  }
  const candidate = value as Record<string, unknown>;
  const mergeId = normalizedUuid(candidate.mergeId, "session_account_map_invalid");
  if (candidate.sourceDeleted !== true || candidate.verified !== false) {
    fail("session_account_map_invalid");
  }
  if (
    candidate.createdAtMeaning !== "merge_observed_at" &&
    candidate.createdAtMeaning !== "source_account_created_at"
  ) {
    fail("session_account_map_invalid");
  }
  return Object.freeze({
    mergeId,
    sourceDeleted: true,
    verified: false,
    createdAtMeaning: candidate.createdAtMeaning,
  });
}

function validateLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fallback) {
    fail("session_limit_invalid");
  }
  return limit;
}

function normalizedRun(run: TransformRunIdentity): TransformRunIdentity {
  if (!run || typeof run !== "object") fail("session_run_invalid");
  if (typeof run.runId !== "string" || !SAFE_RUN_ID.test(run.runId)) {
    fail("session_run_invalid");
  }
  if (typeof run.snapshotHash !== "string" || !HEX_32_BYTES.test(run.snapshotHash)) {
    fail("session_run_invalid");
  }
  let observed: PgTimestamp | null;
  try {
    observed = parsePgTimestamptz(run.observedAt);
  } catch {
    fail("session_run_invalid");
  }
  if (!observed) fail("session_run_invalid");
  return Object.freeze({
    runId: run.runId,
    snapshotHash: run.snapshotHash.toLowerCase(),
    observedAt: observed.canonicalUtc,
  });
}

/** Normalize and validate the identity boundary once for sibling transforms. */
export function normalizeTransformRun(run: TransformRunIdentity): TransformRunIdentity {
  return normalizedRun(run);
}

export function sameTransformRun(
  left: TransformRunIdentity,
  right: TransformRunIdentity,
): boolean {
  const a = normalizedRun(left);
  const b = normalizedRun(right);
  return (
    a.runId === b.runId &&
    a.snapshotHash === b.snapshotHash &&
    a.observedAt === b.observedAt
  );
}

/** Decode a run's public 32-byte snapshot hash without routing it through the digest path. */
export function decodeSnapshotHash(run: TransformRunIdentity): Uint8Array {
  const normalized = normalizedRun(run);
  return decodeHex32(normalized.snapshotHash, "session_run_invalid");
}

function decodeHex32(value: string, code: SessionTransformErrorCode): Uint8Array {
  if (!HEX_32_BYTES.test(value)) fail(code);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function sourceInstant(value: unknown): PgTimestamp {
  if (typeof value !== "string") fail("session_timestamp_invalid");
  try {
    const parsed = parsePgTimestamptz(value);
    if (!parsed) fail("session_timestamp_invalid");
    return parsed;
  } catch {
    fail("session_timestamp_invalid");
  }
}

function optionalSourceInstant(value: unknown): PgTimestamp | null {
  if (value === null || value === undefined) return null;
  return sourceInstant(value);
}

function validAccountId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("session_account_map_invalid");
  }
  return value as number;
}

type ValidatedAccount = AccountMapEntry & Readonly<{ normalizedLegacyId: string }>;

type ValidatedAccountIndex = Readonly<{
  byLegacyId: ReadonlyMap<string, ValidatedAccount>;
  run: TransformRunIdentity;
}>;

function validateAccountMap(
  accountMap: AccountMap,
  limits: { maxAccounts: number },
  run: TransformRunIdentity,
): ValidatedAccountIndex {
  if (!accountMap || typeof accountMap !== "object" || Array.isArray(accountMap)) {
    fail("session_account_map_invalid");
  }
  if (!sameTransformRun(accountMap.run, run)) fail("session_run_mismatch");
  if (!Array.isArray(accountMap.entries) || accountMap.entries.length > limits.maxAccounts) {
    fail("session_input_bound_exceeded", { maxAccounts: limits.maxAccounts });
  }

  const byLegacyId = new Map<string, ValidatedAccount>();
  const byTarget = new Set<number>();
  for (const entry of accountMap.entries) {
    if (!entry || typeof entry !== "object") fail("session_account_map_invalid");
    const normalizedLegacyId = normalizedUuid(entry.legacyId, "session_account_map_invalid");
    if (byLegacyId.has(normalizedLegacyId)) fail("session_account_map_duplicate_legacy");
    const accountId = validAccountId(entry.accountId);
    if (byTarget.has(accountId)) fail("session_account_map_duplicate_target");
    if (entry.accountKind !== "manual" && entry.accountKind !== "steam") {
      fail("session_account_map_invalid");
    }
    if (typeof entry.identityVerified !== "boolean") fail("session_account_map_invalid");
    if (
      entry.lifecycleStatus !== "active" &&
      entry.lifecycleStatus !== "merged" &&
      entry.lifecycleStatus !== "deleted"
    ) {
      fail("session_account_map_invalid");
    }
    if (entry.run !== undefined && !sameTransformRun(entry.run, run)) {
      fail("session_account_map_entry_run_mismatch");
    }
    const tombstone =
      entry.tombstone === undefined ? undefined : validatedTombstoneProof(entry.tombstone);
    if (
      tombstone !== undefined &&
      (entry.lifecycleStatus !== "deleted" ||
        entry.accountKind !== "manual" ||
        entry.identityVerified)
    ) {
      fail("session_account_map_invalid");
    }
    const validated = Object.freeze({
      ...entry,
      accountId,
      ...(tombstone === undefined ? {} : { tombstone }),
      normalizedLegacyId,
    });
    byLegacyId.set(normalizedLegacyId, validated);
    byTarget.add(accountId);
  }
  return Object.freeze({ byLegacyId, run });
}

/**
 * Validate the identity worker's explicit map for a sibling transform.  The
 * returned lookup is keyed by normalized UUID solely for joins; the entry's
 * original legacyId remains untouched for migration maps.
 */
export function indexTransformAccounts(
  accountMap: AccountMap,
  run: TransformRunIdentity,
  maxAccounts: number = Number(DEFAULT_TRANSFORM_LIMITS.maxAccounts),
): ReadonlyMap<string, AccountMapEntry> {
  const normalizedRunValue = normalizedRun(run);
  const limit = validateLimit(maxAccounts, DEFAULT_TRANSFORM_LIMITS.maxAccounts);
  const index = validateAccountMap(accountMap, { maxAccounts: limit }, normalizedRunValue);
  return index.byLegacyId;
}

/**
 * Structural view of the identity transform result.  Keeping this adapter
 * structural avoids a runtime dependency cycle while allowing the identity
 * worker's reviewed `accounts`, `steam_profiles` and `account_map` outputs to
 * feed this phase directly.
 */
export type IdentityResultForSessionMap = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  accounts: readonly Readonly<{
    id: number;
    public_id: string;
    account_kind: AccountKind;
    lifecycle_status: "active" | "deleted";
    tombstone?: Readonly<{
      merge_id: string;
      source_deleted: true;
      verified: false;
      created_at_meaning: "merge_observed_at" | "source_account_created_at";
    }>;
  }>[];
  steam_profiles: readonly Readonly<{
    account_id: number;
    verified: boolean;
  }>[];
  account_map: readonly Readonly<{
    legacy_id: string;
    account_id: number;
    source_kind: "app_accounts" | "unknown";
    source_snapshot_hash: string;
  }>[];
}>;

/**
 * Join the identity worker's result into the explicit map consumed by the
 * session/capability transforms.  `observedAt` is supplied by the caller and
 * is the only additional fact this adapter accepts; no current time is read.
 */
export function accountMapFromIdentityResult(
  result: IdentityResultForSessionMap,
  observedAt: string,
): AccountMap {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("session_account_map_invalid");
  }
  const run = normalizedRun({
    runId: result.run_identity?.run_id,
    snapshotHash: result.run_identity?.snapshot_hash,
    observedAt,
  });
  if (!Array.isArray(result.accounts) || !Array.isArray(result.steam_profiles) || !Array.isArray(result.account_map)) {
    fail("session_account_map_invalid");
  }
  const accountsByTarget = new Map<number, IdentityResultForSessionMap["accounts"][number]>();
  for (const account of result.accounts) {
    if (!account || typeof account !== "object") fail("session_account_map_invalid");
    if (accountsByTarget.has(account.id)) fail("session_account_map_duplicate_target");
    accountsByTarget.set(account.id, account);
  }
  const verifiedByTarget = new Set<number>();
  const profileTargets = new Set<number>();
  for (const profile of result.steam_profiles) {
    if (
      !profile ||
      typeof profile !== "object" ||
      !Number.isSafeInteger(profile.account_id) ||
      profile.account_id < 1 ||
      typeof profile.verified !== "boolean"
    ) {
      fail("session_account_map_invalid");
    }
    if (!accountsByTarget.has(profile.account_id) || profileTargets.has(profile.account_id)) {
      fail("session_account_map_invalid");
    }
    profileTargets.add(profile.account_id);
    if (profile.verified) verifiedByTarget.add(profile.account_id);
  }
  const entries: AccountMapEntry[] = [];
  const sourceIds = new Set<string>();
  const targetIds = new Set<number>();
  for (const mapping of result.account_map) {
    if (!mapping || typeof mapping !== "object") fail("session_account_map_invalid");
    const sourceId = normalizedUuid(mapping.legacy_id, "session_account_map_invalid");
    if (sourceIds.has(sourceId)) fail("session_account_map_duplicate_legacy");
    if (!Number.isSafeInteger(mapping.account_id) || mapping.account_id < 1) {
      fail("session_account_map_invalid");
    }
    if (targetIds.has(mapping.account_id)) fail("session_account_map_duplicate_target");
    if (mapping.source_kind !== "app_accounts" && mapping.source_kind !== "unknown") {
      fail("session_account_map_invalid");
    }
    if (
      typeof mapping.source_snapshot_hash !== "string" ||
      !HEX_32_BYTES.test(mapping.source_snapshot_hash) ||
      mapping.source_snapshot_hash.toLowerCase() !== run.snapshotHash
    ) {
      fail("session_run_mismatch");
    }
    const account = accountsByTarget.get(mapping.account_id);
    if (!account || normalizedUuid(account.public_id, "session_account_map_invalid") !== sourceId) {
      fail("session_account_map_invalid");
    }
    if (
      !Number.isSafeInteger(account.id) ||
      account.id < 1 ||
      (account.lifecycle_status !== "active" && account.lifecycle_status !== "deleted")
    ) {
      fail("session_account_map_invalid");
    }
    if (account.account_kind !== "manual" && account.account_kind !== "steam") {
      fail("session_account_map_invalid");
    }
    let tombstoneProof: AccountTombstoneProof | undefined;
    if (mapping.source_kind === "unknown") {
      if (
        account.lifecycle_status !== "deleted" ||
        account.account_kind !== "manual" ||
        !account.tombstone ||
        account.tombstone.source_deleted !== true ||
        account.tombstone.verified !== false ||
        (account.tombstone.created_at_meaning !== "merge_observed_at" &&
          account.tombstone.created_at_meaning !== "source_account_created_at")
      ) {
        fail("session_account_map_invalid");
      }
      tombstoneProof = Object.freeze({
        mergeId: normalizedUuid(account.tombstone.merge_id, "session_account_map_invalid"),
        sourceDeleted: true,
        verified: false,
        createdAtMeaning: account.tombstone.created_at_meaning,
      });
    } else if (account.lifecycle_status !== "active" || account.tombstone !== undefined) {
      fail("session_account_map_invalid");
    }
    const entry: AccountMapEntry = {
      legacyId: account.public_id,
      accountId: account.id,
      accountKind: account.account_kind,
      identityVerified: account.account_kind === "steam" && verifiedByTarget.has(account.id),
      lifecycleStatus: account.lifecycle_status,
      ...(tombstoneProof === undefined ? {} : { tombstone: tombstoneProof }),
      run,
    };
    entries.push(Object.freeze(entry));
    sourceIds.add(sourceId);
    targetIds.add(mapping.account_id);
  }
  if (entries.length !== accountsByTarget.size) fail("session_account_map_invalid");
  return Object.freeze({ run, entries: Object.freeze(entries) });
}

type SessionSourceTable = "sessions" | "manual_profile_sessions";

/** Exact source shape accepted for the verified `sessions` relation. */
export type LegacyVerifiedSession = Readonly<{
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string | null;
  expiresAt: string;
  revokedAt?: string | null;
}>;

/** Exact source shape accepted for the long-lived manual browser sessions. */
export type LegacyManualSession = Readonly<{
  id: string;
  profileId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string | null;
  expiresAt: string;
  revokedAt?: string | null;
}>;

/**
 * The long-lived manual `vault_session` cookie is preserved in `app.sessions`
 * with kind `manual`.  Keeping the continuity disposition explicit makes an
 * old caller fail closed instead of silently applying a retirement policy.
 */
export type ManualSessionDisposition = "migrate-cookie";

export type SessionTransformInput = Readonly<{
  run: TransformRunIdentity;
  accountMap: AccountMap;
  verified: readonly LegacyVerifiedSession[];
  manual: readonly LegacyManualSession[];
  manualDisposition: ManualSessionDisposition;
  limits?: TransformLimits;
}>; 

export type SessionKind = "verified_steam" | "manual";

/** Legacy browser/session constants from `lib/auth.ts`, kept as reviewed
 * compatibility evidence for the pure transform. */
export const LEGACY_SESSION_COOKIE_NAME = "vault_session";
export const LEGACY_MANUAL_COOKIE_PREFIX = "manual.";
export const LEGACY_VERIFIED_SESSION_DAYS = 30;
export const LEGACY_MANUAL_SESSION_DAYS = 365;
export const LEGACY_PROFILE_SECURITY_INTENT_MINUTES = 10;

/** The cookie prefix selects the source relation; the raw cookie is hashed in full. */
export function legacySessionKindFromCookie(cookieValue: string): SessionKind {
  if (typeof cookieValue !== "string" || cookieValue.length === 0) {
    fail("session_row_invalid");
  }
  return cookieValue.startsWith(LEGACY_MANUAL_COOKIE_PREFIX) ? "manual" : "verified_steam";
}

export type UnifiedSessionRecord = Readonly<{
  /** Target `app.sessions.id`; assigned from the sorted source union. */
  targetId: bigint;
  accountId: number;
  sessionKind: SessionKind;
  /** Exact decoded HMAC-SHA-256 bytes; never put this field in diagnostics. */
  tokenDigest: Uint8Array;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  sourceId: string;
  /** Source owner UUID: `user_id` for verified rows, `profile_id` for manual. */
  sourceOwnerId: string;
  sourceTable: "sessions" | "manual_profile_sessions";
  sourceSnapshotHash: Uint8Array;
}>;

export type SessionMapRecord = Readonly<{
  legacyId: string;
  accountId: number;
  targetId: bigint;
  sourceKind: SessionKind;
  disposition: "migrated" | ManualSessionDisposition;
  sourceSnapshotHash: Uint8Array;
}>;

export type SessionTransformResult = Readonly<{
  run: TransformRunIdentity;
  sessions: readonly UnifiedSessionRecord[];
  maps: readonly SessionMapRecord[];
  counts: Readonly<{
    verifiedMigrated: number;
    manualMigrated: number;
  }>;
}>;

type ValidatedSession = Readonly<{
  sourceId: string;
  normalizedSourceId: string;
  ownerLegacyId: string;
  accountId: number;
  sourceTable: SessionSourceTable;
  sourceKind: SessionKind;
  tokenDigest: Uint8Array;
  digestKey: string;
  createdAt: string;
  created: PgTimestamp;
  lastSeenAt: string | null;
  expiresAt: string;
  expires: PgTimestamp;
  revokedAt: string | null;
  revoked: PgTimestamp | null;
}>;

function parseDigest(value: unknown): { bytes: Uint8Array; key: string } {
  if (typeof value !== "string" || !HEX_32_BYTES.test(value)) {
    fail("session_digest_invalid");
  }
  return { bytes: decodeHex32(value, "session_digest_invalid"), key: value.toLowerCase() };
}

function parseSourceRowTime(value: unknown, optional: boolean): PgTimestamp | null {
  return optional ? optionalSourceInstant(value) : sourceInstant(value);
}

function validateSessionRow(
  row: LegacyVerifiedSession | LegacyManualSession,
  sourceTable: SessionSourceTable,
  account: ValidatedAccount,
  sourceKind: SessionKind,
  ownerLegacyId: string,
): ValidatedSession {
  if (!row || typeof row !== "object") fail("session_row_invalid");
  const sourceId = row.id;
  const normalizedSourceId = normalizedUuid(sourceId, "session_source_id_invalid");
  const digest = parseDigest(row.tokenHash);
  const created = parseSourceRowTime(row.createdAt, false);
  const expires = parseSourceRowTime(row.expiresAt, false);
  const lastSeen = parseSourceRowTime(row.lastSeenAt, true);
  const revoked = parseSourceRowTime(row.revokedAt, true);
  if (!created || !expires) fail("session_timestamp_invalid");
  if (sourceTable === "manual_profile_sessions" && !lastSeen) {
    fail("session_manual_last_seen_missing");
  }
  if (expires.epochMicros <= created.epochMicros) fail("session_expiry_order");
  if (revoked && revoked.epochMicros < created.epochMicros) fail("session_revocation_order");
  return Object.freeze({
    sourceId,
    normalizedSourceId,
    ownerLegacyId,
    accountId: account.accountId,
    sourceTable,
    sourceKind,
    tokenDigest: digest.bytes,
    digestKey: digest.key,
    createdAt: row.createdAt,
    created,
    lastSeenAt: lastSeen ? row.lastSeenAt ?? null : null,
    expiresAt: row.expiresAt,
    expires,
    revokedAt: revoked ? row.revokedAt ?? null : null,
    revoked,
  });
}

function ownerFor(
  accountIndex: ValidatedAccountIndex,
  sourceId: unknown,
  sourceKind: SessionKind,
): ValidatedAccount {
  const normalized = normalizedUuid(sourceId, "session_source_id_invalid");
  const account = accountIndex.byLegacyId.get(normalized);
  if (!account) fail("session_owner_missing");
  if (sourceKind === "verified_steam") {
    if (account.accountKind !== "steam") fail("session_owner_kind");
    if (!account.identityVerified) fail("session_owner_verification");
  } else {
    if (account.accountKind !== "manual") fail("session_owner_kind");
    if (account.identityVerified) fail("session_owner_verification");
  }
  if (account.lifecycleStatus !== "active") fail("session_owner_lifecycle");
  return account;
}

function unionSort(left: ValidatedSession, right: ValidatedSession): number {
  if (left.normalizedSourceId !== right.normalizedSourceId) {
    return left.normalizedSourceId < right.normalizedSourceId ? -1 : 1;
  }
  if (left.sourceTable !== right.sourceTable) {
    return left.sourceTable < right.sourceTable ? -1 : 1;
  }
  if (left.accountId !== right.accountId) return left.accountId - right.accountId;
  return 0;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * Validate and transform both legacy session tables in one deterministic pass.
 * Manual rows participate in owner, expiry, source-id and decoded-digest
 * validation, then both source kinds receive target IDs and retain their
 * decoded digests. Manual rows keep `session_kind = 'manual'`; they are not
 * security-intent rows.
 */
export function transformSessions(input: SessionTransformInput): SessionTransformResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("session_row_invalid");
  if (
    !input.accountMap ||
    typeof input.accountMap !== "object" ||
    Array.isArray(input.accountMap)
  ) {
    fail("session_account_map_invalid");
  }
  const run = normalizedRun(input.run);
  const maxAccounts = validateLimit(input.limits?.maxAccounts, DEFAULT_TRANSFORM_LIMITS.maxAccounts);
  const maxSessions = validateLimit(input.limits?.maxSessions, DEFAULT_TRANSFORM_LIMITS.maxSessions);
  if (!sameTransformRun(input.accountMap.run, run)) fail("session_run_mismatch");
  const accountIndex = validateAccountMap(input.accountMap, { maxAccounts }, run);
  if (!Array.isArray(input.verified) || !Array.isArray(input.manual)) fail("session_row_invalid");
  if (input.verified.length + input.manual.length > maxSessions) {
    fail("session_input_bound_exceeded", { maxSessions });
  }
  if (input.manualDisposition !== "migrate-cookie") {
    fail("session_manual_disposition_required");
  }

  const sourceIds = new Set<string>();
  const digests = new Set<string>();
  const union: ValidatedSession[] = [];

  for (const row of input.verified) {
    const sourceId = normalizedUuid(row?.id, "session_source_id_invalid");
    if (sourceIds.has(sourceId)) fail("session_source_id_collision");
    sourceIds.add(sourceId);
    const owner = ownerFor(accountIndex, row?.userId, "verified_steam");
    const validated = validateSessionRow(row, "sessions", owner, "verified_steam", row.userId);
    if (digests.has(validated.digestKey)) fail("session_digest_collision");
    digests.add(validated.digestKey);
    union.push(validated);
  }

  for (const row of input.manual) {
    const sourceId = normalizedUuid(row?.id, "session_source_id_invalid");
    if (sourceIds.has(sourceId)) fail("session_source_id_collision");
    sourceIds.add(sourceId);
    const owner = ownerFor(accountIndex, row?.profileId, "manual");
    const validated = validateSessionRow(row, "manual_profile_sessions", owner, "manual", row.profileId);
    if (digests.has(validated.digestKey)) fail("session_digest_collision");
    digests.add(validated.digestKey);
    union.push(validated);
  }

  union.sort(unionSort);
  const sourceSnapshotHash = decodeSnapshotHash(run);
  const sessions: UnifiedSessionRecord[] = [];
  const maps: SessionMapRecord[] = [];
  let nextTargetId = BigInt(1);

  for (const row of union) {
    const targetId = nextTargetId;
    nextTargetId += BigInt(1);
    sessions.push(Object.freeze({
      targetId,
      accountId: row.accountId,
      sessionKind: row.sourceKind,
      tokenDigest: cloneBytes(row.tokenDigest),
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      sourceId: row.sourceId,
      sourceOwnerId: row.ownerLegacyId,
      sourceTable: row.sourceTable,
      sourceSnapshotHash: cloneBytes(sourceSnapshotHash),
    }));
    maps.push(Object.freeze({
      legacyId: row.sourceId,
      accountId: row.accountId,
      targetId,
      sourceKind: row.sourceKind,
      disposition: "migrated",
      sourceSnapshotHash: cloneBytes(sourceSnapshotHash),
    }));
  }

  const result: SessionTransformResult = {
    run,
    sessions: Object.freeze(sessions),
    maps: Object.freeze(maps),
    counts: Object.freeze({
      verifiedMigrated: sessions.filter((row) => row.sessionKind === "verified_steam").length,
      manualMigrated: sessions.filter((row) => row.sessionKind === "manual").length,
    }),
  };
  return Object.freeze(result);
}

/** Public aliases make the account-map contract convenient to consume. */
export const transformSessionRows = transformSessions;
export type SessionTransform = SessionTransformInput;

/** Exact timestamp comparison for capabilities and other sibling transforms. */
export function compareTransformInstants(left: string, right: string): -1 | 0 | 1 {
  const a = sourceInstant(left).epochMicros;
  const b = sourceInstant(right).epochMicros;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse a required/optional source timestamp while keeping its source text. */
export function parseTransformInstant(value: string | null): PgTimestamp | null {
  return value === null ? null : sourceInstant(value);
}

/** Parse a non-negative legacy integer without Number-mediated bigint loss. */
export function parseTransformCount(value: string | number | null): number | null {
  if (value === null) return null;
  let parsed: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      fail("session_row_invalid");
    }
    parsed = BigInt(value);
  } else {
    try {
      const integer = parsePgInteger(value, {
        minInclusive: BigInt(0),
        maxInclusive: BigInt(2_147_483_647),
      });
      if (integer === null) return null;
      parsed = integer;
    } catch {
      fail("session_row_invalid");
    }
  }
  return Number(parsed);
}
