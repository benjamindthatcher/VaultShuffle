import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { OrderedChecksum, sha256Text } from "./canonical.ts";
import { asLoaderError, LoaderError, loaderFailure } from "./errors.ts";
import type { CopyRow, VerifiedRun } from "../read/index.ts";

/** Private disk staging between the verified reader and all target writes. */
export type StagingLimits = Readonly<{
  maxRowsPerRelation?: number;
  maxCellsPerRelation?: number;
  maxBytesPerRelation?: number;
}>;

const DEFAULT_MAX_ROWS = 2_000_000;
const DEFAULT_MAX_CELLS = 40_000_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MAX_CONFIGURED_BYTES = 1024 * 1024 * 1024;

type StageIdentity = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; nlink: number }>;

export type StagedRelation = Readonly<{
  relation: string;
  columns: readonly string[];
  rowCount: number;
  byteCount: number;
  sourceSha256: string;
  stagedSha256: string;
  /** Bounded lazy read; staging never retains all source relations in memory. */
  readRows: () => readonly CopyRow[];
  /** Compatibility alias backed by the same sealed disk read. */
  readonly rows: readonly CopyRow[];
}>;

export type StagedRun = Readonly<{
  directory: string;
  relations: readonly StagedRelation[];
  byRelation: (relation: string) => StagedRelation;
  totalRows: number;
  fingerprint: string;
  destroy: () => void;
}>;

function identity(path: string): StageIdentity {
  const info = statSync(path);
  return Object.freeze({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, nlink: info.nlink });
}

function sameIdentity(left: StageIdentity, right: StageIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink;
}

function privateParent(path: string): boolean {
  const info = lstatSync(path);
  return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0;
}

export async function stageVerifiedRun(
  run: VerifiedRun,
  relations: readonly string[],
  directory: string,
  limits: StagingLimits = {},
): Promise<StagedRun> {
  if (!isAbsolute(directory)) throw loaderFailure("loader_stage_failed", { field: "directory" });
  const maxRows = limits.maxRowsPerRelation ?? DEFAULT_MAX_ROWS;
  const maxCells = limits.maxCellsPerRelation ?? DEFAULT_MAX_CELLS;
  const maxBytes = limits.maxBytesPerRelation ?? DEFAULT_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > DEFAULT_MAX_ROWS ||
    !Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > DEFAULT_MAX_CELLS ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONFIGURED_BYTES
  ) throw loaderFailure("loader_stage_limit", { field: "limits" });
  if (existsSync(directory)) throw loaderFailure("loader_stage_failed", { field: "directory_exists" });
  try {
    if (!privateParent(dirname(directory))) throw loaderFailure("loader_stage_failed", { field: "parent_mode" });
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "loaderCode" in error) throw error;
    throw loaderFailure("loader_stage_failed", { field: "mkdir" });
  }

  let ownsDirectory = true;
  const destroy = (): void => {
    if (!ownsDirectory) return;
    rmSync(directory, { recursive: true, force: true });
    ownsDirectory = false;
  };

  const staged: StagedRelation[] = [];
  try {
    for (const name of relations) {
      const declared = run.relations.find((entry) => `${entry.schema}.${entry.name}` === name);
      if (declared === undefined) throw loaderFailure("loader_source_coverage", { relation: name });
      const path = join(directory, `${name}.ndjson`);
      const fd = openSync(path, "wx", 0o600);
      let rows = 0;
      let cells = 0;
      let bytes = 0;
      const checksum = new OrderedChecksum();
      try {
        const result = await run.streamRelationRows(name, (row) => {
          rows += 1;
          cells += row.length;
          const line = `${JSON.stringify(row)}\n`;
          const lineBytes = Buffer.byteLength(line, "utf8");
          bytes += lineBytes;
          if (rows > maxRows || cells > maxCells || bytes > maxBytes) {
            throw loaderFailure("loader_stage_limit", { relation: name });
          }
          writeSync(fd, line, undefined, "utf8");
          checksum.update(row);
        });
        fsyncSync(fd);
        if (result.rows !== rows || result.sha256 !== declared.sha256) {
          throw loaderFailure("loader_stage_changed", { relation: name });
        }
      } finally {
        closeSync(fd);
      }
      const sealed = identity(path);
      if (sealed.size !== bytes || sealed.nlink !== 1) throw loaderFailure("loader_stage_changed", { relation: name });
      const stagedSha256 = checksum.finish().sha256;
      const readRows = (): readonly CopyRow[] => {
        const before = identity(path);
        if (!sameIdentity(before, sealed) || before.size > maxBytes) throw loaderFailure("loader_stage_changed", { relation: name });
        const text = readFileSync(path, "utf8");
        const after = identity(path);
        if (!sameIdentity(after, sealed) || (text.length > 0 && !text.endsWith("\n"))) {
          throw loaderFailure("loader_stage_changed", { relation: name });
        }
        if (text.length === 0) return Object.freeze([]);
        const values = text.slice(0, -1).split("\n").map((line) => {
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { throw loaderFailure("loader_stage_changed", { relation: name }); }
          if (!Array.isArray(parsed) || parsed.length !== declared.columns.length || parsed.some((cell) => cell !== null && typeof cell !== "string")) {
            throw loaderFailure("loader_stage_changed", { relation: name });
          }
          return Object.freeze(parsed) as CopyRow;
        });
        if (values.length !== rows) throw loaderFailure("loader_stage_changed", { relation: name });
        const verify = new OrderedChecksum();
        values.forEach((row) => verify.update(row));
        if (verify.finish().sha256 !== stagedSha256) throw loaderFailure("loader_stage_changed", { relation: name });
        return Object.freeze(values);
      };
      staged.push(Object.freeze({
        relation: name,
        columns: Object.freeze([...declared.columns]),
        rowCount: rows,
        byteCount: bytes,
        sourceSha256: declared.sha256,
        stagedSha256,
        readRows,
        get rows() { return readRows(); },
      }));
    }
  } catch (error) {
    destroy();
    throw error instanceof LoaderError ? error : asLoaderError(error, "loader_stage_failed");
  }

  const byName = new Map(staged.map((entry) => [entry.relation, entry]));
  return Object.freeze({
    directory,
    relations: Object.freeze(staged),
    byRelation: (relation: string): StagedRelation => {
      const entry = byName.get(relation);
      if (entry === undefined) throw loaderFailure("loader_source_coverage", { relation });
      return entry;
    },
    totalRows: staged.reduce((total, entry) => total + entry.rowCount, 0),
    fingerprint: sha256Text(staged.map((entry) => `${entry.relation}:${entry.stagedSha256}:${entry.rowCount}`).join("\n")),
    destroy,
  });
}

export function asRecords(relation: StagedRelation): readonly Readonly<Record<string, string | null>>[] {
  return Object.freeze(relation.readRows().map((row) => {
    if (row.length !== relation.columns.length) throw loaderFailure("loader_stage_changed", { relation: relation.relation });
    const record: Record<string, string | null> = {};
    relation.columns.forEach((column, index) => { record[column] = row[index] ?? null; });
    return Object.freeze(record);
  }));
}
