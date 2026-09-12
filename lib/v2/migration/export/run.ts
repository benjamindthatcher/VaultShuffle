import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { rename, rm, unlink } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import {
  PRIVATE_FILE_MODE,
  assertOutsideGitWorktree,
  assertPrivateOutputRoot,
  createPrivateDirectory,
  createPrivateFile,
  modeOf,
  syncDirectory,
  writePrivateFile,
} from "../shared/private-fs.ts";
import { ExportError, describeFailure } from "../shared/redaction.ts";
import {
  FAILURE_FILENAME,
  INCOMPLETE_FILENAME,
  MANIFEST_DIGEST_FILENAME,
  MANIFEST_FILENAME,
  buildManifest,
  serializeManifest,
  stableStringify,
  type ManifestRelation,
  type RunManifest,
} from "./manifest.ts";
import { assertSourceIdentity, readCaCertificatesPem, type ConnectionProfile } from "./profile.ts";
import { streamSnapshot, type ExportPlan, type RelationOutput } from "./snapshot.ts";
import { WireConnection, type WireConnectOptions } from "./wire.ts";

/**
 * Run directory naming.
 *
 * A run is written to `<run_id>.partial` and renamed to `<run_id>` only after
 * the manifest is on disk and fsynced. Two independent signals therefore mark an
 * unfinished export: the directory suffix, and the `INCOMPLETE` sentinel inside
 * it. A reader that checks neither and globs `<root>/*` for run directories
 * still never sees a partial one, because it never carries the final name.
 */
const PARTIAL_SUFFIX = ".partial";
const RELATIONS_DIRNAME = "relations";

export type ExportRunOptions = {
  profile: ConnectionProfile;
  plan: ExportPlan;
  /** Must already exist, 0700, owned by the caller. */
  outputRoot: string;
  /** Recorded in the manifest; the exporter does not shell out to git. */
  codeRevision?: string | null;
  allowInsideGitWorktree?: boolean;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Injected in tests to make an abort happen at a chosen point. */
  onRelationComplete?: (relation: ManifestRelation) => void | Promise<void>;
  /** Injected in tests to abort while a relation is still being streamed. */
  onCopyChunk?: (relation: { schema: string; name: string }, chunk: Buffer) => void;
};

export type ExportRunResult = {
  runId: string;
  runDirectory: string;
  manifest: RunManifest;
  manifestSha256: string;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30 * 60 * 1000;

function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function relationFileName(relation: { schema: string; name: string }): string {
  return `${relation.schema}.${relation.name}.copy`;
}

/**
 * A single relation's output file.
 *
 * `autoClose: false` keeps the descriptor ours after the stream ends, so the
 * fsync happens on the file we wrote rather than on a reopened path.
 */
async function openRelationFile(path: string): Promise<RelationOutput> {
  const handle = await createPrivateFile(path);
  const stream = handle.createWriteStream({ autoClose: false });
  let streamError: Error | null = null;
  stream.on("error", (error: Error) => {
    streamError = error;
  });

  return {
    sink: {
      write(chunk: Buffer): boolean {
        if (streamError) throw streamError;
        return stream.write(chunk);
      },
      /**
       * Wait for the file to catch up with the socket.
       *
       * This settles on `close` and `error` as well as `drain`, because a
       * stream that has ended or been destroyed never emits `drain` again. A
       * waiter left outstanding on one would never settle, and since the
       * connection allows only one outstanding backpressure wait, that would
       * leave the socket paused and stall every relation after this one.
       */
      whenDrained(): Promise<void> {
        if (streamError) return Promise.reject(streamError);
        if (stream.writableEnded || stream.destroyed || stream.closed) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const settle = (error?: Error) => {
            stream.off("drain", onDrain);
            stream.off("close", onSettled);
            stream.off("finish", onSettled);
            stream.off("error", onError);
            if (error) reject(error);
            else resolve();
          };
          const onDrain = () => settle();
          const onSettled = () => settle();
          const onError = (error: Error) => settle(error);
          stream.once("drain", onDrain);
          stream.once("close", onSettled);
          stream.once("finish", onSettled);
          stream.once("error", onError);
        });
      },
    },
    async finish(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      if (streamError) throw streamError;

      // fsync first, while the descriptor is still open. `autoClose: true` would
      // have the stream close the fd for us and this would fail EBADF, which is
      // the whole reason the stream is created with `autoClose: false`.
      await handle.sync();

      // A FileHandle write stream holds a reference on the handle, and
      // `FileHandle.close()` waits for every reference to be released. The
      // stream releases its reference when it is *destroyed*, not when it is
      // ended - and `autoClose: false` also sets `autoDestroy: false`, so
      // ending it is not enough. Without this explicit destroy, `close()` below
      // never settles and the export hangs after the first relation with no
      // error and no output.
      if (!stream.closed) {
        stream.destroy();
        await once(stream, "close");
      }
      if (streamError) throw streamError;
      await handle.close();
    },
    async abort(): Promise<void> {
      // An error can arrive while COPY is still writing this stream. Destroy it
      // and wait for the close event before closing the descriptor, otherwise
      // FileHandle.close() can wait forever on the stream's reference. The file
      // itself is intentionally retained as partial evidence by the run layer.
      if (!stream.closed) {
        stream.destroy();
        if (!stream.closed) await once(stream, "close");
      }
      await handle.close().catch(() => {});
    },
  };
}

