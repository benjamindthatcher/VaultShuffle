import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExportError } from "../shared/redaction.ts";
import {
  COPY_DECODER_DEFAULT_LIMITS,
  CopyTextDecoder,
  type CopyDecodeResult,
  type CopyDecoderLimits,
  type CopyRowSink,
} from "./copy-text.ts";
import type { ManifestRelation, RunManifest } from "../export/manifest.ts";

/**
 * The reader accepts a source identity only when the caller names it. A
 * synthetic fixture is a separate identity class: it deliberately has no
 * project reference and cannot satisfy a real-source expectation by accident.
 */
export type ReaderSourceExpectation =
  | {
      kind: "real-source";
      projectRef: string;
      database: string;
      user: string;
    }
  | {
      kind: "synthetic-fixture";
      database: string;
      user: string;
      label?: string;
    };

export type ReaderRelationExpectation = {
  schema: string;
  name: string;
  columns: readonly string[];
};

export type ReaderExpectations = {
  source: ReaderSourceExpectation;
  relations: readonly ReaderRelationExpectation[];
};

export type ReaderLimits = {
  maxManifestBytes?: number;
  maxDigestBytes?: number;
  maxRelations?: number;
  copy?: CopyDecoderLimits;
};

export const READER_DEFAULT_LIMITS = Object.freeze({
  maxManifestBytes: 8 * 1024 * 1024,
  maxDigestBytes: 4096,
  maxRelations: 4096,
});

export type RelationReadResult = {
  relation: string;
  rows: number;
  bytes: number;
  sha256: string;
};

export type VerifiedRelation = {
  schema: string;
  name: string;
  columns: readonly string[];
  rows: number;
  bytes: number;
  sha256: string;
};

export type VerifiedRun = {
  readonly runDirectory: string;
  readonly manifest: RunManifest;
  readonly relations: readonly VerifiedRelation[];
  streamRelationRows(
    relation: string | Pick<ReaderRelationExpectation, "schema" | "name">,
    onRow: CopyRowSink,
  ): Promise<RelationReadResult>;
};

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const OWNER_ONLY_MASK = 0o077;
const MAX_ALLOWED_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_ALLOWED_DIGEST_BYTES = 64 * 1024;
const MAX_ALLOWED_RELATIONS = 4096;
const RELATIONS_DIRECTORY = "relations";
const MANIFEST_FILENAME = "manifest.json";
const MANIFEST_DIGEST_FILENAME = "manifest.sha256";
const INCOMPLETE_FILENAME = "INCOMPLETE";
const FAILURE_FILENAME = "FAILED.json";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT = /^\d+:\d+:(?:\d+(?:,\d+)*)?$/;
const WAL_LSN = /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/;

type ResolvedReaderLimits = {
  maxManifestBytes: number;
  maxDigestBytes: number;
  maxRelations: number;
  copy: CopyDecoderLimits;
};

