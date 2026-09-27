/**
 * src/session/SessionLog.ts
 * -------------------------
 * Append-only session log. Owns all three session files:
 *   • sessions/current.jsonl         — the live conversation
 *   • sessions/archive/*.jsonl       — old slices moved out by compaction
 *   • sessions/archive_index.json    — searchable index of archives
 *
 * Design:
 *   • current.jsonl is append-only. Entries are never edited in place.
 *   • Compaction calls archiveEntries(n) which moves the OLDEST n entries
 *     into a new archive file and appends a record to the index.
 *   • HistoryRetriever calls searchArchives(query) to find raw slices.
 *
 * No AI calls here. No summarization. Pure file I/O.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { ProjectPaths } from "../config/ProjectConfig";


// ------------------------------------------------------------------
// Entry types (what can live in the log)
// ------------------------------------------------------------------

export type SessionEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | ToolResultEntry
  | SystemNoteEntry
  | CompactionMarkerEntry;

export interface BaseEntry {
  /** ISO timestamp the entry was written. */
  readonly ts: string;
  /** Monotonic id inside the session (1-based). */
  readonly seq: number;
}

export interface UserMessageEntry extends BaseEntry {
  readonly kind: "user";
  readonly text: string;
}

export interface AssistantMessageEntry extends BaseEntry {
  readonly kind: "assistant";
  readonly text: string;
  /** Tool calls the model requested, if any. */
  readonly toolCallIds?: readonly string[];
}