/**
 * Prove the credential is not on this process's command line.
 *
 * The exporter takes a path, never a DSN, so this should always hold. It is
 * asserted rather than assumed because the failure is invisible: a password in
 * `argv` is readable by every local process through `ps`, and nothing in the
 * export output would ever show that it happened.
 */
export function assertNoCredentialInProcessArguments(
  profile: ConnectionProfile,
  argv: readonly string[] = process.argv,
): void {
  const password = profile.password;
  if (!password || password.isEmpty) return;
  const plaintext = password.reveal();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].includes(plaintext)) {
      throw new ExportError(
        "credential_in_process_arguments",
        `The source credential appears in process argument ${index}. Pass a connection file path instead; command lines are world-readable.`,
        { argument_index: index },
      );
    }
  }
}

function connectOptions(
  profile: ConnectionProfile,
  connectTimeoutMs: number,
  caCertificatesPem: string | undefined,
): WireConnectOptions {
  return {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    database: profile.database,
    password: profile.password,
    applicationName: "vaultshuffle-v2-export",
    connectTimeoutMs,
    tls:
      profile.transport === "unix-socket"
        ? { kind: "unix-socket" }
        : { kind: "verify-full", ...(caCertificatesPem ? { caCertificatesPem } : {}) },
  };
}

/**
 * Perform one export.
 *
 * On success the run directory carries its final name and a manifest. On any
 * failure it keeps the `.partial` suffix, keeps the `INCOMPLETE` sentinel, gains
 * a sanitized `FAILED.json`, and the error is rethrown. Nothing is cleaned up:
 * a failed run is evidence, and deleting it is how a silent retry loop ends up
 * looking like a success.
 */
