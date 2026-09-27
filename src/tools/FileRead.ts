/**
 * src/tools/FileRead.ts
 * ---------------------
 * Reads file contents from disk — always fresh, never cached. This enforces
 * Core Principle #3: every file-write reads the file fresh first.
 *
 * Safety:
 *   • Every path goes through PathGuard — nothing outside cwd is readable.
 *   • Symlinks are resolved; escapes are blocked.
 *   • Binary files are detected and refused (caller gets a clear error).
 *   • Size is capped to avoid accidental multi-MB reads into context.
 *
 * Range semantics:
 *   • read({ path })               → whole file (if under cap)
 *   • read({ path, startLine, endLine }) → that 1-based inclusive range
 *
 * No caching. No side effects. No writes.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { PathGuard, PathGuardError } from "../policy/PathGuard";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KB

export interface FileReadOptions {
  /** Working directory the tool is jailed to. */
  readonly cwd: string;
  /** Path relative to cwd, or absolute inside cwd. */
  readonly filePath: string;
  /** 1-based inclusive start line. Omit for beginning of file. */
  readonly startLine?: number;
  /** 1-based inclusive end line. Omit for end of file. */
  readonly endLine?: number;
  /** Hard cap on bytes read from disk. Default 512 KB. */
  readonly maxBytes?: number;
}

export interface FileReadResult {
  /** Path relative to cwd (for display). */
  readonly relPath: string;
  /** Absolute resolved path (safe — inside cwd). */
  readonly absPath: string;
  /** File contents (possibly sliced to a line range). */
  readonly content: string;
  /** Total lines in the file (not just the returned slice). */
  readonly totalLines: number;
  /** 1-based first line included in `content`, or 0 if content is empty. */
  readonly startLine: number;
  /** 1-based last line included in `content`, or 0 if content is empty. */
  readonly endLine: number;
  /** Whether the returned content is only part of the file. */
  readonly truncated: boolean;
  /** UTF-8 byte size of the whole file on disk. */
  readonly byteSize: number;
  /** File mtime as ISO string, for change detection by callers. */
  readonly mtimeIso: string;
}


export class FileReadError extends Error {
  public readonly code:
    | "not_found"
    | "not_a_file"
    | "too_large"
    | "binary"
    | "blocked"
    | "io_error";
  public readonly relPath: string;
  constructor(code: FileReadError["code"], relPath: string, message: string) {
    super(message);
    this.name = "FileReadError";
    this.code = code;
    this.relPath = relPath;
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Heuristic binary check on a small prefix buffer. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true; // NUL byte → binary
    // Allow common control chars: \t \n \r \f \b
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++;
  }
  // More than 30% unusual control bytes → treat as binary.
  return suspicious / n > 0.3;
}

function clampLine(n: number, total: number): number {
  if (n < 1) return 1;
  if (n > total) return total;
  return n;
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Read a file safely. Throws FileReadError on any problem.
 */
export async function readFile(opts: FileReadOptions): Promise<FileReadResult> {
  const guard = new PathGuard(opts.cwd);

  // 1. Guard + resolve (real, so symlinks are checked).
  let absPath: string;
  try {
    absPath = guard.resolveSafeReal(opts.filePath);
  } catch (err) {
    if (err instanceof PathGuardError) {
      throw new FileReadError("blocked", opts.filePath, err.message);
    }
    throw err;
  }

  const relPath = path.relative(guard.workingDir, absPath) || path.basename(absPath);

  // 2. Stat — must exist and be a regular file.
  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new FileReadError("not_found", relPath, `file not found: ${relPath}`);
  }
  if (!stat.isFile()) {
    throw new FileReadError("not_a_file", relPath, `not a regular file: ${relPath}`);
  }

  // 3. Size cap.
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (stat.size > maxBytes) {
    throw new FileReadError(
      "too_large",
      relPath,
      `file is ${stat.size} bytes, exceeds cap of ${maxBytes}`
    );
  }

  // 4. Read raw bytes.
  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FileReadError("io_error", relPath, `read failed: ${msg}`);
  }

  // 5. Binary check.
  if (looksBinary(buf)) {
    throw new FileReadError("binary", relPath, `binary file refused: ${relPath}`);
  }

  // 6. Decode UTF-8, strip BOM if present.
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // 7. Split into lines. Keep it simple: split on \n, strip trailing \r.
  const allLines = text.split("\n");
  // Preserve whether the file ended with a newline — last element becomes "".
  const totalLines = allLines.length;

  // 8. Slice to requested range (1-based inclusive).
  const wantStart = opts.startLine ?? 1;
  const wantEnd = opts.endLine ?? totalLines;

  const startLine = clampLine(wantStart, totalLines);
  const endLine = clampLine(wantEnd, totalLines);

  const truncated =
    startLine !== 1 || endLine !== totalLines || stat.size >= maxBytes;

  let content: string;
  if (totalLines === 0 || startLine > endLine) {
    content = "";
  } else {
    content = allLines
      .slice(startLine - 1, endLine)
      .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
      .join("\n");
  }

  return {
    relPath,
    absPath,
    content,
    totalLines,
    startLine: content.length === 0 ? 0 : startLine,
    endLine: content.length === 0 ? 0 : endLine,
    truncated,
    byteSize: stat.size,
    mtimeIso: new Date(stat.mtimeMs).toISOString(),
  };
}