export interface ToolCallEntry extends BaseEntry {
  readonly kind: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ToolResultEntry extends BaseEntry {
  readonly kind: "tool-result";
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  /** Short English summary (never the full payload — keep the log small). */
  readonly summary: string;
  /** Optional structured payload (kept small). */
  readonly data?: unknown;
}

export interface SystemNoteEntry extends BaseEntry {
  readonly kind: "system-note";
  readonly text: string;
}

export interface CompactionMarkerEntry extends BaseEntry {
  readonly kind: "compaction-marker";
  /** Archive id this compaction produced. */
  readonly archiveId: string;
  /** How many entries were moved out. */
  readonly movedCount: number;
  /** English one-liner shown to the user. */
  readonly note: string;
}


// ------------------------------------------------------------------
// Archive index
// ------------------------------------------------------------------

export interface ArchiveIndexEntry {
  readonly id: string;
  readonly file: string;
  readonly createdAt: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly entryCount: number;
  /** Short English topic hint, derived from content. */
  readonly topic: string;
  /** Lowercased keywords for search. */
  readonly keywords: readonly string[];
}

export interface ArchiveSearchHit {
  readonly id: string;
  readonly file: string;
  readonly topic: string;
  readonly createdAt: string;
  readonly score: number;
  readonly entries: readonly SessionEntry[];
}


// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

export class SessionLogError extends Error {
  public readonly code: "io_error" | "bad_format" | "bad_archive_id";
  constructor(code: SessionLogError["code"], message: string) {
    super(message);
    this.name = "SessionLogError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// SessionLog
// ------------------------------------------------------------------

export class SessionLog {
  private readonly paths: ProjectPaths;
  private seqCounter = 0;

  constructor(paths: ProjectPaths) {
    this.paths = paths;
  }


  // ----------------------------------------------------------------
  // Bootstrap
  // ----------------------------------------------------------------

  /** Ensure the session files exist and initialize the seq counter. */
  public async init(): Promise<void> {
    await fs.mkdir(this.paths.sessionsDir, { recursive: true });
    await fs.mkdir(this.paths.archiveDir, { recursive: true });

    if (!(await fileExists(this.paths.currentSessionFile))) {
      await fs.writeFile(this.paths.currentSessionFile, "", "utf8");
    }
    if (!(await fileExists(this.paths.archiveIndexFile))) {
      await fs.writeFile(this.paths.archiveIndexFile, "[]\n", "utf8");
    }

    // Seed the seq counter from the tail of current.jsonl.
    const all = await this.readAll();
    this.seqCounter = all.length > 0 ? all[all.length - 1].seq : 0;
  }


  // ----------------------------------------------------------------
  // Append
  // ----------------------------------------------------------------

  /** Append an entry. Fills ts + seq automatically. Returns the written entry. */
  public async append(
    entry: DistributiveOmit<SessionEntry, "ts" | "seq">
  ): Promise<SessionEntry> {
    const full = {
      ...(entry as object),
      ts: new Date().toISOString(),
      seq: ++this.seqCounter,
    } as SessionEntry;

    const line = JSON.stringify(full) + "\n";
    try {
      await fs.appendFile(this.paths.currentSessionFile, line, "utf8");
    } catch (err) {
      this.seqCounter--; // roll back the counter on failure
      const msg = err instanceof Error ? err.message : String(err);
      throw new SessionLogError("io_error", `append failed: ${msg}`);
    }
    return full;
  }


  // ----------------------------------------------------------------
  // Read
  // ----------------------------------------------------------------

  /** Read every entry in current.jsonl. */
  public async readAll(): Promise<SessionEntry[]> {
    return this.readJsonlFile(this.paths.currentSessionFile);
  }

  /** Read the last n entries from current.jsonl. */
  public async readTail(n: number): Promise<SessionEntry[]> {
    const all = await this.readAll();
    if (n >= all.length) return all;
    return all.slice(all.length - n);
  }

  /** Current entry count and byte size. */
  public async stats(): Promise<{ entries: number; bytes: number }> {
    const all = await this.readAll();
    let bytes = 0;
    try {
      const st = await fs.stat(this.paths.currentSessionFile);
      bytes = st.size;
    } catch {
      bytes = 0;
    }
    return { entries: all.length, bytes };
  }


  // ----------------------------------------------------------------
  // Archive
  // ----------------------------------------------------------------

  /**
   * Move the OLDEST n entries from current.jsonl into a new archive file.
   * Returns the archive index entry that was written, or null if n <= 0
   * or the log is empty.
   */
  public async archiveEntries(n: number, topicHint?: string): Promise<ArchiveIndexEntry | null> {
    if (n <= 0) return null;
    const all = await this.readAll();
    if (all.length === 0) return null;

    const moveCount = Math.min(n, all.length);
    const moving = all.slice(0, moveCount);
    const remaining = all.slice(moveCount);

    const id = makeArchiveId();
    const file = `${id}.jsonl`;
    const absArchive = path.join(this.paths.archiveDir, file);

    // 1. Write the archive file.
    const body = moving.map((e) => JSON.stringify(e)).join("\n") + "\n";
    try {
      await fs.writeFile(absArchive, body, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SessionLogError("io_error", `archive write failed: ${msg}`);
    }

    // 2. Rewrite current.jsonl with the remainder (atomic-ish).
    const restBody = remaining.length > 0
      ? remaining.map((e) => JSON.stringify(e)).join("\n") + "\n"
      : "";
    try {
      const tmp = this.paths.currentSessionFile + ".tmp";
      await fs.writeFile(tmp, restBody, "utf8");
      await fs.rename(tmp, this.paths.currentSessionFile);
    } catch (err) {
      // Roll back the archive file we just wrote.
      try { await fs.unlink(absArchive); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      throw new SessionLogError("io_error", `current.jsonl rewrite failed: ${msg}`);
    }

    // 3. Append to the index.
    const first = moving[0];
    const last = moving[moving.length - 1];
    const entry: ArchiveIndexEntry = {
      id,
      file,
      createdAt: new Date().toISOString(),
      fromSeq: first.seq,
      toSeq: last.seq,
      entryCount: moving.length,
      topic: topicHint && topicHint.trim().length > 0
        ? topicHint.trim().slice(0, 120)
        : deriveTopic(moving),
      keywords: deriveKeywords(moving),
    };

    const index = await this.readIndex();
    index.push(entry);
    await this.writeIndex(index);

    return entry;
  }

  /** Read the archive index. */
  public async readIndex(): Promise<ArchiveIndexEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.archiveIndexFile, "utf8");
    } catch {
      return [];
    }
    if (raw.trim().length === 0) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isArchiveIndexEntry);
    } catch {
      return [];
    }
  }

