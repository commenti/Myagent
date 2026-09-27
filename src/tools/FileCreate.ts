/**
 * src/tools/FileCreate.ts
 * -----------------------
 * Creates a new file inside the working directory.
 *
 * Rules:
 *   • Refuses if the file already exists — use FilePatchEdit for edits.
 *   • PathGuard blocks anything outside cwd (including symlink escapes).
 *   • PermissionManager is consulted before writing.
 *   • Parent directories are created on demand, but only inside cwd.
 *   • Atomic write (temp + rename). Post-write verify. Rollback on mismatch.
 *
 * No caching. No side effects beyond the new file.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { PathGuard, PathGuardError } from "../policy/PathGuard";
import type { PermissionManager } from "../policy/PermissionManager";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface FileCreateOptions {
  readonly cwd: string;
  /** Path relative to cwd, or absolute inside cwd. */
  readonly filePath: string;
  /** Contents to write (UTF-8). */
  readonly content: string;
  /** Optional permission manager — if provided, checkFileOp is called. */
  readonly permissions?: PermissionManager;
  /** If true, overwrite an existing file. Default false. */
  readonly overwrite?: boolean;
  /** If true, do everything except write. */
  readonly dryRun?: boolean;
  /** Optional mode (e.g. 0o755). Default: 0o644. */
  readonly mode?: number;
}

export interface FileCreateResult {
  readonly relPath: string;
  readonly absPath: string;
  readonly bytes: number;
  readonly totalLines: number;
  readonly createdDirs: readonly string[];
  readonly mtimeIso: string;
  readonly dryRun: boolean;
}


export class FileCreateError extends Error {
  public readonly code:
    | "already_exists"
    | "blocked"
    | "denied"
    | "parent_not_dir"
    | "io_error"
    | "verify_failed";
  public readonly relPath: string;
  constructor(code: FileCreateError["code"], relPath: string, message: string) {
    super(message);
    this.name = "FileCreateError";
    this.code = code;
    this.relPath = relPath;
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureParents(
  absPath: string,
  rootDir: string
): Promise<string[]> {
  const dir = path.dirname(absPath);
  const created: string[] = [];

  // Walk from rootDir down to dir, creating any missing segments.
  const rel = path.relative(rootDir, dir);
  if (rel === "" || rel.startsWith("..")) {
    // dir === rootDir or outside (shouldn't happen — PathGuard already checked)
    return created;
  }

  const parts = rel.split(path.sep);
  let cur = rootDir;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!(await exists(cur))) {
      await fs.mkdir(cur);
      created.push(cur);
    } else {
      const st = await fs.stat(cur);
      if (!st.isDirectory()) {
        throw new FileCreateError(
          "parent_not_dir",
          cur,
          `parent path is not a directory: ${cur}`
        );
      }
    }
  }
  return created;
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.agent-cli-${process.pid}-${Date.now()}.tmp`
  );
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, absPath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Create a new file. Throws FileCreateError on any problem.
 */
export async function createFile(
  opts: FileCreateOptions
): Promise<FileCreateResult> {
  const guard = new PathGuard(opts.cwd);

  let absPath: string;
  try {
    absPath = guard.resolveSafeReal(opts.filePath);
  } catch (err) {
    if (err instanceof PathGuardError) {
      throw new FileCreateError("blocked", opts.filePath, err.message);
    }
    throw err;
  }
  const relPath = path.relative(guard.workingDir, absPath) || path.basename(absPath);

  // 1. Existence check.
  if (await exists(absPath)) {
    if (!opts.overwrite) {
      throw new FileCreateError(
        "already_exists",
        relPath,
        `file already exists: ${relPath} (use FilePatchEdit to change it)`
      );
    }
    const st = await fs.stat(absPath);
    if (!st.isFile()) {
      throw new FileCreateError(
        "already_exists",
        relPath,
        `path exists and is not a regular file: ${relPath}`
      );
    }
  }

  // 2. Permission check.
  if (opts.permissions) {
    const decision = await opts.permissions.checkFileOp("create", relPath);
    if (decision !== "allow") {
      throw new FileCreateError("denied", relPath, `permission denied for create: ${relPath}`);
    }
  }

  // 3. Dry run — nothing written.
  if (opts.dryRun) {
    const bytes = Buffer.byteLength(opts.content, "utf8");
    return {
      relPath,
      absPath,
      bytes,
      totalLines: opts.content.split("\n").length,
      createdDirs: [],
      mtimeIso: new Date().toISOString(),
      dryRun: true,
    };
  }

  // 4. Ensure parent directories exist (inside cwd only).
  let createdDirs: string[] = [];
  try {
    createdDirs = await ensureParents(absPath, guard.workingDir);
  } catch (err) {
    if (err instanceof FileCreateError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new FileCreateError("io_error", relPath, `mkdir failed: ${msg}`);
  }

  // 5. Atomic write.
  try {
    await atomicWrite(absPath, opts.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FileCreateError("io_error", relPath, `write failed: ${msg}`);
  }

  // 6. Optional mode.
  if (typeof opts.mode === "number") {
    try {
      await fs.chmod(absPath, opts.mode);
    } catch {
      /* best-effort — do not fail creation over chmod */
    }
  }

  // 7. Verify.
  let afterStat: import("fs").Stats;
  let afterRaw: string;
  try {
    afterStat = await fs.stat(absPath);
    afterRaw = (await fs.readFile(absPath)).toString("utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FileCreateError("verify_failed", relPath, `verify failed: ${msg}`);
  }
  if (afterRaw !== opts.content) {
    try { await fs.unlink(absPath); } catch { /* ignore */ }
    throw new FileCreateError(
      "verify_failed",
      relPath,
      "post-write verification failed — file removed"
    );
  }

  return {
    relPath,
    absPath,
    bytes: afterStat.size,
    totalLines: opts.content.split("\n").length,
    createdDirs: createdDirs.map((d) =>
      path.relative(guard.workingDir, d) || path.basename(d)
    ),
    mtimeIso: new Date(afterStat.mtimeMs).toISOString(),
    dryRun: false,
  };
}