type Fingerprint = {
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type OpenPrivateFile = {
  handle: FileHandle;
  fingerprint: Fingerprint;
};

function readerError(code: string): ExportError {
  const messages: Readonly<Record<string, string>> = {
    reader_limits_invalid: "Reader limits are invalid.",
    reader_path_invalid: "The export run path is invalid.",
    reader_run_incomplete: "The export run is incomplete or contains an unfinished marker.",
    reader_private_directory: "The export run directory is not a private owner-only directory.",
    reader_private_file: "An export artifact is not a private owner-only regular file.",
    reader_symlink_rejected: "Symlinks are not accepted in an export artifact.",
    reader_alias_rejected: "Hard-linked artifact aliases are not accepted in an export run.",
    reader_unreadable: "An export artifact could not be read.",
    reader_manifest_too_large: "The export manifest exceeds the configured bound.",
    reader_manifest_unreadable: "The export manifest could not be read.",
    reader_manifest_digest_unreadable: "The export manifest digest could not be read.",
    reader_manifest_digest_invalid: "The export manifest digest file is malformed.",
    reader_manifest_digest_mismatch: "The export manifest digest does not match the manifest bytes.",
    reader_manifest_unparseable: "The export manifest is not valid JSON.",
    reader_manifest_version: "The export manifest version is unsupported.",
    reader_manifest_invalid: "The export manifest does not satisfy the version 2 contract.",
    reader_identity_mismatch: "The export manifest source identity does not match the requested source.",
    reader_snapshot_invalid: "The export manifest does not prove one read-only repeatable-read snapshot.",
    reader_session_settings_invalid: "The export manifest does not prove the required UTC session settings.",
    reader_row_security_missing: "The export manifest does not prove row-security was disabled for the run.",
    reader_schema_mismatch: "The export manifest relation or column set does not match the requested inventory.",
    reader_totals_mismatch: "The export manifest totals are contradictory.",
    reader_relation_set_invalid: "The requested relation set is invalid.",
    reader_relation_missing: "A requested export relation is missing.",
    reader_relation_extra: "The export run contains an unexpected relation file.",
    reader_relation_unreadable: "An export relation file could not be read.",
    reader_relation_integrity: "An export relation file does not match its manifest evidence.",
    reader_copy_malformed: "An export relation is not valid PostgreSQL COPY text.",
    reader_copy_consumer_failed: "The row consumer failed before the relation was verified.",
    reader_artifact_changed: "The export artifact changed while it was being verified.",
    reader_relation_unknown: "The requested export relation is not in the verified run.",
    reader_consumer_invalid: "The row consumer is invalid.",
  };
  return new ExportError(code, messages[code] ?? "The export artifact could not be verified.");
}

function resolveLimits(options: ReaderLimits | undefined): ResolvedReaderLimits {
  const maxManifestBytes = options?.maxManifestBytes ?? READER_DEFAULT_LIMITS.maxManifestBytes;
  const maxDigestBytes = options?.maxDigestBytes ?? READER_DEFAULT_LIMITS.maxDigestBytes;
  const maxRelations = options?.maxRelations ?? READER_DEFAULT_LIMITS.maxRelations;
  if (
    !Number.isSafeInteger(maxManifestBytes) ||
    maxManifestBytes < 1 ||
    maxManifestBytes > MAX_ALLOWED_MANIFEST_BYTES ||
    !Number.isSafeInteger(maxDigestBytes) ||
    maxDigestBytes < 1 ||
    maxDigestBytes > MAX_ALLOWED_DIGEST_BYTES ||
    !Number.isSafeInteger(maxRelations) ||
    maxRelations < 1 ||
    maxRelations > MAX_ALLOWED_RELATIONS
  ) {
    throw readerError("reader_limits_invalid");
  }
  return {
    maxManifestBytes,
    maxDigestBytes,
    maxRelations,
    copy: options?.copy ?? {},
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function keysExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && Object.keys(value).length === keys.length;
}

function stringValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || stringValue(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function dateUtc(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function stableCopyError(error: unknown): ExportError {
  if (error instanceof ExportError && error.code.startsWith("copy_")) {
    return readerError("reader_copy_malformed");
  }
  return error instanceof ExportError ? error : readerError("reader_copy_consumer_failed");
}

function fingerprint(info: Stats): Fingerprint {
  if (!Number.isSafeInteger(info.size)) throw readerError("reader_relation_integrity");
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function samePathIdentity(pathInfo: Stats, fileInfo: Fingerprint): boolean {
  return pathInfo.isFile() && pathInfo.dev === fileInfo.dev && pathInfo.ino === fileInfo.ino;
}

function isOwner(info: Stats): boolean {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

async function privateDirectory(path: string, code = "reader_private_directory"): Promise<Fingerprint> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch {
    throw readerError(code);
  }
  if (info.isSymbolicLink()) throw readerError("reader_symlink_rejected");
  if (!info.isDirectory() || !isOwner(info) || (info.mode & OWNER_ONLY_MASK) !== 0 || (info.mode & 0o700) !== 0o700) {
    throw readerError(code);
  }
  let handle: FileHandle;
  try {
    // O_NONBLOCK keeps a malicious FIFO from making verification wait forever;
    // regular files ignore it, and the descriptor type is still checked below.
    handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    throw readerError(code);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !isOwner(opened) || (opened.mode & OWNER_ONLY_MASK) !== 0 || (opened.mode & 0o700) !== 0o700) {
      throw readerError(code);
    }
    const pathAfter = await lstat(path);
    if (!pathAfter.isDirectory() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw readerError("reader_artifact_changed");
    }
    return fingerprint(opened);
  } catch (error) {
    throw error instanceof ExportError ? error : readerError(code);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function privateFile(path: string, whatCode: string): Promise<OpenPrivateFile> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK keeps an untrusted FIFO from making verification wait
    // indefinitely before its descriptor type can be rejected below.
    handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw readerError("reader_symlink_rejected");
    throw readerError(
      whatCode === "manifest"
        ? "reader_manifest_unreadable"
        : whatCode === "manifest-digest"
          ? "reader_manifest_digest_unreadable"
          : "reader_relation_unreadable",
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !isOwner(info) || (info.mode & OWNER_ONLY_MASK) !== 0 || (info.mode & 0o400) === 0) {
      throw readerError("reader_private_file");
    }
    if (info.nlink !== 1) throw readerError("reader_alias_rejected");
    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink()) throw readerError("reader_symlink_rejected");
    if (!samePathIdentity(pathInfo, info)) throw readerError("reader_artifact_changed");
    return { handle, fingerprint: fingerprint(info) };
  } catch (error) {
    await handle.close().catch(() => {});
    if (error instanceof ExportError) throw error;
    throw readerError("reader_unreadable");
  }
}

async function readBounded(handle: FileHandle, initial: Fingerprint, maxBytes: number, tooLargeCode: string): Promise<Buffer> {
  if (initial.size > maxBytes) throw readerError(tooLargeCode);
  const output = Buffer.allocUnsafe(initial.size);
  let offset = 0;
  while (offset < output.length) {
    let result: { bytesRead: number };
    try {
      result = await handle.read(output, offset, output.length - offset, offset);
    } catch {
      throw readerError("reader_unreadable");
    }
    if (result.bytesRead <= 0) throw readerError("reader_unreadable");
    offset += result.bytesRead;
  }
  return output;
}

async function decodeUtf8(bytes: Uint8Array, code: string): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw readerError(code);
  }
}

async function readManifestFiles(
  root: string,
  limits: ResolvedReaderLimits,
): Promise<{ manifestBytes: Buffer; digestBytes: Buffer; manifestFingerprint: Fingerprint; digestFingerprint: Fingerprint }> {
  const manifestPath = join(root, MANIFEST_FILENAME);
  const digestPath = join(root, MANIFEST_DIGEST_FILENAME);
  const manifestFile = await privateFile(manifestPath, "manifest");
  let manifestBytes: Buffer;
  let manifestFingerprint: Fingerprint;
  try {
    manifestBytes = await readBounded(
      manifestFile.handle,
      manifestFile.fingerprint,
      limits.maxManifestBytes,
      "reader_manifest_too_large",
    );
    const final = fingerprint(await manifestFile.handle.stat());
    const pathAfter = await lstat(manifestPath);
    if (!sameFingerprint(manifestFile.fingerprint, final) || !samePathIdentity(pathAfter, final)) {
      throw readerError("reader_artifact_changed");
    }
    manifestFingerprint = final;
  } catch (error) {
    throw error instanceof ExportError ? error : readerError("reader_manifest_unreadable");
  } finally {
    await manifestFile.handle.close().catch(() => {});
  }

  const digestFile = await privateFile(digestPath, "manifest-digest");
  let digestBytes: Buffer;
  let digestFingerprint: Fingerprint;
  try {
    digestBytes = await readBounded(
      digestFile.handle,
      digestFile.fingerprint,
      limits.maxDigestBytes,
      "reader_manifest_digest_invalid",
    );
    const final = fingerprint(await digestFile.handle.stat());
    const pathAfter = await lstat(digestPath);
    if (!sameFingerprint(digestFile.fingerprint, final) || !samePathIdentity(pathAfter, final)) {
      throw readerError("reader_artifact_changed");
    }
    digestFingerprint = final;
  } catch (error) {
    throw error instanceof ExportError ? error : readerError("reader_manifest_digest_unreadable");
  } finally {
    await digestFile.handle.close().catch(() => {});
  }
  return { manifestBytes, digestBytes, manifestFingerprint, digestFingerprint };
}

function assertManifestBytes(
  files: { manifestBytes: Buffer; digestBytes: Buffer; manifestFingerprint: Fingerprint; digestFingerprint: Fingerprint },
  original:
    | { manifestBytes: Buffer; digestBytes: Buffer; manifestFingerprint: Fingerprint; digestFingerprint: Fingerprint }
    | undefined,
): void {
  const digest = parseManifestDigest(files.digestBytes);
  const actualDigest = createHash("sha256").update(files.manifestBytes).digest("hex");
  if (digest !== actualDigest) throw readerError("reader_manifest_digest_mismatch");
  if (
    original !== undefined &&
    (!files.manifestBytes.equals(original.manifestBytes) ||
      !files.digestBytes.equals(original.digestBytes) ||
      !sameFingerprint(files.manifestFingerprint, original.manifestFingerprint) ||
      !sameFingerprint(files.digestFingerprint, original.digestFingerprint))
  ) {
    throw readerError("reader_artifact_changed");
  }
}

function parseManifestDigest(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("ascii", { fatal: true }).decode(bytes);
  } catch {
    throw readerError("reader_manifest_digest_invalid");
  }
  const match = /^([0-9a-f]{64})  manifest\.json\n$/.exec(text);
  if (!match) throw readerError("reader_manifest_digest_invalid");
  return match[1];
}

function assertIdentifierArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => identifier(entry));
}

function validateRelationShape(value: unknown, maxColumns: number): value is ManifestRelation {
  const relation = record(value);
  if (
    relation === null ||
    !keysExactly(relation, [
      "schema",
      "name",
      "rowsReportedByServer",
      "rowsCountedOnWire",
      "bytes",
      "sha256",
      "columns",
      "durationMs",
      "file",
    ]) ||
    !identifier(relation.schema) ||
    !identifier(relation.name) ||
    !nonNegativeSafeInteger(relation.rowsReportedByServer) ||
    !nonNegativeSafeInteger(relation.rowsCountedOnWire) ||
    relation.rowsReportedByServer !== relation.rowsCountedOnWire ||
    !nonNegativeSafeInteger(relation.bytes) ||
    typeof relation.sha256 !== "string" ||
    !SHA256.test(relation.sha256) ||
    !assertIdentifierArray(relation.columns) ||
    relation.columns.length > maxColumns ||
    new Set(relation.columns).size !== relation.columns.length ||
    typeof relation.durationMs !== "number" ||
    !Number.isFinite(relation.durationMs) ||
    relation.durationMs < 0 ||
    relation.file !== `relations/${relation.schema}.${relation.name}.copy`
  ) {
    return false;
  }
  return true;
}

