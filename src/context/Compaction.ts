/**
 * src/context/Compaction.ts
 * -------------------------
 * Decides WHEN to compact (TokenBudget crosses the threshold), and orchestrates
 * the compaction itself:
 *
 *   1. Pick how many old entries to move out.
 *   2. Ask Summarizer for structured text (Decisions / Progress / Facts).
 *   3. Append results to MemoryStore (DECISIONS.md / PROGRESS.md).
 *   4. Move the raw entries into the archive via SessionLog.archiveEntries().
 *   5. Write a compaction-marker entry back into current.jsonl.
 *
 * HARD RULE (ARCHITECTURE.md §7 + §13.1):
 *   • User instructions (AGENTS.md, global/project custom instructions) are
 *     NEVER part of this path. They are never read here, never summarized,
 *     never moved to the archive. Compaction only touches conversation history.
 *
 * No AI call of its own — Summarizer does the model call.
 * No direct file I/O — SessionLog and MemoryStore do the writes.
 */

import type { SessionLog, SessionEntry } from "../session/SessionLog";
import type { MemoryStore } from "../memory/MemoryStore";
import type { TokenBudget } from "./TokenBudget";
import type { SummarizeFn, SummaryResult } from "./Summarizer";
import { summarize } from "./Summarizer";

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_KEEP_RECENT = 10;
const DEFAULT_MIN_TO_MOVE = 6;
const DEFAULT_MAX_TO_MOVE = 200;
const ENTRY_CHAR_BUDGET = 60_000;

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface CompactionOptions {
  readonly sessionLog: SessionLog;
  readonly memoryStore: MemoryStore;
  readonly tokenBudget: TokenBudget;
  /** The isolated model call used to write the summary. */
  readonly callModel: SummarizeFn;
  /** Model id passed to Summarizer. Usually the active profile's model. */
  readonly model: string;
  /** Optional cheaper model only for summarization. */
  readonly summaryModel?: string;
  /** How many newest entries to always keep. Default 10. */
  readonly keepRecent?: number;
  /** Min entries per pass. Default 6. */
  readonly minToMove?: number;
  /** Max entries per pass. Default 200. */
  readonly maxToMove?: number;
}

export interface CompactionResult {
  /** True if compaction actually ran. */
  readonly ran: boolean;
  /** English reason when ran === false. */
  readonly skipReason: string;
  readonly movedCount: number;
  readonly archiveId: string | null;
  readonly summary: SummaryResult | null;
  /** Token estimate of the summary markdown that was written. */
  readonly summaryTokens: number;
  readonly durationMs: number;
}

export class CompactionError extends Error {
  public readonly code: "io_error" | "summarizer_error";

  constructor(code: CompactionError["code"], message: string) {
    super(message);
    this.name = "CompactionError";
    this.code = code;
  }
}

// ------------------------------------------------------------------
// Compaction
// ------------------------------------------------------------------

export class Compaction {
  private readonly opts: Required<Omit<CompactionOptions, "summaryModel">> & {
    summaryModel?: string;
  };

  private running = false;

