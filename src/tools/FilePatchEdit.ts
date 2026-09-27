/**
 * src/tools/FilePatchEdit.ts
 * --------------------------
 * Patch-based file editing. NEVER rewrites a whole file.
 *
 * Enforces:
 *   • Core Principle #2 — patch/diff edit only.
 *   • Core Principle #3 — reads the file fresh from disk before every edit.
 *   • Core Principle #4 — after write, verify; rollback if the file breaks.
 *
 * Matching rules:
 *   • oldStr must match EXACTLY once in the file (after normalization).
 *   • 0 matches   → error "oldStr not found; file may have changed, re-read".
 *   • >1 matches  → error "oldStr is ambiguous; add more context".
 *   • oldStr === newStr → no-op error.
 *
 * Normalization:
 *   • BOM is detected and preserved.
 *   • CRLF is detected; matching is done on LF-normalized text; the file is
 *     written back in its original line-ending style.
 *
 * Safety:
 *   • PathGuard blocks anything outside cwd.
 *   • Atomic write (temp file + rename) — a crash never leaves a half-written file.
 *   • Balanced-delimiter syntax check after write; failure → rollback.
 *
 * No caching. No side effects beyond the single file.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { PathGuard, PathGuardError } from "../policy/PathGuard";
import { readFile, type FileReadResult } from "./FileRead";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface FilePatchEditOptions {
  /** Working directory the tool is jailed to. */
  readonly cwd: string;
  /** Path relative to cwd, or absolute inside cwd. */
  readonly filePath: string;
  /** Exact substring to find. Must match exactly once. */
  readonly oldStr: string;
  /** Replacement text. */
  readonly newStr: string;
  /** If true, replace every occurrence (still requires ≥1 match). */
  readonly replaceAll?: boolean;
  /** If true, do everything except writing. Returns the preview. */
  readonly dryRun?: boolean;
  /**
   * Optional: expected mtime from a prior read. If provided and it differs,
   * the edit aborts before touching the file (Core Principle #3 helper).
   */
  readonly expectMtimeIso?: string;
}

export interface FilePatchEditResult {
  readonly relPath: string;
  readonly absPath: string;
  readonly matches: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly totalLinesBefore: number;
  readonly totalLinesAfter: number;
  readonly mtimeBeforeIso: string;
  readonly mtimeAfterIso: string;
  /** True if dryRun — nothing was written. */
  readonly dryRun: boolean;
  /** Unified-ish snippet around the change (for the activity stream). */
  readonly preview: string;
}


export class FilePatchEditError extends Error {
  public readonly code:
    | "not_found"
    | "not_a_file"
    | "blocked"
    | "old_not_found"
    | "ambiguous"
    | "noop"
    | "stale_mtime"
    | "syntax_break"
    | "io_error";
  public readonly relPath: string;
  constructor(code: FilePatchEditError["code"], relPath: string, message: string) {
    super(message);
    this.name = "FilePatchEditError";
    this.code = code;
    this.relPath = relPath;
  }
}


// ------------------------------------------------------------------
// Line-ending / BOM handling
// ------------------------------------------------------------------

interface TextShape {
  readonly hasBom: boolean;
  readonly usesCrlf: boolean;
  /** LF-normalized text, BOM stripped. */
  readonly normalized: string;
}

function detectShape(raw: string): TextShape {
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const noBom = hasBom ? raw.slice(1) : raw;
  // Count line endings.
  const crlf = (noBom.match(/\r\n/g) ?? []).length;
  const lfOnly = (noBom.match(/(^|[^\r])\n/g) ?? []).length;
  const usesCrlf = crlf > 0 && crlf >= lfOnly;
  const normalized = usesCrlf ? noBom.replace(/\r\n/g, "\n") : noBom;
  return { hasBom, usesCrlf, normalized };
}

function restoreShape(normalizedText: string, shape: TextShape): string {
  let out = normalizedText;
  if (shape.usesCrlf) out = out.replace(/\n/g, "\r\n");
  if (shape.hasBom) out = "\ufeff" + out;
  return out;
}


// ------------------------------------------------------------------
// Balanced-delimiter syntax check (heuristic, fast)
// ------------------------------------------------------------------
// Skips strings (' " `), line comments (// #), and block comments (/* */).
// Returns null if balanced, or an English reason if broken.
// NOT a real parser — just a cheap tripwire against obviously broken writes.
// ------------------------------------------------------------------