function validateManifestShape(value: unknown, maxRelations: number): value is RunManifest {
  const manifest = record(value);
  if (
    manifest === null ||
    !keysExactly(manifest, [
      "manifest_version",
      "run_id",
      "status",
      "produced_by",
      "source",
      "snapshot",
      "output",
      "relations",
      "totals",
      "timing",
    ]) ||
    manifest.manifest_version !== 2 ||
    typeof manifest.run_id !== "string" ||
    !RUN_ID.test(manifest.run_id) ||
    manifest.status !== "complete" ||
    !Array.isArray(manifest.relations) ||
    manifest.relations.length === 0 ||
    manifest.relations.length > maxRelations
  ) {
    return false;
  }

  const produced = record(manifest.produced_by);
  if (
    produced === null ||
    !keysExactly(produced, ["tool", "node_version", "code_revision"]) ||
    !stringValue(produced.tool) ||
    !stringValue(produced.node_version) ||
    !nullableString(produced.code_revision)
  ) {
    return false;
  }

  const source = record(manifest.source);
  const identity = source === null ? null : record(source.identity);
  if (
    source === null ||
    identity === null ||
    !keysExactly(source, [
      "label",
      "transport",
      "host",
      "port",
      "database",
      "user",
      "project_ref",
      "tls_protocol",
      "identity",
    ]) ||
    !keysExactly(identity, [
      "currentDatabase",
      "currentUser",
      "sessionUser",
      "serverVersion",
      "serverVersionNum",
      "systemIdentifier",
      "inRecovery",
      "schemasPresent",
      "transactionIsolation",
      "transactionReadOnly",
      "projectRef",
    ]) ||
    !stringValue(source.label) ||
    (source.transport !== "tcp" && source.transport !== "unix-socket") ||
    !stringValue(source.host) ||
    !nonNegativeSafeInteger(source.port) ||
    source.port < 1 ||
    source.port > 65535 ||
    !stringValue(source.database) ||
    !stringValue(source.user) ||
    !nullableString(source.project_ref) ||
    !nullableString(source.tls_protocol) ||
    !stringValue(identity.currentDatabase) ||
    !stringValue(identity.currentUser) ||
    !stringValue(identity.sessionUser) ||
    !stringValue(identity.serverVersion) ||
    !nonNegativeSafeInteger(identity.serverVersionNum) ||
    identity.serverVersionNum < 1 ||
    !nullableString(identity.systemIdentifier) ||
    typeof identity.inRecovery !== "boolean" ||
    !Array.isArray(identity.schemasPresent) ||
    identity.schemasPresent.some((entry) => !stringValue(entry)) ||
    !stringValue(identity.transactionIsolation) ||
    !stringValue(identity.transactionReadOnly) ||
    !nullableString(identity.projectRef) ||
    identity.currentDatabase !== source.database ||
    identity.currentUser !== source.user ||
    identity.projectRef !== source.project_ref ||
    (source.transport === "tcp" ? source.tls_protocol === null : source.tls_protocol !== null)
  ) {
    return false;
  }

  const snapshot = record(manifest.snapshot);
  if (snapshot !== null && !Object.hasOwn(snapshot, "row_security")) {
    throw readerError("reader_row_security_missing");
  }
  if (snapshot !== null && !Object.hasOwn(snapshot, "session_settings")) {
    throw readerError("reader_session_settings_invalid");
  }
  if (
    snapshot === null ||
    !keysExactly(snapshot, [
      "isolation",
      "read_only",
      "snapshot_xmin",
      "current_snapshot",
      "closing_snapshot",
      "wal_lsn",
      "wal_lsn_available",
      "statement_start_utc",
      "transaction_start_utc",
      "backend_pid",
      "session_settings",
      "row_security",
    ])
  ) {
    return false;
  }
  const settings = record(snapshot.session_settings);
  const requiredSettings = [
    "TimeZone",
    "DateStyle",
    "IntervalStyle",
    "extra_float_digits",
    "bytea_output",
    "client_encoding",
    "synchronize_seqscans",
  ] as const;
  if (
    settings === null ||
    !keysExactly(settings, requiredSettings) ||
    Object.values(settings).some((value) => typeof value !== "string") ||
    settings.TimeZone !== "UTC" ||
    settings.DateStyle !== "ISO, YMD" ||
    settings.IntervalStyle !== "iso_8601" ||
    settings.extra_float_digits !== "3" ||
    settings.bytea_output !== "hex" ||
    settings.client_encoding !== "UTF8" ||
    settings.synchronize_seqscans !== "off"
  ) {
    throw readerError("reader_session_settings_invalid");
  }
  const rowSecurity = record(snapshot.row_security);
  if (
    rowSecurity === null ||
    !keysExactly(rowSecurity, [
      "setting",
      "setting_at_close",
      "role_is_superuser",
      "role_bypasses_row_security",
    ]) ||
    rowSecurity.setting !== "off" ||
    rowSecurity.setting_at_close !== "off" ||
    (rowSecurity.role_is_superuser !== null && typeof rowSecurity.role_is_superuser !== "boolean") ||
    (rowSecurity.role_bypasses_row_security !== null && typeof rowSecurity.role_bypasses_row_security !== "boolean")
  ) {
    throw readerError("reader_row_security_missing");
  }
  if (
    snapshot.isolation !== "repeatable read" ||
    snapshot.read_only !== true ||
    typeof snapshot.snapshot_xmin !== "string" ||
    !/^\d+$/.test(snapshot.snapshot_xmin) ||
    typeof snapshot.current_snapshot !== "string" ||
    snapshot.current_snapshot.length === 0 ||
    !SNAPSHOT.test(snapshot.current_snapshot) ||
    snapshot.closing_snapshot !== snapshot.current_snapshot ||
    !nullableString(snapshot.wal_lsn) ||
    (snapshot.wal_lsn !== null && !WAL_LSN.test(snapshot.wal_lsn)) ||
    typeof snapshot.wal_lsn_available !== "boolean" ||
    (snapshot.wal_lsn_available ? snapshot.wal_lsn === null : snapshot.wal_lsn !== null) ||
    !dateUtc(snapshot.statement_start_utc) ||
    !dateUtc(snapshot.transaction_start_utc) ||
    !stringValue(snapshot.backend_pid) ||
    !/^\d+$/.test(snapshot.backend_pid)
  ) {
    throw readerError("reader_snapshot_invalid");
  }

  const output = record(manifest.output);
  if (
    output === null ||
    !keysExactly(output, ["run_directory_mode", "file_mode", "inside_git_worktree"]) ||
    !stringValue(output.run_directory_mode) ||
    !stringValue(output.file_mode) ||
    output.run_directory_mode !== "0700" ||
    output.file_mode !== "0600" ||
    !nullableString(output.inside_git_worktree)
  ) {
    return false;
  }

  const totals = record(manifest.totals);
  if (
    totals === null ||
    !keysExactly(totals, ["relations", "rows", "bytes"]) ||
    !nonNegativeSafeInteger(totals.relations) ||
    !nonNegativeSafeInteger(totals.rows) ||
    !nonNegativeSafeInteger(totals.bytes)
  ) {
    return false;
  }
  const timing = record(manifest.timing);
  if (
    timing === null ||
    !keysExactly(timing, ["started_utc", "finished_utc", "duration_ms"]) ||
    !dateUtc(timing.started_utc) ||
    !dateUtc(timing.finished_utc) ||
    typeof timing.duration_ms !== "number" ||
    !Number.isSafeInteger(timing.duration_ms) ||
    timing.duration_ms < 0
  ) {
    return false;
  }

  const relationKeys = new Set<string>();
  let rows = 0;
  let bytes = 0;
  for (const rawRelation of manifest.relations) {
    if (!validateRelationShape(rawRelation, COPY_DECODER_DEFAULT_LIMITS.maxColumns)) return false;
    const relation = rawRelation as ManifestRelation;
    const key = `${relation.schema}.${relation.name}`;
    if (relationKeys.has(key)) return false;
    relationKeys.add(key);
    rows += relation.rowsReportedByServer;
    bytes += relation.bytes;
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(bytes)) return false;
  }
  if (totals.relations !== manifest.relations.length || totals.rows !== rows || totals.bytes !== bytes) {
    throw readerError("reader_totals_mismatch");
  }
  return true;
}

