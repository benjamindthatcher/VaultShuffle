import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  assertOutsideGitWorktree,
  assertPrivateOutputRoot,
  createPrivateDirectory,
  createPrivateFile,
  modeOf,
  openPrivateFileForRead,
  readPrivateFile,
  writePrivateFile,
} from "./private-fs.ts";
import { ExportError } from "./redaction.ts";
import { Secret, clearRegisteredSecretsForTest } from "./secret.ts";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "vs-privatefs-"));
  await chmod(root, 0o700);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function modeBits(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

async function expectExportError(
  run: () => Promise<unknown>,
  code: string,
): Promise<ExportError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ExportError, `expected ExportError, got ${String(error)}`);
    assert.equal(error.code, code, `message was: ${error.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${code}, but nothing was thrown` });
}

test("a connection file readable beyond its owner is rejected, one bit at a time", async () => {
  const path = join(root, "conn-modes.json");
  await writeFile(path, "{}", { mode: 0o600 });

  // Every non-owner bit, individually. Any one of them means another local
  // account can read or replace the credential.
  for (const mode of [0o640, 0o604, 0o660, 0o606, 0o644, 0o666, 0o610, 0o601, 0o700]) {
    await chmod(path, mode);
    if (mode === 0o700) break;
    const error = await expectExportError(
      () => openPrivateFileForRead(path, "connection file"),
      "private_file_permissions",
    );
    assert.match(error.message, /chmod 600/);
    assert.equal(error.details.mode, `0${mode.toString(8)}`);
  }
});

test("an owner-only connection file is accepted and readable", async () => {
  const path = join(root, "conn-ok.json");
  await writeFile(path, '{"database":"postgres"}', { mode: 0o600 });
  const handle = await openPrivateFileForRead(path, "connection file");
  await handle.close();
  assert.equal(await readPrivateFile(path, "connection file"), '{"database":"postgres"}');

  await chmod(path, 0o400);
  assert.equal(await readPrivateFile(path, "connection file"), '{"database":"postgres"}');
});

test("a missing or non-regular connection file fails with a printable reason", async () => {
  const missing = await expectExportError(
    () => readPrivateFile(join(root, "absent.json"), "connection file"),
    "private_file_unreadable",
  );
  assert.equal(missing.details.errno, "ENOENT");
  assert.ok(!missing.message.includes(root), missing.message);

  const dir = join(root, "a-directory");
  await mkdir(dir, { mode: 0o700 });
  await expectExportError(
    () => readPrivateFile(dir, "connection file"),
    "private_file_not_regular",
  );
});

test("the connection-file rejection message never contains the credential", async () => {
  clearRegisteredSecretsForTest();
  const plaintext = "hunter2-Zx9QwErTyUiOpAsDfGhJ";
  new Secret(plaintext, "source password");
  const path = join(root, "conn-leaky.json");
  await writeFile(path, JSON.stringify({ password: plaintext }), { mode: 0o644 });

  const error = await expectExportError(
    () => readPrivateFile(path, "connection file"),
    "private_file_permissions",
  );
  assert.ok(!error.message.includes(plaintext), error.message);
  assert.ok(!JSON.stringify(error).includes(plaintext));
  clearRegisteredSecretsForTest();
});

test("the output root must exist, be a directory, and be owner-only", async () => {
  await expectExportError(
    () => assertPrivateOutputRoot(join(root, "no-such-root")),
    "output_root_missing",
  );

  const file = join(root, "not-a-dir");
  await writeFile(file, "", { mode: 0o600 });
  await expectExportError(() => assertPrivateOutputRoot(file), "output_root_not_directory");

  const dir = join(root, "out-root");
  await mkdir(dir);
  for (const mode of [0o777, 0o770, 0o707, 0o750, 0o705]) {
    await chmod(dir, mode);
    const error = await expectExportError(
      () => assertPrivateOutputRoot(dir),
      "output_root_permissions",
    );
    assert.match(error.message, /chmod 700/);
  }

  await chmod(dir, 0o700);
  await assertPrivateOutputRoot(dir);
});

test("createPrivateDirectory forces 0700 even under a permissive umask", async () => {
  const previous = process.umask(0o000);
  try {
    const path = join(root, "run-umask-000");
    await createPrivateDirectory(path);
    assert.equal(await modeBits(path), PRIVATE_DIR_MODE);
    assert.equal(await modeOf(path), "0700");
  } finally {
    process.umask(previous);
  }
});

test("createPrivateFile and writePrivateFile force 0600 under a permissive umask", async () => {
  const previous = process.umask(0o000);
  try {
    const created = join(root, "created-umask-000");
    const handle = await createPrivateFile(created);
    await handle.close();
    assert.equal(await modeBits(created), PRIVATE_FILE_MODE);

    const written = join(root, "written-umask-000");
    await writePrivateFile(written, "manifest");
    assert.equal(await modeBits(written), PRIVATE_FILE_MODE);
    assert.equal(await readPrivateFile(written, "manifest"), "manifest");
  } finally {
    process.umask(previous);
  }
});

test("a run directory is never reused, because two snapshots are not one snapshot", async () => {
  const path = join(root, "run-once");
  await createPrivateDirectory(path);
  const error = await expectExportError(
    () => createPrivateDirectory(path),
    "run_directory_exists",
  );
  assert.match(error.message, /never reuses a directory/);
});

test("createPrivateFile refuses to overwrite an existing output file", async () => {
  const path = join(root, "exclusive");
  const first = await createPrivateFile(path);
  await first.close();
  await assert.rejects(() => createPrivateFile(path), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "EEXIST");
    return true;
  });
});

test("an output root inside a git working tree is refused unless explicitly allowed", async () => {
  const repo = join(root, "fake-repo");
  const nested = join(repo, "data", "exports");
  await mkdir(nested, { recursive: true, mode: 0o700 });
  await mkdir(join(repo, ".git"), { mode: 0o700 });

  await expectExportError(
    () => assertOutsideGitWorktree(nested, false),
    "output_inside_git_worktree",
  );
  assert.equal(await assertOutsideGitWorktree(nested, true), repo);

  // A worktree checkout has .git as a file, not a directory.
  const linked = join(root, "linked-worktree", "out");
  await mkdir(linked, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "linked-worktree", ".git"), "gitdir: /elsewhere\n", { mode: 0o600 });
  await expectExportError(
    () => assertOutsideGitWorktree(linked, false),
    "output_inside_git_worktree",
  );
});

test("an output root outside any working tree returns null", async () => {
  const outside = join(root, "plain", "out");
  await mkdir(outside, { recursive: true, mode: 0o700 });
  // The scratch root itself is under the system temp directory, which is not a
  // repository; if the ancestor walk ever reaches one, the assertion below says so.
  assert.equal(await assertOutsideGitWorktree(outside, false), null);
});
