import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import {
  buildManifest,
  serializeManifest,
  type ManifestRelation,
  type RunManifest,
} from "../export/manifest.ts";
import { ExportError } from "../shared/redaction.ts";
import { inspectRun, type ReaderExpectations } from "./reader.ts";

let root = "";
let runNumber = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "vs-reader-"));
  await chmod(root, 0o700);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function relationEvidence(bytes: Buffer, overrides: Partial<ManifestRelation> = {}): ManifestRelation {
  return {
    schema: "public",
    name: "items",
    rowsReportedByServer: 2,
    rowsCountedOnWire: 2,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    columns: ["id", "value"],
    durationMs: 0,
    file: "relations/public.items.copy",
    ...overrides,
  };
}

function baseManifest(relation: ManifestRelation): RunManifest {
  return buildManifest({
    runId: `20260910-reader-${runNumber}`,
    codeRevision: null,
    profile: {
      label: "reader synthetic fixture",
      transport: "unix-socket",
      host: "/tmp/vs-m3",
      port: 55441,
      database: "vaultshuffle_m3_export_a",
      user: "vault_local_admin",
    },
    tlsProtocol: null,
    identity: {
      currentDatabase: "vaultshuffle_m3_export_a",
      currentUser: "vault_local_admin",
      sessionUser: "vault_local_admin",
      serverVersion: "PostgreSQL 17.6",
      serverVersionNum: 170006,
      systemIdentifier: null,
      inRecovery: false,
      schemasPresent: ["public"],
      transactionIsolation: "repeatable read",
      transactionReadOnly: "on",
      projectRef: null,
    },
    watermark: {
      snapshotXmin: "100",
      currentSnapshot: "100:200:",
      walLsn: null,
      statementStartUtc: "2026-09-10T12:00:00.000Z",
      transactionStartUtc: "2026-09-10T12:00:00.000Z",
      backendPid: "1234",
    },
    closingSnapshot: "100:200:",
    sessionSettings: {
      TimeZone: "UTC",
      DateStyle: "ISO, YMD",
      IntervalStyle: "iso_8601",
      extra_float_digits: "3",
      bytea_output: "hex",
      client_encoding: "UTF8",
      synchronize_seqscans: "off",
    },
    rowSecurity: {
      setting: "off",
      settingAtClose: "off",
      roleIsSuperuser: true,
      roleBypassesRowSecurity: true,
    },
    walLsnAvailable: false,
    relations: [relation],
    runDirectoryMode: "0700",
    fileMode: "0600",
    insideGitWorktree: null,
    startedUtc: "2026-09-10T12:00:00.000Z",
    finishedUtc: "2026-09-10T12:00:00.001Z",
    durationMs: 1,
  });
}

async function writeRun(
  bytes = Buffer.from("1\tfirst\n2\tsecond\n", "utf8"),
  relationOverrides: Partial<ManifestRelation> = {},
): Promise<{ run: string; manifest: RunManifest; relationBytes: Buffer }> {
  runNumber += 1;
  const run = join(root, `run-${runNumber}`);
  const relations = join(run, "relations");
  await mkdir(relations, { recursive: true, mode: 0o700 });
  await chmod(run, 0o700);
  await chmod(relations, 0o700);
  const relation = relationEvidence(bytes, relationOverrides);
  const manifest = baseManifest(relation);
  const serialized = serializeManifest(manifest);
  await writeFile(join(relations, "public.items.copy"), bytes, { mode: 0o600 });
  await writeFile(join(run, "manifest.json"), serialized.text, { mode: 0o600 });
  await writeFile(join(run, "manifest.sha256"), `${serialized.sha256}  manifest.json\n`, { mode: 0o600 });
  return { run, manifest, relationBytes: bytes };
}

async function rewriteManifest(run: string, manifest: RunManifest, updateDigest = true): Promise<void> {
  const serialized = serializeManifest(manifest);
  await writeFile(join(run, "manifest.json"), serialized.text, { mode: 0o600 });
  if (updateDigest) await writeFile(join(run, "manifest.sha256"), `${serialized.sha256}  manifest.json\n`, { mode: 0o600 });
}