function freezeManifest(manifest: RunManifest): RunManifest {
  for (const relation of manifest.relations) {
    Object.freeze(relation.columns);
    Object.freeze(relation);
  }
  Object.freeze(manifest.relations);
  Object.freeze(manifest.produced_by);
  Object.freeze(manifest.source.identity);
  Object.freeze(manifest.source);
  Object.freeze(manifest.snapshot.session_settings);
  Object.freeze(manifest.snapshot.row_security);
  Object.freeze(manifest.snapshot);
  Object.freeze(manifest.output);
  Object.freeze(manifest.totals);
  Object.freeze(manifest.timing);
  return Object.freeze(manifest);
}

function validateExpectations(expectations: ReaderExpectations, maxRelations: number): Map<string, ReaderRelationExpectation> {
  if (expectations === null || typeof expectations !== "object") throw readerError("reader_relation_set_invalid");
  if (!expectations.source || !Array.isArray(expectations.relations) || expectations.relations.length === 0) {
    throw readerError("reader_relation_set_invalid");
  }
  if (expectations.relations.length > maxRelations) throw readerError("reader_relation_set_invalid");
  const source = expectations.source;
  if (
    source.kind === "real-source"
      ? !stringValue(source.projectRef) || !stringValue(source.database) || !stringValue(source.user)
      : source.kind === "synthetic-fixture"
        ? !stringValue(source.database) || !stringValue(source.user) || (source.label !== undefined && !stringValue(source.label))
        : true
  ) {
    throw readerError("reader_relation_set_invalid");
  }
  const expected = new Map<string, ReaderRelationExpectation>();
  for (const relation of expectations.relations) {
    if (
      relation === null ||
      typeof relation !== "object" ||
      !identifier(relation.schema) ||
      !identifier(relation.name) ||
      !assertIdentifierArray(relation.columns) ||
      relation.columns.length > COPY_DECODER_DEFAULT_LIMITS.maxColumns ||
      new Set(relation.columns).size !== relation.columns.length
    ) {
      throw readerError("reader_relation_set_invalid");
    }
    const key = `${relation.schema}.${relation.name}`;
    if (expected.has(key)) throw readerError("reader_relation_set_invalid");
    expected.set(key, relation);
  }
  return expected;
}

