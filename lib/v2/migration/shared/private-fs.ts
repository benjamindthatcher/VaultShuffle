import { constants as fsConstants } from "node:fs";
import { open, mkdir, stat, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { ExportError } from "./redaction.ts";

/** Directories the exporter creates. Owner only, no group, no other. */
export const PRIVATE_DIR_MODE = 0o700;
/** Files the exporter creates. Owner read/write only. */
export const PRIVATE_FILE_MODE = 0o600;

/** Any group or other permission bit at all. */
const NON_OWNER_BITS = 0o077;
/** Group or other *write*, which allows substitution of the whole subtree. */
const NON_OWNER_WRITE_BITS = 0o022;

function octal(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

/**
 * Open an existing file for reading and prove it is private *through the same
 * descriptor we will read from*.
 *
 * Checking a path with `stat` and then opening it is a time-of-check /
 * time-of-use race. Opening first and calling `fstat` on the resulting handle
 * closes it: the permissions we validate belong to the exact inode we read.
 */
export async function openPrivateFileForRead(
  path: string,
  what: string,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new ExportError(
      "private_file_unreadable",
      `Cannot open ${what} (${code}). Provide an existing, readable path.`,
      { what, errno: code },
    );
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new ExportError(
        "private_file_not_regular",
        `${what} must be a regular file.`,
        { what },
      );
    }
    if ((info.mode & NON_OWNER_BITS) !== 0) {
      throw new ExportError(
        "private_file_permissions",
        `${what} is readable or writable beyond its owner (mode ${octal(info.mode)}). Run chmod 600 on it and retry.`,
        { what, mode: octal(info.mode) },
      );
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new ExportError(
        "private_file_owner",
        `${what} is not owned by the current user.`,
        { what },
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Read a private file as UTF-8 text without ever widening its permissions. */
export async function readPrivateFile(path: string, what: string): Promise<string> {
  const handle = await openPrivateFileForRead(path, what);
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

/**
 * Validate the operator-supplied output root.
 *
 * The root must already exist. Creating it implicitly is how an export ends up
 * in a home directory or a synced folder by typo; requiring the operator to
 * create it makes the destination a deliberate act.
 */
export async function assertPrivateOutputRoot(root: string): Promise<void> {
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new ExportError(
      "output_root_missing",
      `Output root does not exist or is unreadable (${code}). Create it first with: mkdir -p <root> && chmod 700 <root>`,
      { errno: code },
    );
  }
  if (!info.isDirectory()) {
    throw new ExportError("output_root_not_directory", "Output root must be a directory.");
  }
  if ((info.mode & NON_OWNER_WRITE_BITS) !== 0) {
    throw new ExportError(
      "output_root_permissions",
      `Output root is group- or world-writable (mode ${octal(info.mode)}). Run chmod 700 on it and retry.`,
      { mode: octal(info.mode) },
    );
  }
  if ((info.mode & NON_OWNER_BITS) !== 0) {
    throw new ExportError(
      "output_root_permissions",
      `Output root is readable beyond its owner (mode ${octal(info.mode)}). Run chmod 700 on it and retry.`,
      { mode: octal(info.mode) },
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ExportError("output_root_owner", "Output root is not owned by the current user.");
  }
}

/**
 * Refuse to write an export inside a git working tree.
 *
 * A snapshot of production rows one `git add -A` away from a commit is a class
 * of accident no `.gitignore` entry reliably prevents, because the entry only
 * has to be missing once. The override exists for the case where the operator
 * genuinely has a vetted ignored path, and it is recorded in the manifest.
 */
export async function assertOutsideGitWorktree(
  root: string,
  allowInsideGitWorktree: boolean,
): Promise<string | null> {
  let current = resolve(root);
  for (;;) {
    try {
      const info = await lstat(`${current}${sep}.git`);
      if (info.isDirectory() || info.isFile()) {
        if (!allowInsideGitWorktree) {
          throw new ExportError(
            "output_inside_git_worktree",
            "Output root is inside a git working tree. Choose a path outside the repository, or pass --allow-inside-git-worktree if the path is genuinely ignored.",
          );
        }
        return current;
      }
    } catch (error) {
      if (error instanceof ExportError) throw error;
      // ENOENT here just means this ancestor is not a repository root.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Create a directory that must not already exist, at 0700 regardless of umask. */
export async function createPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIR_MODE });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "EEXIST") {
      throw new ExportError(
        "run_directory_exists",
        "Run directory already exists. An export never reuses a directory, because combining files from two snapshots is not a snapshot. Start a new run.",
      );
    }
    throw new ExportError("run_directory_create_failed", `Cannot create run directory (${code}).`, {
      errno: code,
    });
  }
  // mkdir's mode argument is masked by the process umask, so the requested 0700
  // can arrive as 0700 & ~umask. chmod is not masked.
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.chmod(PRIVATE_DIR_MODE);
  } finally {
    await handle.close();
  }
}

/** Create a new file at 0600, failing if anything is already at that path. */
export async function createPrivateFile(path: string): Promise<FileHandle> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  await handle.chmod(PRIVATE_FILE_MODE);
  return handle;
}

/** Write a small private file in one shot, durably. */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  const handle = await createPrivateFile(path);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * fsync a directory so a rename or creation survives a crash.
 *
 * Without this a run can look complete in the page cache and be missing its
 * manifest after power loss, which is exactly the "unmistakably incomplete"
 * property inverted.
 */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } catch {
    // Some platforms refuse fsync on a directory handle. The rename ordering
    // still holds; only the crash window widens.
  } finally {
    await handle.close();
  }
}

/** Report a path's mode as an octal string, for manifests and assertions. */
export async function modeOf(path: string): Promise<string> {
  const info = await stat(path);
  return octal(info.mode);
}
