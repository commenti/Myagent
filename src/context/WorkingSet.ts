/**
 * src/context/WorkingSet.ts
 * -------------------------
 * The L2 layer of context (ARCHITECTURE.md §8): the small set of files
 * (typically 3–8) relevant to the CURRENT task.
 *
 * Responsibilities:
 *   • Hold a bounded list of file paths (the working set).
 *   • Read each file FRESH from disk when it is added or when its cached
 *     copy is stale (mtime changed since last read).
 *   • Drop files that are no longer needed, or when the cap is exceeded
 *     (least-recently-used goes first).
 *   • Produce a compact context block for the model.
 *
 * What it is NOT:
 *   • Not a repo map (that is RepoMap).
 *   • Not full-file content (that is FileRead, used directly on the file
 *     being edited).
 *
 * No AI calls. In-memory only.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { readFile, type FileReadResult } from "../tools/FileRead";
import { PathGuard, PathGuardError } from "../policy/PathGuard";
import type { RepoMap } from "./RepoMap";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_MAX_FILES = 8;
const MIN_FILES = 1;
const MAX_FILES_HARD = 16;
const DEFAULT_MAX_BYTES_PER_FILE = 128 * 1024; // 128 KB in context


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface WorkingSetEntry {
  readonly relPath: string;
  readonly absPath: string;
  /** Verbatim content at the time of last read. */
  readonly content: string;
  readonly byteSize: number;
  readonly totalLines: number;
  /** mtime of the copy we hold — used to detect staleness. */
  readonly mtimeIso: string;
  /** ISO time when the file was added to the set. */
  readonly addedAt: string;
  /** ISO time of last access (for LRU). */
  readonly lastUsedAt: string;
  /** English reason this file is in the set (for the activity stream). */
  readonly reason: string;
  /** True if the content was cut to fit the per-file byte cap. */
  readonly truncated: boolean;
}

export interface WorkingSetOptions {
  readonly cwd: string;
  /** Cap on files in the set. Clamped to [1, 16]. Default 8. */
  readonly maxFiles?: number;
  /** Cap on bytes kept per file. Default 128 KB. */
  readonly maxBytesPerFile?: number;
}

export interface AddResult {
  readonly entry: WorkingSetEntry;
  /** True if the file was newly added (false = refreshed). */
  readonly added: boolean;
}

export interface WorkingSetSnapshot {
  readonly entries: readonly WorkingSetEntry[];
  readonly totalBytes: number;
  readonly totalLines: number;
}