function assertSourceExpectation(manifest: RunManifest, expected: ReaderSourceExpectation): void {
  const source = manifest.source;
  const identity = source.identity;
  if (
    source.database !== expected.database ||
    source.user !== expected.user ||
    identity.currentDatabase !== expected.database ||
    identity.currentUser !== expected.user
  ) {
    throw readerError("reader_identity_mismatch");
  }
  if (expected.kind === "real-source") {
    if (source.transport !== "tcp" || source.project_ref !== expected.projectRef || identity.projectRef !== expected.projectRef) {
      throw readerError("reader_identity_mismatch");
    }
    if (source.tls_protocol === null) throw readerError("reader_identity_mismatch");
  } else if (
    source.transport !== "unix-socket" ||
    source.project_ref !== null ||
    identity.projectRef !== null ||
    source.tls_protocol !== null ||
    (expected.label !== undefined && source.label !== expected.label)
  ) {
    throw readerError("reader_identity_mismatch");
  }
}

function assertSchemaExpectations(
  manifest: RunManifest,
  expected: Map<string, ReaderRelationExpectation>,
): Map<string, ManifestRelation> {
  if (manifest.relations.length !== expected.size) throw readerError("reader_schema_mismatch");
  const actual = new Map<string, ManifestRelation>();
  for (const relation of manifest.relations) {
    const key = `${relation.schema}.${relation.name}`;
    if (actual.has(key)) throw readerError("reader_schema_mismatch");
    const wanted = expected.get(key);
    if (!wanted || wanted.columns.length !== relation.columns.length || wanted.columns.some((column, index) => column !== relation.columns[index])) {
      throw readerError("reader_schema_mismatch");
    }
    actual.set(key, relation);
  }
  if (actual.size !== expected.size) throw readerError("reader_schema_mismatch");
  return actual;
}