function checkBalanced(text: string): string | null {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Line comment
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // Hash comment (only at line start-ish — be conservative: treat as comment
    // only when preceded by start or whitespace)
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // Block comment
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // Strings
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // Opening
    if (c === "(" || c === "[" || c === "{") {
      stack.push(c);
      i++;
      continue;
    }
    // Closing
    if (c === ")" || c === "]" || c === "}") {
      const want = pairs[c];
      const got = stack.pop();
      if (got !== want) {
        return `unbalanced "${c}" near offset ${i}`;
      }
      i++;
      continue;
    }
    i++;
  }

  if (stack.length > 0) {
    return `unclosed "${stack[stack.length - 1]}"`;
  }
  return null;
}


// ------------------------------------------------------------------
// Preview builder
// ------------------------------------------------------------------

function buildPreview(
  beforeText: string,
  oldStr: string,
  newStr: string
): string {
  const idx = beforeText.indexOf(oldStr);
  if (idx === -1) return "";
  const around = 200;
  const head = beforeText.slice(Math.max(0, idx - around), idx);
  const tail = beforeText.slice(idx + oldStr.length, idx + oldStr.length + around);
  const headLines = head.split("\n").slice(-3).join("\n");
  const tailLines = tail.split("\n").slice(0, 3).join("\n");
  const oldLines = oldStr.split("\n").map((l) => "- " + l).join("\n");
  const newLines = newStr.split("\n").map((l) => "+ " + l).join("\n");
  return `${headLines}\n${oldLines}\n${newLines}\n${tailLines}`.trim();
}


// ------------------------------------------------------------------
// Atomic write
// ------------------------------------------------------------------

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
 * Apply a patch to a file. Fresh read → match → write → verify → rollback.
 * Throws FilePatchEditError on any problem; nothing is left half-written.
 */
