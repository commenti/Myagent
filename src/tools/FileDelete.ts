/**
 * src/tools/FileDelete.ts
 * -----------------------
 * Deletes a single regular file inside the working directory.
 *
 * Rules:
 *   • Refuses to delete anything that is not a regular file (no directories,
 *     no symlinks, no devices). This is the strongest safety guarantee: a
 *     typo can never take out a whole tree.
 *   • PathGuard blocks anything outside cwd (including symlink escapes).
 *   • PermissionManager.checkFileOp("delete", ...) is consulted before removal.
 *   • Best-effort: a prior mtime can be supplied so a stale target is refused.
 *   • Post-delete verify: if the file still exists, that is an error.
 *
 * No caching. No side effects beyond the single file.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { PathGuard, PathGuardError } from "../policy/PathGuard";
import type { PermissionManager } from "../policy/PermissionManager";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface FileDeleteOptions {
  readonly cwd: string;
  /** Path relative to cwd, or absolute inside cwd. */
  readonly filePath: string;
  /** Optional permission manager — if provided, checkFileOp is called. */
  readonly permissions?: PermissionManager;
  /** If true, do everything except unlink. */
  readonly dryRun?: boolean;
  /**
   * Optional: expected mtime from a prior read. If provided and it differs,
   * the delete aborts before unlinking.
   */
  readonly expectMtimeIso?: string;
}

export interface FileDeleteResult {
  readonly relPath: string;
  readonly absPath: string;
  /** Size of the removed file in bytes. */
  readonly bytes: number;
  /** mtime of the file just before it was removed (ISO). */
  readonly mtimeBeforeIso: string;
  readonly dryRun: boolean;
}

export type FileDeleteErrorCode =
  | "not_found"
  | "not_a_file"
  | "blocked"
  | "denied"
  | "stale_mtime"
  | "io_error"
  | "verify_failed";

export class FileDeleteError extends Error {
  public readonly code: FileDeleteErrorCode;
  public readonly relPath: string;
  constructor(code: FileDeleteErrorCode, relPath: string, message: string) {
    super(message);
    this.name = "FileDeleteError";
    this.code = code;
    this.relPath = relPath;
  }
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Delete a file. Throws FileDeleteError on any problem.
 */
export async function deleteFile(
  opts: FileDeleteOptions
): Promise<FileDeleteResult> {
  const guard = new PathGuard(opts.cwd);

  // 1. Guard + resolve (real, so symlinks are checked).
  let absPath: string;
  try {
    absPath = guard.resolveSafeReal(opts.filePath);
  } catch (err) {
    if (err instanceof PathGuardError) {
      throw new FileDeleteError("blocked", opts.filePath, err.message);
    }
    throw err;
  }
  const relPath = path.relative(guard.workingDir, absPath) || path.basename(absPath);

  // 2. lstat — must be a regular file, not a directory or symlink.
  let lst: import("fs").Stats;
  try {
    lst = await fs.lstat(absPath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new FileDeleteError("not_found", relPath, "file not found: " + relPath);
    }
    throw new FileDeleteError(
      "io_error",
      relPath,
      "lstat failed: " + (err instanceof Error ? err.message : String(err))
    );
  }
  if (lst.isSymbolicLink()) {
    throw new FileDeleteError(
      "not_a_file",
      relPath,
      "refusing to delete a symlink: " + relPath
    );
  }
  if (!lst.isFile()) {
    throw new FileDeleteError(
      "not_a_file",
      relPath,
      "refusing to delete: not a regular file (" + relPath + ")"
    );
  }

  const mtimeBeforeIso = new Date(lst.mtimeMs).toISOString();

  // 3. Optional mtime guard.
  if (opts.expectMtimeIso && opts.expectMtimeIso !== mtimeBeforeIso) {
    throw new FileDeleteError(
      "stale_mtime",
      relPath,
      "file changed on disk since last read (was " +
        opts.expectMtimeIso + ", now " + mtimeBeforeIso + ")"
    );
  }

  // 4. Permission check.
  if (opts.permissions) {
    const decision = await opts.permissions.checkFileOp("delete", relPath);
    if (decision !== "allow") {
      throw new FileDeleteError(
        "denied",
        relPath,
        "permission denied for delete: " + relPath
      );
    }
  }

  // 5. Dry run — nothing removed.
  if (opts.dryRun) {
    return {
      relPath,
      absPath,
      bytes: lst.size,
      mtimeBeforeIso,
      dryRun: true,
    };
  }

  // 6. Unlink.
  try {
    await fs.unlink(absPath);
  } catch (err) {
    throw new FileDeleteError(
      "io_error",
      relPath,
      "unlink failed: " + (err instanceof Error ? err.message : String(err))
    );
  }

  // 7. Verify the file is really gone.
  try {
    await fs.access(absPath);
    // If we get here, the file still exists.
    throw new FileDeleteError(
      "verify_failed",
      relPath,
      "file still exists after delete: " + relPath
    );
  } catch (err) {
    if (err instanceof FileDeleteError) throw err;
    // access() threw → file is gone, which is what we wanted.
  }

  return {
    relPath,
    absPath,
    bytes: lst.size,
    mtimeBeforeIso,
    dryRun: false,
  };
}