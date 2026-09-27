/**
 * src/context/HistoryRetriever.ts
 * -------------------------------
 * The retrieve_history tool (ARCHITECTURE.md §13.3).
 *
 * Purpose:
 *   When the model needs to know exactly what was said/decided in an OLD
 *   conversation that was moved into the archive, it calls this tool with
 *   a keyword or question. We look up the archive index, pick the best
 *   matching archive(s), and return ONLY the matching slice — never the
 *   whole archive.
 *
 * Used by:
 *   • orchestrator — as a tool the model can call.
 *   • planCommand  — when the user asks about past decisions.
 *
 * No AI calls. Pure lookup + slice.
 */

import type { SessionLog, SessionEntry, ArchiveSearchHit } from "../session/SessionLog";
import { estimateTokens } from "./TokenBudget";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_MAX_HITS = 3;
const DEFAULT_MAX_SLICE_ENTRIES = 20;   // per hit
const DEFAULT_MAX_TOKENS = 2000;        // total across all hits
const CONTEXT_WINDOW = 2;               // entries before/after a match


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface RetrieveHistoryOptions {
  /** The search query (keywords, or a natural-language question). */
  readonly query: string;
  /** Max archives to consider. Default 3. */
  readonly maxHits?: number;
  /** Max entries returned per archive. Default 20. */
  readonly maxSliceEntries?: number;
  /** Max tokens in the returned block. Default 2000. */
  readonly maxTokens?: number;
  /** Restrict to one archive id (skip search). */
  readonly archiveId?: string;
}

export interface RetrievedSlice {
  readonly archiveId: string;
  readonly topic: string;
  readonly createdAt: string;
  /** The matching entries, in original order. */
  readonly entries: readonly SessionEntry[];
  /** Index of the first matching entry inside the archive (for reference). */
  readonly matchStartIndex: number;
}

export interface RetrieveHistoryResult {
  /** True if anything was found. */
  readonly found: boolean;
  readonly slices: readonly RetrievedSlice[];
  /** Rendered markdown block, ready to inject into the current turn. */
  readonly markdown: string;
  /** Rough token estimate of the markdown block. */
  readonly estimatedTokens: number;
  /** English one-line summary for the activity stream. */
  readonly summary: string;
}

export class HistoryRetrieverError extends Error {
  public readonly code: "empty_query" | "io_error";
  constructor(code: HistoryRetrieverError["code"], message: string) {
    super(message);
    this.name = "HistoryRetrieverError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// HistoryRetriever
// ------------------------------------------------------------------

export class HistoryRetriever {
  private readonly log: SessionLog;

  constructor(log: SessionLog) {
    this.log = log;
  }


  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Retrieve a matching slice of history. Never throws for "nothing found" —
   * returns found:false with an honest message.
   */
  public async retrieve(
    opts: RetrieveHistoryOptions
  ): Promise<RetrieveHistoryResult> {
    const query = opts.query?.trim() ?? "";
    if (query.length === 0) {
      throw new HistoryRetrieverError("empty_query", "retrieve_history called with an empty query");
    }

    const maxHits = Math.max(1, opts.maxHits ?? DEFAULT_MAX_HITS);
    const maxSliceEntries = Math.max(1, opts.maxSliceEntries ?? DEFAULT_MAX_SLICE_ENTRIES);
    const maxTokens = Math.max(200, opts.maxTokens ?? DEFAULT_MAX_TOKENS);

    // 1. Pick archive(s) to search.
    let hits: ArchiveSearchHit[];
    if (opts.archiveId) {
      try {
        const entries = await this.log.readArchive(opts.archiveId);
        const index = await this.log.readIndex();
        const meta = index.find((e) => e.id === opts.archiveId);
        hits = [{
          id: opts.archiveId,
          file: meta?.file ?? `${opts.archiveId}.jsonl`,
          topic: meta?.topic ?? "(unknown)",
          createdAt: meta?.createdAt ?? new Date().toISOString(),
          score: 1,
          entries,
        }];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HistoryRetrieverError("io_error", `cannot read archive: ${msg}`);
      }
    } else {
      try {
        hits = await this.log.searchArchives(query, maxHits);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HistoryRetrieverError("io_error", `archive search failed: ${msg}`);
      }
    }

    // 2. Nothing found.
    if (hits.length === 0) {
      return {
        found: false,
        slices: [],
        markdown: `== PAST HISTORY ==\nNo archive matched "${query}".`,
        estimatedTokens: 0,
        summary: `retrieve_history("${query}") → no match`,
      };
    }

    // 3. For each hit, slice out the matching region.
    const terms = tokenize(query);
    const slices: RetrievedSlice[] = [];

    for (const hit of hits) {
      const slice = this.sliceArchive(hit, terms, maxSliceEntries);
      if (slice) slices.push(slice);
    }

    if (slices.length === 0) {
      return {
        found: false,
        slices: [],
        markdown: `== PAST HISTORY ==\nArchive(s) matched "${query}" but no matching lines were found inside.`,
        estimatedTokens: 0,
        summary: `retrieve_history("${query}") → matched archives, no inner match`,
      };
    }

    // 4. Render markdown, respecting the token budget.
    const markdown = this.render(query, slices, maxTokens);
    const estimated = estimateTokens(markdown);

    return {
      found: true,
      slices,
      markdown,
      estimatedTokens: estimated,
      summary:
        `retrieve_history("${query}") → ${slices.length} slice(s), ` +
        `${slices.reduce((n, s) => n + s.entries.length, 0)} entries, ~${estimated} tokens`,
    };
  }


  // ----------------------------------------------------------------
  // Internals — slicing
  // ----------------------------------------------------------------

  private sliceArchive(
    hit: ArchiveSearchHit,
    terms: readonly string[],
    maxEntries: number
  ): RetrievedSlice | null {
    const entries = hit.entries;
    if (entries.length === 0) return null;

    // Find indexes whose text matches any term.
    const matchIdx: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entryMatches(entries[i], terms)) matchIdx.push(i);
    }

    if (matchIdx.length === 0) return null;

    // Build a window around matches, merging overlapping windows.
    const windows: { start: number; end: number }[] = [];
    for (const idx of matchIdx) {
      const start = Math.max(0, idx - CONTEXT_WINDOW);
      const end = Math.min(entries.length - 1, idx + CONTEXT_WINDOW);
      const last = windows[windows.length - 1];
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        windows.push({ start, end });
      }
    }