async function assertRunShape(
  root: string,
  relationKeys?: ReadonlySet<string>,
): Promise<{ root: Fingerprint; relations: Fingerprint }> {
  const rootFingerprint = await privateDirectory(root);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    throw readerError("reader_run_incomplete");
  }
  const expected = new Set([MANIFEST_FILENAME, MANIFEST_DIGEST_FILENAME, RELATIONS_DIRECTORY]);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) {
    throw readerError("reader_run_incomplete");
  }
  for (const marker of [INCOMPLETE_FILENAME, FAILURE_FILENAME]) {
    if (entries.includes(marker)) throw readerError("reader_run_incomplete");
  }

  const relationsPath = join(root, RELATIONS_DIRECTORY);
  const relationsFingerprint = await privateDirectory(relationsPath);
  let relationEntries: string[];
  try {
    relationEntries = await readdir(relationsPath);
  } catch {
    throw readerError("reader_run_incomplete");
  }
  if (relationKeys === undefined) return { root: rootFingerprint, relations: relationsFingerprint };
  const expectedFiles = new Set<string>();
  for (const key of relationKeys) {
    const [schema, name] = key.split(".");
    expectedFiles.add(`${schema}.${name}.copy`);
  }
  const actualFiles = new Set(relationEntries);
  if ([...expectedFiles].some((entry) => !actualFiles.has(entry))) {
    throw readerError("reader_relation_missing");
  }
  if ([...actualFiles].some((entry) => !expectedFiles.has(entry))) {
    throw readerError("reader_relation_extra");
  }
  return { root: rootFingerprint, relations: relationsFingerprint };
}

function pathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== "" && !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

async function readRelationFile(
  root: string,
  relation: ManifestRelation,
  expectedFingerprint: Fingerprint | undefined,
  copyLimits: CopyDecoderLimits,
  onRow: CopyRowSink,
): Promise<RelationReadResult & { fingerprint: Fingerprint }> {
  const relationsPath = join(root, RELATIONS_DIRECTORY);
  const path = join(relationsPath, `${relation.schema}.${relation.name}.copy`);
  if (!pathInside(root, path) || relation.file !== `relations/${relation.schema}.${relation.name}.copy`) {
    throw readerError("reader_path_invalid");
  }
  const file = await privateFile(path, "relation");
  if (expectedFingerprint && !sameFingerprint(file.fingerprint, expectedFingerprint)) {
    await file.handle.close().catch(() => {});
    throw readerError("reader_artifact_changed");
  }
  const hash = createHash("sha256");
  const decoder = new CopyTextDecoder(relation.columns.length, copyLimits);
  const chunkSize = Math.min(64 * 1024, decoder.limits.maxInputChunkBytes);
  const chunk = Buffer.allocUnsafe(chunkSize);
  let bytes = 0;
  let decoderResult: CopyDecodeResult;
  try {
    let offset = 0;
    while (offset < file.fingerprint.size) {
      const length = Math.min(chunk.length, file.fingerprint.size - offset);
      const result = await file.handle.read(chunk, 0, length, offset);
      if (result.bytesRead <= 0) throw readerError("reader_relation_unreadable");
      const piece = chunk.subarray(0, result.bytesRead);
      hash.update(piece);
      bytes += result.bytesRead;
      offset += result.bytesRead;
      await decoder.push(piece, async (row) => {
        try {
          await onRow(row);
        } catch {
          throw readerError("reader_copy_consumer_failed");
        }
      });
    }
    decoderResult = await decoder.finish(async (row) => {
      try {
        await onRow(row);
      } catch {
        throw readerError("reader_copy_consumer_failed");
      }
    });
    const final = fingerprint(await file.handle.stat());
    const pathAfter = await lstat(path);
    if (!sameFingerprint(file.fingerprint, final) || !samePathIdentity(pathAfter, final)) {
      throw readerError("reader_artifact_changed");
    }
    const sha256 = hash.digest("hex");
    if (
      bytes !== relation.bytes ||
      decoderResult.rows !== relation.rowsReportedByServer ||
      decoderResult.rows !== relation.rowsCountedOnWire ||
      sha256 !== relation.sha256
    ) {
      throw readerError("reader_relation_integrity");
    }
    return { relation: `${relation.schema}.${relation.name}`, rows: decoderResult.rows, bytes, sha256, fingerprint: final };
  } catch (error) {
    if (error instanceof ExportError) {
      if (error.code === "reader_copy_consumer_failed") throw error;
      if (error.code === "reader_artifact_changed") throw error;
      if (error.code.startsWith("copy_")) throw readerError("reader_copy_malformed");
      throw error;
    }
    throw stableCopyError(error);
  } finally {
    await file.handle.close().catch(() => {});
  }
}