  constructor(opts: CompactionOptions) {
    this.opts = {
      ...opts,
      keepRecent: opts.keepRecent ?? DEFAULT_KEEP_RECENT,
      minToMove: opts.minToMove ?? DEFAULT_MIN_TO_MOVE,
      maxToMove: opts.maxToMove ?? DEFAULT_MAX_TO_MOVE,
      ...(opts.summaryModel ? { summaryModel: opts.summaryModel } : {}),
    };
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /** Quick check — should the caller run compact() right now? */
  public shouldCompact(): boolean {
    return this.opts.tokenBudget.shouldCompact();
  }

  /**
   * Run one compaction pass. Safe to call even when not needed — it will
   * return ran:false with a reason. Never runs two passes at once.
   */
  public async compact(): Promise<CompactionResult> {
    const started = Date.now();

    if (this.running) {
      return skip("compaction already in progress", started);
    }

    if (!this.opts.tokenBudget.shouldCompact()) {
      return skip("token budget below threshold", started);
    }

    this.running = true;

    try {
      return await this.doCompact(started);
    } finally {
      this.running = false;
    }
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async doCompact(started: number): Promise<CompactionResult> {
    const { sessionLog, model, summaryModel } = this.opts;

    // 1. Read the whole current log.
    let all: SessionEntry[];

    try {
      all = await sessionLog.readAll();
    } catch (err) {
      throw new CompactionError(
        "io_error",
        err instanceof Error ? err.message : String(err)
      );
    }

    // 2. Decide how many old entries to move.
    const keep = Math.min(
      this.opts.keepRecent,
      Math.max(0, all.length - 1)
    );

    let moveCount = all.length - keep;

    // Never move the most recent compaction marker itself.
    if (moveCount <= 0) {
      return skip("not enough entries to compact", started);
    }

    if (moveCount < this.opts.minToMove) {
      return skip(
        `only ${moveCount} entries to move (< min ${this.opts.minToMove})`,
        started
      );
    }

    if (moveCount > this.opts.maxToMove) {
      moveCount = this.opts.maxToMove;
    }

    const moving = all.slice(0, moveCount);
    const transcript = this.renderTranscript(moving);

    if (transcript.trim().length === 0) {
      return skip("nothing meaningful to summarize", started);
    }

    // 3. Ask Summarizer for the structured summary.
    let summary: SummaryResult;

    try {
      summary = await summarize(
        {
          transcript,
          topic: deriveTopic(moving),
          model: summaryModel ?? model,
        },
        this.opts.callModel
      );
    } catch (err) {
      throw new CompactionError(
        "summarizer_error",
        err instanceof Error ? err.message : String(err)
      );
    }

    // 4. Persist summary into memory files.
    try {
      await this.writeSummaryToMemory(summary);
    } catch (err) {
      throw new CompactionError(
        "io_error",
        err instanceof Error ? err.message : String(err)
      );
    }

    // 5. Archive the raw entries.
    let archiveId: string | null = null;

    try {
      const entry = await sessionLog.archiveEntries(
        moveCount,
        summary.sections.facts[0]
      );

      archiveId = entry?.id ?? null;
    } catch (err) {
      throw new CompactionError(
        "io_error",
        err instanceof Error ? err.message : String(err)
      );
    }

    // 6. Write a compaction marker into current.jsonl (now the tail).
    if (archiveId) {
      try {
        await sessionLog.append({
          kind: "compaction-marker",
          archiveId,
          movedCount: moveCount,
          note: `Compacted ${moveCount} entries into ${archiveId}`,
        });
      } catch {
        // Non-fatal: the archive exists, the marker is just a note.
      }
    }

    return {
      ran: true,
      skipReason: "",
      movedCount: moveCount,
      archiveId,
      summary,
      summaryTokens: summary.estimatedTokens,
      durationMs: Date.now() - started,
    };
  }

  // ----------------------------------------------------------------
  // Transcript rendering (English, compact)
  // ----------------------------------------------------------------

  private renderTranscript(entries: readonly SessionEntry[]): string {
    const lines: string[] = [];
    let budget = ENTRY_CHAR_BUDGET;

    for (const e of entries) {
      const line = renderEntry(e);

      if (line.length > budget) {
        lines.push("… (older entries truncated to fit summarizer budget)");
        break;
      }

      lines.push(line);
      budget -= line.length;
    }

    return lines.join("\n");
  }

  // ----------------------------------------------------------------
  // Memory writes
  // ----------------------------------------------------------------

  private async writeSummaryToMemory(
    summary: SummaryResult
  ): Promise<void> {
    const { memoryStore } = this.opts;

    for (const d of summary.sections.decisions) {
      await memoryStore.appendDecision({
        decision: d,
        reason: "from compaction",
      });
    }

    for (const p of summary.sections.progress) {
      await memoryStore.appendProgress({
        task: p,
        status: "done",
      });
    }

    // Facts go to PROGRESS as pending notes.
    for (const f of summary.sections.facts) {
      await memoryStore.appendProgress({
        task: f,
        status: "pending",
        note: "fact",
      });
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function skip(
  reason: string,
  started: number
): CompactionResult {
  return {
    ran: false,
    skipReason: reason,
    movedCount: 0,
    archiveId: null,
    summary: null,
    summaryTokens: 0,
    durationMs: Date.now() - started,
  };
}

function renderEntry(e: SessionEntry): string {
  switch (e.kind) {
    case "user":
      return `USER: ${clip(e.text)}`;

    case "assistant":
      return `ASSISTANT: ${clip(e.text)}`;

    case "system-note":
      return `NOTE: ${clip(e.text)}`;

    case "tool-call":
      return `TOOL CALL ${e.name}(${clip(e.argumentsJson, 300)})`;

    case "tool-result":
      return `TOOL RESULT ${e.name} [${
        e.ok ? "ok" : "fail"
      }]: ${clip(e.summary, 300)}`;

    case "compaction-marker":
      return `COMPACTION ${e.archiveId}: ${clip(e.note)}`;
  }
}

function clip(s: string, max = 500): string {
  const one = s.replace(/\s+/g, " ").trim();

  return one.length <= max
    ? one
    : one.slice(0, max - 1) + "…";
}

function deriveTopic(entries: readonly SessionEntry[]): string {
  for (const e of entries) {
    if (e.kind === "user") {
      const t = e.text.replace(/\s+/g, " ").trim();

      return t.length <= 120
        ? t
        : t.slice(0, 119) + "…";
    }
  }

  return entries.length > 0
    ? `(${entries[0].kind} slice)`
    : "";
}