function expectations(overrides: Partial<ReaderExpectations> = {}): ReaderExpectations {
  return {
    source: {
      kind: "synthetic-fixture",
      database: "vaultshuffle_m3_export_a",
      user: "vault_local_admin",
      label: "reader synthetic fixture",
    },
    relations: [{ schema: "public", name: "items", columns: ["id", "value"] }],
    ...overrides,
  };
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<ExportError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ExportError, `expected ExportError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${code}, but nothing was thrown` });
}

test("inspectRun verifies a complete synthetic v2 run and streams exact rows", async () => {
  const fixture = await writeRun();
  const verified = await inspectRun(fixture.run, expectations());
  assert.equal(verified.manifest.manifest_version, 2);
  assert.deepEqual(verified.relations[0], {
    schema: "public",
    name: "items",
    columns: ["id", "value"],
    rows: 2,
    bytes: fixture.relationBytes.length,
    sha256: fixture.manifest.relations[0].sha256,
  });
  const rows: Array<readonly (string | null)[]> = [];
  const result = await verified.streamRelationRows({ schema: "public", name: "items" }, (row) => {
    rows.push(row);
  });
  assert.deepEqual(rows, [
    ["1", "first"],
    ["2", "second"],
  ]);
  assert.equal(result.rows, 2);
  assert.equal(result.bytes, fixture.relationBytes.length);
  assert.equal(result.sha256, fixture.manifest.relations[0].sha256);
});

test("manifest and relation evidence are verified against exact bytes", async (t) => {
  await t.test("manifest digest mismatch", async () => {
    const fixture = await writeRun();
    await writeFile(join(fixture.run, "manifest.json"), "{}\n", { mode: 0o600 });
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_manifest_digest_mismatch");
  });
  await t.test("relation bytes changed without a new manifest", async () => {
    const fixture = await writeRun();
    await writeFile(join(fixture.run, "relations", "public.items.copy"), Buffer.from("1\tprivate\n2\tsecond\n"), { mode: 0o600 });
    const error = await expectCode(() => inspectRun(fixture.run, expectations()), "reader_relation_integrity");
    assert.ok(!error.message.includes("private"));
  });
  await t.test("contradictory totals", async () => {
    const fixture = await writeRun();
    const changed = structuredClone(fixture.manifest) as RunManifest;
    changed.totals.rows += 1;
    await rewriteManifest(fixture.run, changed);
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_totals_mismatch");
  });
});

test("version, snapshot, row-security and source identity claims are required", async (t) => {
  await t.test("version 1 synthetic fixture is rejected explicitly", async () => {
    const fixture = await writeRun();
    const changed = structuredClone(fixture.manifest) as Record<string, unknown>;
    changed.manifest_version = 1;
    await rewriteManifest(fixture.run, changed as RunManifest);
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_manifest_version");
  });
  await t.test("missing row-security evidence", async () => {
    const fixture = await writeRun();
    const changed = structuredClone(fixture.manifest) as Record<string, unknown>;
    const snapshot = changed.snapshot as Record<string, unknown>;
    delete snapshot.row_security;
    await rewriteManifest(fixture.run, changed as RunManifest);
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_row_security_missing");
  });
  await t.test("opening and closing snapshots must match", async () => {
    const fixture = await writeRun();
    const changed = structuredClone(fixture.manifest) as RunManifest;
    changed.snapshot.closing_snapshot = "100:201:";
    await rewriteManifest(fixture.run, changed);
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_snapshot_invalid");
  });
  await t.test("source identity and fixture class cannot be substituted", async () => {
    const fixture = await writeRun();
    await expectCode(
      () => inspectRun(fixture.run, expectations({ source: { kind: "synthetic-fixture", database: "other", user: "vault_local_admin" } })),
      "reader_identity_mismatch",
    );
    await expectCode(
      () => inspectRun(
        fixture.run,
        expectations({ source: { kind: "real-source", projectRef: "project-ref", database: "vaultshuffle_m3_export_a", user: "vault_local_admin" } }),
      ),
      "reader_identity_mismatch",
    );
  });
});