/**
 * Verify a complete v2 run and return a bounded streaming reader.
 *
 * Inspection hashes and decodes every relation before resolving. Each later
 * `streamRelationRows` call repeats those checks on the file descriptor it
 * reads, so a replacement or mutation between inspection and iteration is
 * rejected. The callback receives rows as they arrive; the returned promise
 * resolves only after the terminal framing, row count, byte count, digest and
 * descriptor identity all agree with the manifest.
 */
export async function inspectRun(
  runDirectory: string,
  expectations: ReaderExpectations,
  options?: ReaderLimits,
): Promise<VerifiedRun> {
  if (typeof runDirectory !== "string" || runDirectory.length === 0 || basename(runDirectory).endsWith(".partial")) {
    throw readerError("reader_path_invalid");
  }
  const root = resolve(runDirectory);
  const limits = resolveLimits(options);
  const expected = validateExpectations(expectations, limits.maxRelations);
  const rootShape = await assertRunShape(root);
  const files = await readManifestFiles(root, limits);
  assertManifestBytes(files, undefined);

  const manifestText = await decodeUtf8(files.manifestBytes, "reader_manifest_unparseable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw readerError("reader_manifest_unparseable");
  }
  if (!validateManifestShape(parsed, limits.maxRelations)) {
    if (record(parsed)?.manifest_version !== 2) throw readerError("reader_manifest_version");
    throw readerError("reader_manifest_invalid");
  }
  const manifest = freezeManifest(parsed);
  assertSourceExpectation(manifest, expectations.source);
  const relationMap = assertSchemaExpectations(manifest, expected);
  const manifestShape = await assertRunShape(root, new Set([...relationMap.keys()]));
  const relationFingerprints = new Map<string, Fingerprint>();
  for (const relation of manifest.relations) {
    const result = await readRelationFile(root, relation, undefined, limits.copy, async () => {});
    relationFingerprints.set(result.relation, result.fingerprint);
  }
  const finalShape = await assertRunShape(root, new Set([...relationMap.keys()]));
  const finalManifestFiles = await readManifestFiles(root, limits);
  assertManifestBytes(finalManifestFiles, files);
  if (
    !sameFingerprint(rootShape.root, manifestShape.root) ||
    !sameFingerprint(rootShape.relations, manifestShape.relations) ||
    !sameFingerprint(manifestShape.root, finalShape.root) ||
    !sameFingerprint(manifestShape.relations, finalShape.relations)
  ) {
    throw readerError("reader_artifact_changed");
  }

  const verifiedRelations = Object.freeze(
    manifest.relations.map((relation) =>
      Object.freeze({
        schema: relation.schema,
        name: relation.name,
        columns: Object.freeze([...relation.columns]),
        rows: relation.rowsReportedByServer,
        bytes: relation.bytes,
        sha256: relation.sha256,
      }),
    ),
  );

  const streamRelationRows = async (
    relation: string | Pick<ReaderRelationExpectation, "schema" | "name">,
    onRow: CopyRowSink,
  ): Promise<RelationReadResult> => {
    if (typeof onRow !== "function") throw readerError("reader_consumer_invalid");
    const key = typeof relation === "string" ? relation : `${relation.schema}.${relation.name}`;
    const selected = relationMap.get(key);
    if (!selected) throw readerError("reader_relation_unknown");
    const beforeShape = await assertRunShape(root, new Set([...relationMap.keys()]));
    if (!sameFingerprint(rootShape.root, beforeShape.root) || !sameFingerprint(rootShape.relations, beforeShape.relations)) {
      throw readerError("reader_artifact_changed");
    }
    const beforeManifestFiles = await readManifestFiles(root, limits);
    assertManifestBytes(beforeManifestFiles, files);
    const result = await readRelationFile(root, selected, relationFingerprints.get(key), limits.copy, onRow);
    const afterShape = await assertRunShape(root, new Set([...relationMap.keys()]));
    const afterManifestFiles = await readManifestFiles(root, limits);
    assertManifestBytes(afterManifestFiles, files);
    if (!sameFingerprint(rootShape.root, afterShape.root) || !sameFingerprint(rootShape.relations, afterShape.relations)) {
      throw readerError("reader_artifact_changed");
    }
    relationFingerprints.set(key, result.fingerprint);
    return {
      relation: result.relation,
      rows: result.rows,
      bytes: result.bytes,
      sha256: result.sha256,
    };
  };

  return Object.freeze({
    runDirectory: root,
    manifest,
    relations: verifiedRelations,
    streamRelationRows,
  });
}

/** Alias with an explicit name for callers that want the verification boundary in code. */
export const inspectVerifiedRun = inspectRun;
