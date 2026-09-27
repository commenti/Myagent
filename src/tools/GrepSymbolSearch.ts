/**
 * src/tools/GrepSymbolSearch.ts
 * -----------------------------
 * Search for text or regex patterns across files inside the working directory.
 *
 * Used by:
 *   - context/RepoMap       - locating symbol definitions.
 *   - orchestrator/Planner  - finding call sites.
 *
 * Rules:
 *   - PathGuard-bound: never searches outside cwd.
 *   - Skips node_modules, .git, dist, build, .agent-runtime, binaries.
 *   - Case-sensitive by default; opt-in case-insensitive via flag.
 *   - Hard caps on results and per-file bytes to keep it safe.
 *
 * No caching. No writes.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";

import { PathGuard, PathGuardError } from "../policy/PathGuard";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_PER_FILE = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

const SKIP_DIRS: ReadonlySet<string> = new Set<string>([
  "node_modules", ".git", "dist", "build", "coverage",
  ".agent-runtime", ".next", ".cache", ".turbo",
  ".idea", ".vscode", "__pycache__", "venv", ".venv",
]);

const SKIP_EXTS: ReadonlySet<string> = new Set<string>([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svgz",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".ogg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".lock", ".map",
]);


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface GrepOptions {
  readonly cwd: string;
  readonly pattern: string;
  readonly regex?: boolean;
  readonly ignoreCase?: boolean;
  readonly extensions?: readonly string[];
  readonly subPath?: string;
  readonly maxResults?: number;
  readonly maxPerFile?: number;
  readonly maxLineLength?: number;
}

export interface GrepMatch {
  readonly relPath: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface GrepResult {
  readonly matches: readonly GrepMatch[];
  readonly filesScanned: number;
  readonly filesWithMatches: number;
  readonly truncated: boolean;
}

export type GrepErrorCode = "blocked" | "bad_pattern" | "io_error";

export class GrepError extends Error {
  public readonly code: GrepErrorCode;
  constructor(code: GrepErrorCode, message: string) {
    super(message);
    this.name = "GrepError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Pattern builder
// ------------------------------------------------------------------

function buildRegex(opts: GrepOptions): RegExp {
  const flags = opts.ignoreCase ? "gi" : "g";
  try {
    if (opts.regex) return new RegExp(opts.pattern, flags);
    return new RegExp(escapeRegExp(opts.pattern), flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GrepError("bad_pattern", "invalid pattern: " + msg);
  }
}

function escapeRegExp(s: string): string {
  const specials = ".*+?^${}()|[]\\";
  let out = "";
  for (const ch of s) {
    out += specials.indexOf(ch) >= 0 ? "\\" + ch : ch;
  }
  return out;
}


// ------------------------------------------------------------------
// File walking
// ------------------------------------------------------------------

interface WalkedFile {
  readonly absPath: string;
  readonly relPath: string;
}

async function collectFiles(
  rootDir: string,
  startDir: string,
  extensions: ReadonlySet<string> | null
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      if (extensions !== null && !extensions.has(ext)) continue;

      out.push({
        absPath: abs,
        relPath: path.relative(rootDir, abs) || entry.name,
      });
    }
  }

  await walk(startDir);
  return out;
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Search across files inside cwd. Throws GrepError on blocked path or bad regex.
 */
export async function grep(opts: GrepOptions): Promise<GrepResult> {
  const guard = new PathGuard(opts.cwd);
  const rootDir = guard.workingDir;

  // 1. Resolve the starting directory (default = cwd root).
  let startDir: string;
  try {
    startDir = opts.subPath
      ? guard.resolveSafeReal(opts.subPath)
      : rootDir;
  } catch (err) {
    if (err instanceof PathGuardError) {
      throw new GrepError("blocked", err.message);
    }
    throw err;
  }

  // 2. Make sure the start path is a directory.
  try {
    const st = await fs.stat(startDir);
    if (!st.isDirectory()) {
      throw new GrepError("io_error", "subPath is not a directory: " + String(opts.subPath));
    }
  } catch (err) {
    if (err instanceof GrepError) throw err;
    throw new GrepError("io_error", "cannot read subPath: " + String(opts.subPath));
  }

  const regex = buildRegex(opts);

  // 3. Normalize extensions set (or null = no filter).
  let extensions: ReadonlySet<string> | null = null;
  if (opts.extensions && opts.extensions.length > 0) {
    const normalized: string[] = [];
    for (const e of opts.extensions) {
      normalized.push(e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase());
    }
    extensions = new Set<string>(normalized);
  }

  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxPerFile = opts.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const maxLineLength = opts.maxLineLength ?? 2000;

  const files = await collectFiles(rootDir, startDir, extensions);

  const matches: GrepMatch[] = [];
  let filesWithMatches = 0;
  let truncated = false;

  for (const file of files) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }

    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(file.absPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    // 4. Read file, refuse binaries.
    let text = "";
    try {
      const buf = await fs.readFile(file.absPath);
      const head = buf.subarray(0, Math.min(2048, buf.length));
      let binary = false;
      for (let i = 0; i < head.length; i++) {
        if (head[i] === 0) {
          binary = true;
          break;
        }
      }
      if (binary) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    let perFile = 0;
    let fileHit = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > maxLineLength) continue;

      regex.lastIndex = 0;
      let m: RegExpExecArray | null = regex.exec(line);
      while (m !== null) {
        fileHit = true;
        const shown = line.length > 400 ? line.slice(0, 400) + "..." : line;
        matches.push({
          relPath: file.relPath,
          line: i + 1,
          column: m.index + 1,
          text: shown,
        });
        perFile++;
        if (perFile >= maxPerFile) break;
        if (matches.length >= maxResults) break;

        // Guard against zero-width matches.
        if (m.index === regex.lastIndex) regex.lastIndex++;
        m = regex.exec(line);
      }

      if (perFile >= maxPerFile) break;
      if (matches.length >= maxResults) break;
    }

    if (fileHit) filesWithMatches++;
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
  }

  return {
    matches,
    filesScanned: files.length,
    filesWithMatches,
    truncated,
  };
}

/** Convenience: find likely definition sites for a symbol name. */
export async function findSymbol(
  cwd: string,
  symbol: string,
  extensions?: readonly string[]
): Promise<GrepResult> {
  return grep({
    cwd,
    pattern: "\\b" + escapeRegExp(symbol) + "\\b",
    regex: true,
    ...(extensions ? { extensions } : {}),
  });
}