export async function patchFile(
  opts: FilePatchEditOptions
): Promise<FilePatchEditResult> {
  if (opts.oldStr === opts.newStr) {
    throw new FilePatchEditError(
      "noop",
      opts.filePath,
      "oldStr and newStr are identical — nothing to change"
    );
  }
  if (opts.oldStr.length === 0) {
    throw new FilePatchEditError(
      "noop",
      opts.filePath,
      "oldStr is empty — full-file rewrite is not allowed"
    );
  }

  const guard = new PathGuard(opts.cwd);

  let absPath: string;
  try {
    absPath = guard.resolveSafeReal(opts.filePath);
  } catch (err) {
    if (err instanceof PathGuardError) {
      throw new FilePatchEditError("blocked", opts.filePath, err.message);
    }
    throw err;
  }
  const relPath = path.relative(guard.workingDir, absPath) || path.basename(absPath);

  // 1. Fresh read.
  let fresh: FileReadResult;
  try {
    fresh = await readFile({
      cwd: opts.cwd,
      filePath: opts.filePath,
      maxBytes: 5 * 1024 * 1024, // allow larger files for editing than for context
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    if (code === "blocked") throw new FilePatchEditError("blocked", relPath, msg);
    if (code === "not_found") throw new FilePatchEditError("not_found", relPath, msg);
    if (code === "not_a_file") throw new FilePatchEditError("not_a_file", relPath, msg);
    throw new FilePatchEditError("io_error", relPath, msg);
  }

  // 2. Optional mtime guard (caller-provided expected value).
  if (opts.expectMtimeIso && opts.expectMtimeIso !== fresh.mtimeIso) {
    throw new FilePatchEditError(
      "stale_mtime",
      relPath,
      `file changed on disk since last read (was ${opts.expectMtimeIso}, now ${fresh.mtimeIso}) — re-read before editing`
    );
  }

  // 3. Reconstruct raw text (with BOM/CRLF) from the FileReadResult.
  //    FileRead already stripped BOM + normalized? No — FileRead returns raw
  //    content lines joined by \n, so we re-read the file here to get the
  //    exact raw bytes, preserving shape faithfully.
  let rawText: string;
  try {
    const buf = await fs.readFile(absPath);
    rawText = buf.toString("utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FilePatchEditError("io_error", relPath, `read failed: ${msg}`);
  }

  const shape = detectShape(rawText);
  const target = shape.normalized;

  // Normalize oldStr/newStr the same way (so callers can write LF-friendly patches).
  const oldNorm = opts.oldStr.replace(/\r\n/g, "\n");
  const newNorm = opts.newStr.replace(/\r\n/g, "\n");

  // 4. Count matches.
  const matches = countOccurrences(target, oldNorm);
  if (matches === 0) {
    throw new FilePatchEditError(
      "old_not_found",
      relPath,
      "oldStr not found — file may have changed; re-read it and try again"
    );
  }
  if (matches > 1 && !opts.replaceAll) {
    throw new FilePatchEditError(
      "ambiguous",
      relPath,
      `oldStr matches ${matches} times — add more surrounding context to make it unique`
    );
  }

  // 5. Build new text (LF-normalized).
  const nextNorm = opts.replaceAll
    ? target.split(oldNorm).join(newNorm)
    : target.replace(oldNorm, newNorm);

  // 6. Syntax check on the LF-normalized text (cheap, honest tripwire).
  const ext = path.extname(absPath).toLowerCase();
  const isCode =
    ext === ".ts" || ext === ".tsx" ||
    ext === ".js" || ext === ".jsx" ||
    ext === ".mjs" || ext === ".cjs" ||
    ext === ".json";
  if (isCode) {
    const problem = checkBalanced(nextNorm);
    if (problem) {
      throw new FilePatchEditError(
        "syntax_break",
        relPath,
        `patch would break syntax (${problem}) — edit refused, file untouched`
      );
    }
  }

  // 7. Preview snippet (for the activity stream / dry run).
  const preview = buildPreview(target, oldNorm, newNorm);

  const bytesBefore = Buffer.byteLength(rawText, "utf8");
  const nextRaw = restoreShape(nextNorm, shape);
  const bytesAfter = Buffer.byteLength(nextRaw, "utf8");
  const totalLinesBefore = target.split("\n").length;
  const totalLinesAfter = nextNorm.split("\n").length;

  // Dry run — nothing written.
  if (opts.dryRun) {
    return {
      relPath,
      absPath,
      matches,
      bytesBefore,
      bytesAfter,
      totalLinesBefore,
      totalLinesAfter,
      mtimeBeforeIso: fresh.mtimeIso,
      mtimeAfterIso: fresh.mtimeIso,
      dryRun: true,
      preview,
    };
  }

  // 8. Atomic write.
  try {
    await atomicWrite(absPath, nextRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FilePatchEditError("io_error", relPath, `write failed: ${msg}`);
  }

  // 9. Verify: re-read and confirm the change landed, and syntax still fine.
  let afterStat: import("fs").Stats;
  let afterRaw: string;
  try {
    afterStat = await fs.stat(absPath);
    afterRaw = (await fs.readFile(absPath)).toString("utf8");
  } catch (err) {
    // Very unusual — attempt rollback to the original bytes.
    await tryRollback(absPath, rawText);
    const msg = err instanceof Error ? err.message : String(err);
    throw new FilePatchEditError("io_error", relPath, `verify failed: ${msg}`);
  }

  if (afterRaw !== nextRaw) {
    await tryRollback(absPath, rawText);
    throw new FilePatchEditError(
      "io_error",
      relPath,
      "post-write verification failed — rolled back"
    );
  }

  if (isCode) {
    const afterShape = detectShape(afterRaw);
    const problem = checkBalanced(afterShape.normalized);
    if (problem) {
      await tryRollback(absPath, rawText);
      throw new FilePatchEditError(
        "syntax_break",
        relPath,
        `file broke after write (${problem}) — rolled back`
      );
    }
  }

  return {
    relPath,
    absPath,
    matches,
    bytesBefore,
    bytesAfter,
    totalLinesBefore,
    totalLinesAfter,
    mtimeBeforeIso: fresh.mtimeIso,
    mtimeAfterIso: new Date(afterStat.mtimeMs).toISOString(),
    dryRun: false,
    preview,
  };
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

async function tryRollback(absPath: string, originalRaw: string): Promise<void> {
  try {
    await atomicWrite(absPath, originalRaw);
  } catch {
    /* best-effort — if rollback itself fails, the caller sees the original error */
  }
}