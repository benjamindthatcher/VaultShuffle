import { createHash } from "node:crypto";
import type { IdentityEvidence } from "./profile.ts";
import type {
  RelationDigest,
  RowSecurityEvidence,
  SnapshotViewDefinition,
  SnapshotWatermark,
} from "./snapshot.ts";

/**
 * The run manifest is the only durable claim about what an export is. Every
 * field in it is evidence recorded from the run, never a restatement of what the
 * operator asked for.
 */

/**
 * 2 adds `snapshot.row_security`. No real-source version 1 run exists in this
 * project; earlier synthetic version 1 fixtures may exist, and the M3-C reader
 * rejects them explicitly. The field is required for a complete version 2 run.
 */
export const MANIFEST_VERSION = 2;
export const MANIFEST_FILENAME = "manifest.json";
export const MANIFEST_DIGEST_FILENAME = "manifest.sha256";
export const INCOMPLETE_FILENAME = "INCOMPLETE";
export const FAILURE_FILENAME = "FAILED.json";
export const SCHEMA_VIEWS_SIDECAR_SUFFIX = ".schema-views.json";

export type ManifestRelation = RelationDigest & { file: string };

export type RunManifest = {
  manifest_version: number;
  run_id: string;
  status: "complete";
  produced_by: {
    tool: string;
    node_version: string;
    code_revision: string | null;
  };
  source: {
    label: string;
    transport: string;
    host: string;
    port: number;
    database: string;
    user: string;
    project_ref: string | null;
    tls_protocol: string | null;
    identity: IdentityEvidence;
  };
  snapshot: {
    isolation: "repeatable read";
    read_only: true;
    snapshot_xmin: string;
    current_snapshot: string;
    closing_snapshot: string;
    wal_lsn: string | null;
    wal_lsn_available: boolean;
    statement_start_utc: string;
    transaction_start_utc: string;
    backend_pid: string;
    session_settings: Readonly<Record<string, string>>;
    /**
     * Why this run can claim it saw every row, not just the rows a policy
     * admits. `setting` and `setting_at_close` are both `off` on any manifest
     * that exists, because a run that could not hold that never gets one.
     */
    row_security: {
      setting: string;
      setting_at_close: string;
      role_is_superuser: boolean | null;
      role_bypasses_row_security: boolean | null;
    };
  };
  output: {
    run_directory_mode: string;
    file_mode: string;
    inside_git_worktree: string | null;
  };
  relations: readonly ManifestRelation[];
  totals: {
    relations: number;
    rows: number;
    bytes: number;
  };
  timing: {
    started_utc: string;
    finished_utc: string;
    duration_ms: number;
  };
};

/**
 * Supplementary view bodies captured in the export transaction.
 *
 * This stays adjacent to the run so manifest-v2 readers retain their strict
 * three-entry run-directory contract. The run id, source identity, transaction
 * watermark and manifest digest bind it unambiguously to one completed export.
 */
export type SchemaViewsSidecar = {
  sidecar_version: 1;
  run_id: string;
  manifest_sha256: string;
  source: {
    project_ref: string | null;
    database: string;
    current_user: string;
  };
  snapshot: {
    snapshot_xmin: string;
    current_snapshot: string;
    transaction_start_utc: string;
  };
  views: readonly SnapshotViewDefinition[];
};

/**
 * JSON with object keys in sorted order.
 *
 * `JSON.stringify` preserves insertion order, so a manifest assembled in a
 * different code path would digest differently while describing the same run.
 * Sorting makes the manifest digest a property of the content.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeys(source[key]);
  }
  return sorted;
}

export function serializeManifest(manifest: RunManifest): { text: string; sha256: string } {
  const text = `${stableStringify(manifest)}\n`;
  return { text, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

export function schemaViewsSidecarFilename(runId: string): string {
  return `${runId}${SCHEMA_VIEWS_SIDECAR_SUFFIX}`;
}

export function buildSchemaViewsSidecar(input: {
  runId: string;
  manifestSha256: string;
  identity: IdentityEvidence;
  watermark: SnapshotWatermark;
  views: readonly SnapshotViewDefinition[];
}): SchemaViewsSidecar {
  return {
    sidecar_version: 1,
    run_id: input.runId,
    manifest_sha256: input.manifestSha256,
    source: {
      project_ref: input.identity.projectRef,
      database: input.identity.currentDatabase,
      current_user: input.identity.currentUser,
    },
    snapshot: {
      snapshot_xmin: input.watermark.snapshotXmin,
      current_snapshot: input.watermark.currentSnapshot,
      transaction_start_utc: input.watermark.transactionStartUtc,
    },
    views: input.views,
  };
}

export function buildManifest(input: {
  runId: string;
  codeRevision: string | null;
  profile: {
    label: string;
    transport: string;
    host: string;
    port: number;
    database: string;
    user: string;
  };
  tlsProtocol: string | null;
  identity: IdentityEvidence;
  watermark: SnapshotWatermark;
  closingSnapshot: string;
  sessionSettings: Readonly<Record<string, string>>;
  rowSecurity: RowSecurityEvidence;
  walLsnAvailable: boolean;
  relations: readonly ManifestRelation[];
  runDirectoryMode: string;
  fileMode: string;
  insideGitWorktree: string | null;
  startedUtc: string;
  finishedUtc: string;
  durationMs: number;
}): RunManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    run_id: input.runId,
    status: "complete",
    produced_by: {
      tool: "vaultshuffle-v2-migration-export",
      node_version: process.version,
      code_revision: input.codeRevision,
    },
    source: {
      label: input.profile.label,
      transport: input.profile.transport,
      host: input.profile.host,
      port: input.profile.port,
      database: input.profile.database,
      user: input.profile.user,
      project_ref: input.identity.projectRef,
      tls_protocol: input.tlsProtocol,
      identity: input.identity,
    },
    snapshot: {
      isolation: "repeatable read",
      read_only: true,
      snapshot_xmin: input.watermark.snapshotXmin,
      current_snapshot: input.watermark.currentSnapshot,
      closing_snapshot: input.closingSnapshot,
      wal_lsn: input.watermark.walLsn,
      wal_lsn_available: input.walLsnAvailable,
      statement_start_utc: input.watermark.statementStartUtc,
      transaction_start_utc: input.watermark.transactionStartUtc,
      backend_pid: input.watermark.backendPid,
      session_settings: input.sessionSettings,
      row_security: {
        setting: input.rowSecurity.setting,
        setting_at_close: input.rowSecurity.settingAtClose,
        role_is_superuser: input.rowSecurity.roleIsSuperuser,
        role_bypasses_row_security: input.rowSecurity.roleBypassesRowSecurity,
      },
    },
    output: {
      run_directory_mode: input.runDirectoryMode,
      file_mode: input.fileMode,
      inside_git_worktree: input.insideGitWorktree,
    },
    relations: input.relations,
    totals: {
      relations: input.relations.length,
      rows: input.relations.reduce((sum, relation) => sum + relation.rowsReportedByServer, 0),
      bytes: input.relations.reduce((sum, relation) => sum + relation.bytes, 0),
    },
    timing: {
      started_utc: input.startedUtc,
      finished_utc: input.finishedUtc,
      duration_ms: input.durationMs,
    },
  };
}