test("relation and column expectations are explicit and exact", async (t) => {
  await t.test("missing, extra and reordered columns", async () => {
    const fixture = await writeRun();
    await expectCode(
      () => inspectRun(fixture.run, expectations({ relations: [{ schema: "public", name: "items", columns: ["id"] }] })),
      "reader_schema_mismatch",
    );
    await expectCode(
      () => inspectRun(fixture.run, expectations({ relations: [{ schema: "public", name: "other", columns: ["id", "value"] }] })),
      "reader_schema_mismatch",
    );
    await expectCode(
      () => inspectRun(fixture.run, expectations({ relations: [{ schema: "public", name: "items", columns: ["value", "id"] }] })),
      "reader_schema_mismatch",
    );
  });
  await t.test("manifest file traversal and duplicate relations", async () => {
    const fixture = await writeRun();
    const changed = structuredClone(fixture.manifest) as RunManifest;
    changed.relations[0].file = "../../outside.copy";
    await rewriteManifest(fixture.run, changed);
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_manifest_invalid");

    const duplicate = await writeRun();
    const duplicated = structuredClone(duplicate.manifest) as RunManifest;
    duplicated.relations = [duplicated.relations[0], duplicated.relations[0]];
    duplicated.totals.relations = 2;
    duplicated.totals.rows *= 2;
    duplicated.totals.bytes *= 2;
    await rewriteManifest(duplicate.run, duplicated);
    await expectCode(() => inspectRun(duplicate.run, expectations()), "reader_manifest_invalid");
  });
});

test("partial markers, symlinks, aliases and non-private files are rejected", async (t) => {
  await t.test("unfinished marker", async () => {
    const fixture = await writeRun();
    await writeFile(join(fixture.run, "INCOMPLETE"), "", { mode: 0o600 });
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_run_incomplete");

    const failed = await writeRun();
    await writeFile(join(failed.run, "FAILED.json"), "{}\n", { mode: 0o600 });
    await expectCode(() => inspectRun(failed.run, expectations()), "reader_run_incomplete");
    await expectCode(() => inspectRun(`${failed.run}.partial`, expectations()), "reader_path_invalid");
  });
  await t.test("unexpected relation file", async () => {
    const fixture = await writeRun();
    await writeFile(join(fixture.run, "relations", "unexpected.copy"), "", { mode: 0o600 });
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_relation_extra");
  });
  await t.test("missing relation file", async () => {
    const fixture = await writeRun();
    await unlink(join(fixture.run, "relations", "public.items.copy"));
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_relation_missing");
  });
  await t.test("relation symlink", async () => {
    const fixture = await writeRun();
    const path = join(fixture.run, "relations", "public.items.copy");
    const outside = join(root, "outside.copy");
    await writeFile(outside, fixture.relationBytes, { mode: 0o600 });
    await unlink(path);
    await symlink(outside, path);
    const error = await expectCode(() => inspectRun(fixture.run, expectations()), "reader_symlink_rejected");
    assert.ok(!error.message.includes(outside));
  });
  await t.test("hard-link alias", async () => {
    const fixture = await writeRun();
    await link(join(fixture.run, "relations", "public.items.copy"), join(root, "outside-alias.copy"));
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_alias_rejected");
  });
  await t.test("file mode", async () => {
    const fixture = await writeRun();
    await chmod(join(fixture.run, "relations", "public.items.copy"), 0o644);
    await expectCode(() => inspectRun(fixture.run, expectations()), "reader_private_file");
  });
});

