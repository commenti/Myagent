/**
 * src/tools/GrepSymbolSearch.ts
 * -----------------------------
 * Search for text or regex patterns across files inside the working directory.
 *
 * Used by:
 *   • context/RepoMap   — locating symbol definitions.
 *   • orchestrator/Planner — finding call sites.
 *
 * Rules:
 *   • PathGuard-bound — never searches outside cwd.
 *   • Skips node_modules, .git, dist, build, .agent-runtime, binaries.
 *   • Case-sensitive by default; opt-in case-insensitive via flag.
 *   • Hard caps on results and per-file bytes to keep it safe.
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

const SKIP_DIRS = new Set<string>([
  "node_modules", ".git", "dist", "build", "coverage",
  ".agent-runtime", ".next", ".cache", ".turbo",
  ".idea", ".vscode", "__pycache__", "venv", ".venv",
]);

const SKIP_EXTS = new Set<string>([
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
  /** Pattern to search for. */
  readonly pattern: string;
  /** Treat pattern as a regex. Default: false (literal). */
  readonly regex?: boolean;
  /** Case-insensitive match. Default: false. */
  readonly ignoreCase?: boolean;
  /** Only search files with these extensions (e.g. [".ts", ".tsx"]). */
  readonly extensions?: readonly string[];
  /** Restrict search to this subpath (relative to cwd). Default: cwd root. */
  readonly subPath?: string;
  /** Hard cap on total results. Default 200. */
  readonly maxResults?: number;
  /** Hard cap on matches per file. Default 50. */
  readonly maxPerFile?: number;
  /** Skip lines longer than this when matching. Default 2000 chars. */
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
  /** True if the result was cut short by maxResults. */
  readonly truncated: boolean;
}

export class GrepError extends Error {
  public readonly code: "blocked" | "bad_pattern" | "io_error";
  constructor(code: GrepError["code"], message: string) {
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
    throw new GrepError("bad_pattern", `invalid pattern: ${msg}`);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      if (entry.isSymbolicLink()) continue; // do not follow symlinks in search
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      if (extensions && !extensions.has(ext)) continue;

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

  // Resolve the starting directory (default = cwd root).
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

  // Make sure the start path is a directory.
  try {
    const st = await fs.stat(startDir);
    if (!st.isDirectory()) {
      throw new GrepError("io_error", `subPath is not a directory: ${opts.subPath}`);
    }
  } catch (err) {
    if (err instanceof GrepError) throw err;
    throw new GrepError("io_error", `cannot read subPath: ${opts.subPath}`);
  }

  const regex = buildRegex(opts);
  const extensions = opts.extensions && opts.extensions.length > 0
    ? new Set(opts.extensions.map((e) => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase()))
    : null;

  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxPerFile = opts.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const maxLineLength = opts.maxLineLength ?? 2000;

  const files = await collectFiles(rootDir, startDir, extensions);

  const matches: GrepMatch[] = [];
  let filesWith