export async function runExport(options: ExportRunOptions): Promise<ExportRunResult> {
  const startedAt = Date.now();
  const startedUtc = new Date(startedAt).toISOString();
  const profile = options.profile;

  assertNoCredentialInProcessArguments(profile);

  await assertPrivateOutputRoot(options.outputRoot);
  const insideGitWorktree = await assertOutsideGitWorktree(
    options.outputRoot,
    options.allowInsideGitWorktree === true,
  );

  const runId = newRunId(new Date(startedAt));
  const partialDirectory = join(options.outputRoot, `${runId}${PARTIAL_SUFFIX}`);
  const finalDirectory = join(options.outputRoot, runId);
  const relationsDirectory = join(partialDirectory, RELATIONS_DIRNAME);

  await createPrivateDirectory(partialDirectory);
  await createPrivateDirectory(relationsDirectory);
  // Written before anything else, so there is no instant at which a populated
  // run directory lacks the marker that says it is unfinished.
  await writePrivateFile(
    join(partialDirectory, INCOMPLETE_FILENAME),
    "This export is unfinished. Do not load it.\n" +
      "The directory is renamed out of *.partial and this file removed only after the manifest is written and fsynced.\n",
  );
  await syncDirectory(partialDirectory);

  let connection: WireConnection | null = null;
  try {
    const caCertificatesPem = await readCaCertificatesPem(profile);
    connection = await WireConnection.connect(
      connectOptions(profile, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, caCertificatesPem),
    );
    const identity = await assertSourceIdentity(connection, profile.identity);
    const tlsProtocol = profile.transport === "tcp" ? connection.tlsProtocol() : null;
    if (profile.transport === "tcp" && !tlsProtocol) {
      throw new ExportError(
        "tls_missing",
        "The connection is not TLS-protected. Refusing to read the source over a plaintext link.",
      );
    }

    const relations: ManifestRelation[] = [];
    const snapshot = await streamSnapshot(connection, {
      plan: options.plan,
      statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      openRelationOutput: async (relation) =>
        openRelationFile(join(relationsDirectory, relationFileName(relation))),
      onRelationComplete: async (digest) => {
        const entry: ManifestRelation = {
          ...digest,
          file: `${RELATIONS_DIRNAME}/${relationFileName(digest)}`,
        };
        relations.push(entry);
        await options.onRelationComplete?.(entry);
      },
      onCopyChunk: options.onCopyChunk,
    });

    const finishedAt = Date.now();
    const manifest = buildManifest({
      runId,
      codeRevision: options.codeRevision ?? null,
      profile: {
        label: profile.label,
        transport: profile.transport,
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
      },
      tlsProtocol,
      identity,
      watermark: snapshot.watermark,
      closingSnapshot: snapshot.closingSnapshot,
      sessionSettings: snapshot.sessionSettings,
      rowSecurity: snapshot.rowSecurity,
      walLsnAvailable: snapshot.walLsnAvailable,
      relations,
      runDirectoryMode: await modeOf(partialDirectory),
      fileMode: `0${PRIVATE_FILE_MODE.toString(8)}`,
      insideGitWorktree,
      startedUtc,
      finishedUtc: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
    });

    const serialized = serializeManifest(manifest);
    await writePrivateFile(join(partialDirectory, MANIFEST_FILENAME), serialized.text);
    await writePrivateFile(
      join(partialDirectory, MANIFEST_DIGEST_FILENAME),
      `${serialized.sha256}  ${MANIFEST_FILENAME}\n`,
    );
    await syncDirectory(relationsDirectory);
    await syncDirectory(partialDirectory);

    // Only now is the run complete: sentinel out, then the rename that gives the
    // directory its final name, then an fsync of the parent so the rename
    // survives a crash.
    await unlink(join(partialDirectory, INCOMPLETE_FILENAME));
    await syncDirectory(partialDirectory);
    await rename(partialDirectory, finalDirectory);
    await syncDirectory(options.outputRoot);

    return { runId, runDirectory: finalDirectory, manifest, manifestSha256: serialized.sha256 };
  } catch (error) {
    const failure = describeFailure(error);
    await writePrivateFile(
      join(partialDirectory, FAILURE_FILENAME),
      `${stableStringify({
        run_id: runId,
        status: "failed",
        failed_utc: new Date().toISOString(),
        code: failure.code,
        message: failure.message,
      })}\n`,
    ).catch(() => {
      // If even this cannot be written, the INCOMPLETE sentinel and the
      // `.partial` suffix still stand. Losing the reason is survivable; losing
      // the "do not load this" marker is not.
    });
    await syncDirectory(partialDirectory).catch(() => {});
    throw error;
  } finally {
    // A destroyed socket makes the server roll the transaction back immediately
    // rather than leaving it open until a timeout fires.
    if (connection) {
      await connection.close().catch(() => connection?.destroy());
    }
  }
}

/** Test-only helper: remove a run tree. Never called by the exporter itself. */
export async function removeRunDirectoryForTest(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