function createFifo(path: string): void {
  const result = spawnSync("mkfifo", ["-m", "600", path], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(result.error, undefined, result.error?.message ?? "mkfifo failed to start");
  assert.equal(result.status, 0, result.stderr || "mkfifo failed");
}

function inspectFifoInBoundedChild(run: string): void {
  const readerModule = pathToFileURL(join(process.cwd(), "lib/v2/migration/read/reader.ts")).href;
  const script = `
    import { inspectRun } from ${JSON.stringify(readerModule)};
    const expectations = {
      source: {
        kind: "synthetic-fixture",
        database: "vaultshuffle_m3_export_a",
        user: "vault_local_admin",
        label: "reader synthetic fixture",
      },
      relations: [{ schema: "public", name: "items", columns: ["id", "value"] }],
    };
    try {
      await inspectRun(process.env.READER_FIFO_RUN, expectations);
      process.exitCode = 0;
    } catch (error) {
      process.exitCode = error && error.code === "reader_private_file" ? 2 : 3;
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "test",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        READER_FIFO_RUN: run,
      },
      encoding: "utf8",
      timeout: 1_500,
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? "reader child failed to start");
  assert.equal(result.signal, null, result.stderr || "reader child was terminated");
  assert.equal(result.status, 2, result.stderr || "FIFO was not rejected as a private-file artifact");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

test("manifest, digest and relation FIFOs are rejected without blocking", async (t) => {
  const cases = [
    ["manifest", "manifest.json"],
    ["digest", "manifest.sha256"],
    ["relation", join("relations", "public.items.copy")],
  ] as const;
  for (const [label, relativePath] of cases) {
    await t.test(label, async () => {
      const fixture = await writeRun();
      const path = join(fixture.run, relativePath);
      await unlink(path);
      createFifo(path);
      try {
        inspectFifoInBoundedChild(fixture.run);
      } finally {
        await rm(fixture.run, { recursive: true, force: true });
      }
    });
  }
});

test("private sentinels never enter reader diagnostics", async () => {
  const sentinel = "PRIVATE-NOTE-9f4a7c2e";
  const bytes = Buffer.from(`${sentinel}\\q\n`, "utf8");
  const fixture = await writeRun(bytes, { rowsReportedByServer: 1, rowsCountedOnWire: 1 });
  const error = await expectCode(() => inspectRun(fixture.run, expectations()), "reader_copy_malformed");
  assert.ok(!error.message.includes(sentinel));
  assert.ok(!JSON.stringify(error).includes(sentinel));
});

test("a file replacement during streaming is detected after rows are staged", async () => {
  const fixture = await writeRun();
  const verified = await inspectRun(fixture.run, expectations());
  let seen = 0;
  await expectCode(
    () =>
      verified.streamRelationRows("public.items", async () => {
        seen += 1;
        if (seen === 1) {
          await writeFile(join(fixture.run, "relations", "public.items.copy"), fixture.relationBytes, { mode: 0o600 });
        }
      }),
    "reader_artifact_changed",
  );
  assert.equal(seen, 2, "the reader delivered rows before the final integrity gate; callers must roll back staged writes");
});

test("manifest replacement between inspection and streaming is detected", async () => {
  const fixture = await writeRun();
  const verified = await inspectRun(fixture.run, expectations());
  const changed = structuredClone(fixture.manifest) as RunManifest;
  changed.source.label = "changed-after-inspection";
  await rewriteManifest(fixture.run, changed);
  await expectCode(() => verified.streamRelationRows("public.items", () => {}), "reader_artifact_changed");
});

test("a large synthetic stream is processed row by row without retaining the dataset", async () => {
  const rows = 50_000;
  const chunks = (async function* (): AsyncGenerator<Buffer> {
    for (let start = 0; start < rows; start += 1024) {
      let text = "";
      for (let value = start; value < Math.min(rows, start + 1024); value += 1) text += `${value}\tvalue-${value}\n`;
      yield Buffer.from(text, "utf8");
    }
  })();
  let seen = 0;
  const { decodeCopyText } = await import("./copy-text.ts");
  const result = await decodeCopyText(chunks, 2, (row) => {
    assert.equal(row[1], `value-${seen}`);
    seen += 1;
  });
  assert.equal(result.rows, rows);
  assert.equal(seen, rows);
});

test("manifest limits reject oversized untrusted JSON before parsing", async () => {
  const fixture = await writeRun();
  const bytes = await readFile(join(fixture.run, "manifest.json"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(fixture.run, "manifest.sha256"), `${digest}  manifest.json\n`, { mode: 0o600 });
  await expectCode(
    () => inspectRun(fixture.run, expectations(), { maxManifestBytes: bytes.length - 1 }),
    "reader_manifest_too_large",
  );
});
