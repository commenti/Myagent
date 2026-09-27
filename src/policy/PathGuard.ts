/**
 * src/policy/PathGuard.ts
 * -----------------------
 * Enforces that every file-system path used by tools stays INSIDE the
 * working directory. This is a hard, code-level guarantee — never delegated
 * to the model via prompts.
 *
 * Handles: relative paths, absolute paths, "..", symlinks (resolved),
 * and the "/foo" vs "/foobar" prefix trap.
 */

import * as fs from "fs";
import * as path from "path";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export class PathGuardError extends Error {
  public readonly attemptedPath: string;
  public readonly workingDir: string;
  constructor(attemptedPath: string, workingDir: string, reason: string) {
    super(
      `PathGuard: blocked "${attemptedPath}" (${reason}). ` +
        `Working directory is "${workingDir}".`
    );
    this.name = "PathGuardError";
    this.attemptedPath = attemptedPath;
    this.workingDir = workingDir;
  }
}


// ------------------------------------------------------------------
// PathGuard
// ------------------------------------------------------------------

export class PathGuard {
  /** Canonical (symlink-resolved when possible) working directory. */
  private readonly root: string;

  constructor(workingDir: string) {
    const resolved = path.resolve(workingDir);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new PathGuardError(workingDir, resolved, "working directory not found");
    }
    if (!stat.isDirectory()) {
      throw new PathGuardError(workingDir, resolved, "working directory is not a folder");
    }

    // Resolve symlinks in the root itself so comparisons are consistent.
    this.root = fs.realpathSync(resolved);
  }

  /** The canonical working directory. */
  public get workingDir(): string {
    return this.root;
  }

  /**
   * Resolve a user-supplied path against the working directory WITHOUT
   * touching the filesystem, then verify it does not escape.
   * Use for paths that may not exist yet (create/delete targets).
   */
  public resolveSafe(inputPath: string): string {
    const absolute = path.isAbsolute(inputPath)
      ? path.normalize(inputPath)
      : path.resolve(this.root, inputPath);

    if (!this.isInside(this.root, absolute)) {
      throw new PathGuardError(inputPath, this.root, "escapes working directory");
    }
    return absolute;
  }

  /**
   * Same as resolveSafe, but also resolves symlinks in the deepest existing
   * ancestor of the target. Use when the target or its parents may be symlinks
   * that point outside the root.
   */
  public resolveSafeReal(inputPath: string): string {
    const absolute = this.resolveSafe(inputPath);

    // Walk up until an existing ancestor is found, realpath it, then re-attach.
    let existing = absolute;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break; // reached filesystem root
      existing = parent;
    }

    const realExisting = fs.realpathSync(existing);
    const suffix = absolute.slice(existing.length);
    const realTarget = realExisting + suffix;

    if (!this.isInside(this.root, realTarget)) {
      throw new PathGuardError(inputPath, this.root, "resolves outside working directory (symlink)");
    }
    return absolute;
  }

  /** True if `child` is `root` itself or a descendant of `root`. */
  private isInside(root: string, child: string): boolean {
    if (child === root) return true;
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return child.startsWith(withSep);
  }
}


// ------------------------------------------------------------------
// Standalone helpers (for callers that don't hold a PathGuard instance)
// ------------------------------------------------------------------

/** Convenience: resolve + guard in one call, for non-existing targets. */
export function guardPath(workingDir: string, inputPath: string): string {
  return new PathGuard(workingDir).resolveSafe(inputPath);
}

/** Convenience: resolve + guard, resolving symlinks on existing ancestors. */
export function guardPathReal(workingDir: string, inputPath: string): string {
  return new PathGuard(workingDir).resolveSafeReal(inputPath);
}