  /** Read a specific archive by id. */
  public async readArchive(id: string): Promise<SessionEntry[]> {
    const index = await this.readIndex();
    const meta = index.find((e) => e.id === id);
    if (!meta) {
      throw new SessionLogError("bad_archive_id", `unknown archive id: ${id}`);
    }
    const abs = path.join(this.paths.archiveDir, meta.file);
    return this.readJsonlFile(abs);
  }

  /**
   * Search archives by keyword. Returns ranked hits (best first).
   * Matching is against the topic + keywords. Not full-text — that is the
   * caller's job once a candidate archive is chosen.
   */
  public async searchArchives(query: string, limit = 5): Promise<ArchiveSearchHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const index = await this.readIndex();
    const scored: { meta: ArchiveIndexEntry; score: number }[] = [];

    for (const meta of index) {
      const haystack = (meta.topic + " " + meta.keywords.join(" ")).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ meta, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(1, limit));

    const hits: ArchiveSearchHit[] = [];
    for (const { meta, score } of top) {
      const entries = await this.readArchive(meta.id);
      hits.push({
        id: meta.id,
        file: meta.file,
        topic: meta.topic,
        createdAt: meta.createdAt,
        score,
        entries,
      });
    }
    return hits;
  }


  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async readJsonlFile(absPath: string): Promise<SessionEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      const msg = err instanceof Error ? err.message : String(err);
      throw new SessionLogError("io_error", `read failed: ${msg}`);
    }
    if (raw.length === 0) return [];

    const out: SessionEntry[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip malformed lines rather than crash the whole session.
        continue;
      }
      if (isSessionEntry(parsed)) out.push(parsed);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  private async writeIndex(entries: readonly ArchiveIndexEntry[]): Promise<void> {
    const tmp = this.paths.archiveIndexFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.paths.archiveIndexFile);
  }
}


// ------------------------------------------------------------------
// Type guards
// ------------------------------------------------------------------

function isSessionEntry(v: unknown): v is SessionEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.ts !== "string") return false;
  if (typeof o.seq !== "number") return false;
  const kind = o.kind;
  return (
    kind === "user" ||
    kind === "assistant" ||
    kind === "tool-call" ||
    kind === "tool-result" ||
    kind === "system-note" ||
    kind === "compaction-marker"
  );
}

function isArchiveIndexEntry(v: unknown): v is ArchiveIndexEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.file === "string" &&
    typeof o.createdAt === "string" &&
    typeof o.fromSeq === "number" &&
    typeof o.toSeq === "number" &&
    typeof o.entryCount === "number" &&
    typeof o.topic === "string" &&
    Array.isArray(o.keywords) &&
    o.keywords.every((k) => typeof k === "string")
  );
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function makeArchiveId(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `ar-${y}${mo}${d}-${h}${mi}${s}-${rand}`;
}

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "so",
  "of", "to", "in", "on", "at", "for", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function deriveTopic(entries: readonly SessionEntry[]): string {
  // Prefer the first user message; else the first entry's kind.
  for (const e of entries) {
    if (e.kind === "user") return e.text.trim().slice(0, 120) || "(user message)";
  }
  return entries.length > 0 ? `(${entries[0].kind})` : "(empty)";
}

function deriveKeywords(entries: readonly SessionEntry[]): string[] {
  const bag = new Map<string, number>();
  for (const e of entries) {
    const text = entryToText(e);
    for (const tok of tokenize(text)) {
      bag.set(tok, (bag.get(tok) ?? 0) + 1);
    }
  }
  return [...bag.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

function entryToText(e: SessionEntry): string {
  switch (e.kind) {
    case "user":      return e.text;
    case "assistant": return e.text;
    case "system-note": return e.text;
    case "tool-call": return `${e.name} ${e.argumentsJson}`;
    case "tool-result": return `${e.name} ${e.summary}`;
    case "compaction-marker": return e.note;
  }
}


// ------------------------------------------------------------------
// Utility type: allow callers to omit ts/seq when appending
// ------------------------------------------------------------------

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;