    // Flatten windows into the slice, respecting maxEntries.
    const picked: SessionEntry[] = [];
    for (const w of windows) {
      for (let i = w.start; i <= w.end; i++) {
        if (picked.length >= maxEntries) break;
        picked.push(entries[i]);
      }
      if (picked.length >= maxEntries) break;
    }

    return {
      archiveId: hit.id,
      topic: hit.topic,
      createdAt: hit.createdAt,
      entries: picked,
      matchStartIndex: matchIdx[0],
    };
  }


  // ----------------------------------------------------------------
  // Internals — rendering
  // ----------------------------------------------------------------

  private render(
    query: string,
    slices: readonly RetrievedSlice[],
    maxTokens: number
  ): string {
    const parts: string[] = [];
    parts.push("== PAST HISTORY ==");
    parts.push(`Query: ${query}`);
    parts.push("");

    let budget = maxTokens;

    for (const s of slices) {
      const header =
        `--- archive ${s.archiveId} (${s.topic}) — ${s.createdAt} ---`;
      parts.push(header);

      for (const e of s.entries) {
        const line = `[${e.seq}] ${renderEntry(e)}`;
        const cost = estimateTokens(line);
        if (cost > budget) {
          parts.push("… (remaining entries omitted to respect token budget)");
          budget = 0;
          break;
        }
        parts.push(line);
        budget -= cost;
      }
      parts.push("");
      if (budget <= 0) break;
    }

    parts.push(
      "Note: this is raw archived history, retrieved on demand. " +
        "It is NOT part of the permanent summary."
    );

    return parts.join("\n");
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "so",
  "of", "to", "in", "on", "at", "for", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its",
  "what", "when", "which", "who", "how", "why",
  "did", "do", "does", "we", "you", "i", "me", "my",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function entryMatches(e: SessionEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const text = entryToText(e).toLowerCase();
  for (const t of terms) {
    if (text.includes(t)) return true;
  }
  return false;
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

function renderEntry(e: SessionEntry): string {
  switch (e.kind) {
    case "user":      return `USER: ${clip(e.text)}`;
    case "assistant": return `ASSISTANT: ${clip(e.text)}`;
    case "system-note": return `NOTE: ${clip(e.text)}`;
    case "tool-call": return `TOOL CALL ${e.name}(${clip(e.argumentsJson, 200)})`;
    case "tool-result": return `TOOL RESULT ${e.name} [${e.ok ? "ok" : "fail"}]: ${clip(e.summary, 200)}`;
    case "compaction-marker": return `COMPACTION: ${clip(e.note)}`;
  }
}

function clip(s: string, max = 400): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}