export class WorkingSetError extends Error {
  public readonly code: "blocked" | "not_found" | "io_error";
  constructor(code: WorkingSetError["code"], message: string) {
    super(message);
    this.name = "WorkingSetError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// WorkingSet
// ------------------------------------------------------------------

export class WorkingSet {
  private readonly guard: PathGuard;
  private readonly maxFiles: number;
  private readonly maxBytesPerFile: number;
  /** Map preserves insertion order; we re-insert on touch for LRU. */
  private readonly entries = new Map<string, WorkingSetEntry>();

  constructor(opts: WorkingSetOptions) {
    this.guard = new PathGuard(opts.cwd);
    const cap = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxFiles = Math.max(MIN_FILES, Math.min(MAX_FILES_HARD, cap));
    this.maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  }


  // ----------------------------------------------------------------
  // Reads
  // ----------------------------------------------------------------

  /**
   * Add (or refresh) a file. Reads it fresh from disk.
   * If already present, updates content + mtime and bumps LRU.
   */
  public async add(filePath: string, reason = "added"): Promise<AddResult> {
    const absPath = this.resolve(filePath);
    const relPath = this.rel(absPath);

    const fresh = await this.readFresh(relPath, absPath);

    const existing = this.entries.get(absPath);
    const added = existing === undefined;

    const now = new Date().toISOString();
    const entry: WorkingSetEntry = {
      relPath,
      absPath,
      content: fresh.content,
      byteSize: fresh.byteSize,
      totalLines: fresh.totalLines,
      mtimeIso: fresh.mtimeIso,
      addedAt: existing?.addedAt ?? now,
      lastUsedAt: now,
      reason: existing && existing.reason.length > 0 ? existing.reason : reason,
      truncated: fresh.truncated,
    };

    // Re-insert to move to the tail (LRU most-recent).
    if (existing) this.entries.delete(absPath);
    this.entries.set(absPath, entry);

    this.enforceCap();
    return { entry, added };
  }

  /** Add multiple files at once. Ignores individual failures with a note. */
  public async addMany(
    filePaths: readonly string[],
    reason = "added"
  ): Promise<{ added: WorkingSetEntry[]; failed: { path: string; message: string }[] }> {
    const added: WorkingSetEntry[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const p of filePaths) {
      try {
        const { entry } = await this.add(p, reason);
        added.push(entry);
      } catch (err) {
        failed.push({ path: p, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { added, failed };
  }

  /** Remove a file from the set. Returns true if it was present. */
  public remove(filePath: string): boolean {
    const absPath = this.resolve(filePath);
    return this.entries.delete(absPath);
  }

  /** Remove everything. */
  public clear(): void {
    this.entries.clear();
  }


  // ----------------------------------------------------------------
  // Staleness
  // ----------------------------------------------------------------

  /**
   * Refresh any entry whose on-disk mtime has changed. Returns the names
   * of the entries that were refreshed. Call this before building a context
   * block so the model never sees stale content (Core Principle #3).
   */
  public async refreshStale(): Promise<readonly string[]> {
    const refreshed: string[] = [];
    for (const [absPath, entry] of [...this.entries]) {
      let onDiskMtime: string;
      try {
        const st = await fs.stat(absPath);
        onDiskMtime = new Date(st.mtimeMs).toISOString();
      } catch {
        // File vanished — drop it.
        this.entries.delete(absPath);
        continue;
      }
      if (onDiskMtime !== entry.mtimeIso) {
        try {
          const fresh = await this.readFresh(entry.relPath, absPath);
          const now = new Date().toISOString();
          const updated: WorkingSetEntry = {
            ...entry,
            content: fresh.content,
            byteSize: fresh.byteSize,
            totalLines: fresh.totalLines,
            mtimeIso: fresh.mtimeIso,
            lastUsedAt: now,
            truncated: fresh.truncated,
          };
          this.entries.delete(absPath);
          this.entries.set(absPath, updated);
          refreshed.push(entry.relPath);
        } catch {
          // If refresh fails (binary, too large), drop it.
          this.entries.delete(absPath);
        }
      }
    }
    return refreshed;
  }


  // ----------------------------------------------------------------
  // Selection from RepoMap
  // ----------------------------------------------------------------

  /**
   * Seed the set from a repo map by matching symbol names.
   * Picks the top `limit` files that declare any of the given symbols.
   */
  public async seedFromRepoMap(
    repoMap: RepoMap,
    symbolNames: readonly string[],
    reason = "task symbols"
  ): Promise<readonly WorkingSetEntry[]> {
    const wanted = new Set(symbolNames);
    const scored: { relPath: string; score: number }[] = [];

    for (const f of repoMap.files) {
      let score = 0;
      for (const s of f.symbols) {
        if (wanted.has(s.name)) score += s.exported ? 2 : 1;
      }
      if (score > 0) scored.push({ relPath: f.relPath, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, this.maxFiles).map((s) => s.relPath);

    const result: WorkingSetEntry[] = [];
    for (const p of picks) {
      try {
        const { entry } = await this.add(p, reason);
        result.push(entry);
      } catch {
        /* skip files that fail to read */
      }
    }
    return result;
  }


  // ----------------------------------------------------------------
  // Snapshot / format
  // ----------------------------------------------------------------

  /** Current contents as a plain snapshot. */
  public snapshot(): WorkingSetSnapshot {
    const entries = [...this.entries.values()];
    let totalBytes = 0;
    let totalLines = 0;
    for (const e of entries) {
      totalBytes += e.byteSize;
      totalLines += e.totalLines;
    }
    return { entries, totalBytes, totalLines };
  }

  /** Number of files currently in the set. */
  public size(): number {
    return this.entries.size;
  }

  /** True if the set contains the given path. */
  public has(filePath: string): boolean {
    try {
      return this.entries.has(this.resolve(filePath));
    } catch {
      return false;
    }
  }

  /** Get one entry, or null. */
  public get(filePath: string): WorkingSetEntry | null {
    try {
      return this.entries.get(this.resolve(filePath)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Render a compact context block for the model.
   *
   * Format:
   *   == WORKING SET (3 files) ==
   *   --- src/foo.ts (42 lines) ---
   *   <content>
   *   --- src/bar.ts (17 lines) ---
   *   <content>
   */
  public format(maxBytesTotal = 256 * 1024): string {
    const entries = [...this.entries.values()];
    if (entries.length === 0) return "== WORKING SET (empty) ==";

    const parts: string[] = [`== WORKING SET (${entries.length} files) ==`];
    let budget = maxBytesTotal;

    for (const e of entries) {
      if (budget <= 0) {
        parts.push(`--- ${e.relPath} (skipped, context budget full) ---`);
        continue;
      }
      const header = `--- ${e.relPath} (${e.totalLines} lines) ---`;
      const body = e.content;
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (bodyBytes <= budget) {
        parts.push(header, body);
        budget -= bodyBytes;
      } else {
        const slice = Buffer.from(body, "utf8").subarray(0, budget).toString("utf8");
        parts.push(header, slice, "… (truncated to fit context budget)");
        budget = 0;
      }
    }
    return parts.join("\n");
  }


  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private resolve(filePath: string): string {
    try {
      return this.guard.resolveSafeReal(filePath);
    } catch (err) {
      if (err instanceof PathGuardError) {
        throw new WorkingSetError("blocked", err.message);
      }
      throw err;
    }
  }

  private rel(absPath: string): string {
    return path.relative(this.guard.workingDir, absPath) || path.basename(absPath);
  }

  private async readFresh(
    relPath: string,
    absPath: string
  ): Promise<FileReadResult> {
    try {
      return await readFile({
        cwd: this.guard.workingDir,
        filePath: relPath,
        maxBytes: this.maxBytesPerFile,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "blocked") throw new WorkingSetError("blocked", msg);
      if (code === "not_found") throw new WorkingSetError("not_found", msg);
      throw new WorkingSetError("io_error", msg);
    }
  }

  private enforceCap(): void {
    while (this.entries.size > this.maxFiles) {
      // Map iteration order = insertion order; the first key is the oldest.
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}