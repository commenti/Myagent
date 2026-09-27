/**
 * src/memory/MemoryStore.ts
 * -------------------------
 * Owns the three project memory files inside .agent-runtime/:
 *   • DECISIONS.md — decisions made and why
 *   • PLAN.md      — current task breakdown
 *   • PROGRESS.md  — completed / pending tasks
 *
 * These files are the "Summary" layer (ARCHITECTURE.md §13.2). They are
 * always in context, so they must stay small. This module:
 *   • Reads each file as a whole.
 *   • Appends to structured sections (never blind concatenation).
 *   • Rewrites the whole file atomically on every change.
 *
 * Format (stable, parseable, human-readable):
 *
 *   # DECISIONS
 *   <!-- managed by agent-cli -->
 *
 *   ## 2025-01-15T09:12:00Z
 *   - **Decision:** use patch-based editing
 *     **Reason:** full rewrites lose intent and burn tokens
 *
 * No AI calls. No summarization. Pure file I/O.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { ProjectPaths } from "../config/ProjectConfig";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type MemoryFileKind = "decisions" | "plan" | "progress";

export interface DecisionEntry {
  readonly decision: string;
  readonly reason: string;
}

export interface ProgressEntry {
  readonly task: string;
  readonly status: "done" | "pending" | "blocked";
  /** Optional English note. */
  readonly note?: string;
}

export interface PlanSection {
  /** Heading text (e.g. "Phase 1"). */
  readonly heading: string;
  readonly items: readonly string[];
}

export class MemoryStoreError extends Error {
  public readonly code: "io_error" | "bad_paths";
  constructor(code: MemoryStoreError["code"], message: string) {
    super(message);
    this.name = "MemoryStoreError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const HEADERS: Readonly<Record<MemoryFileKind, string>> = {
  decisions: "# DECISIONS",
  plan: "# PLAN",
  progress: "# PROGRESS",
};

const MARKER = "<!-- managed by agent-cli — do not remove this line -->";


// ------------------------------------------------------------------
// MemoryStore
// ------------------------------------------------------------------

export class MemoryStore {
  private readonly paths: ProjectPaths;

  constructor(paths: ProjectPaths) {
    this.paths = paths;
  }


  // ----------------------------------------------------------------
  // Path resolution
  // ----------------------------------------------------------------

  private fileFor(kind: MemoryFileKind): string {
    switch (kind) {
      case "decisions": return this.paths.decisionsFile;
      case "plan":      return this.paths.planFile;
      case "progress":  return this.paths.progressFile;
    }
  }


  // ----------------------------------------------------------------
  // Raw read / write
  // ----------------------------------------------------------------

  /** Read the raw contents of one memory file. Returns "" if missing. */
  public async readRaw(kind: MemoryFileKind): Promise<string> {
    const file = this.fileFor(kind);
    try {
      return await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return "";
      const msg = err instanceof Error ? err.message : String(err);
      throw new MemoryStoreError("io_error", `read ${kind} failed: ${msg}`);
    }
  }

  /** Write the raw contents of one memory file (atomic). */
  public async writeRaw(kind: MemoryFileKind, content: string): Promise<void> {
    const file = this.fileFor(kind);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = file + ".tmp";
    try {
      await fs.writeFile(tmp, content, "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      throw new MemoryStoreError("io_error", `write ${kind} failed: ${msg}`);
    }
  }


  // ----------------------------------------------------------------
  // Snapshot (what goes into the system prompt)
  // ----------------------------------------------------------------

  /**
   * Read all three files at once. This is what the instruction assembler
   * puts into context. Missing files become empty strings.
   */
  public async snapshot(): Promise<{
    decisions: string;
    plan: string;
    progress: string;
  }> {
    const [decisions, plan, progress] = await Promise.all([
      this.readRaw("decisions"),
      this.readRaw("plan"),
      this.readRaw("progress"),
    ]);
    return { decisions, plan, progress };
  }


  // ----------------------------------------------------------------
  // Ensure seeded (idempotent)
  // ----------------------------------------------------------------

  /** Create the file with its header if it does not exist yet. */
  public async ensureSeeded(kind: MemoryFileKind): Promise<void> {
    const existing = await this.readRaw(kind);
    if (existing.trim().length > 0) return;
    await this.writeRaw(kind, this.emptyContent(kind));
  }

  private emptyContent(kind: MemoryFileKind): string {
    return `${HEADERS[kind]}\n${MARKER}\n`;
  }


  // ----------------------------------------------------------------
  // DECISIONS
  // ----------------------------------------------------------------

  /** Append one decision block to DECISIONS.md. */
  public async appendDecision(entry: DecisionEntry): Promise<void> {
    await this.ensureSeeded("decisions");
    const now = new Date().toISOString();
    const block =
      `\n## ${now}\n` +
      `- **Decision:** ${oneLine(entry.decision)}\n` +
      `  **Reason:** ${oneLine(entry.reason)}\n`;
    await this.appendBlock("decisions", block);
  }

  /** Read DECISIONS.md as structured entries (best-effort parse). */
  public async readDecisions(): Promise<readonly { ts: string; decision: string; reason: string }[]> {
    const raw = await this.readRaw("decisions");
    const out: { ts: string; decision: string; reason: string }[] = [];
    const sections = raw.split(/\n## /);
    for (let i = 1; i < sections.length; i++) {
      const chunk = sections[i];
      const firstNl = chunk.indexOf("\n");
      if (firstNl === -1) continue;
      const ts = chunk.slice(0, firstNl).trim();
      const body = chunk.slice(firstNl + 1);
      const decMatch = body.match(/\*\*Decision:\*\*\s*(.+)/);
      const reaMatch = body.match(/\*\*Reason:\*\*\s*(.+)/);
      if (decMatch) {
        out.push({
          ts,
          decision: decMatch[1].trim(),
          reason: reaMatch ? reaMatch[1].trim() : "",
        });
      }
    }
    return out;
  }


  // ----------------------------------------------------------------
  // PROGRESS
  // ----------------------------------------------------------------

  /** Append a progress line (done / pending / blocked). */
  public async appendProgress(entry: ProgressEntry): Promise<void> {
    await this.ensureSeeded("progress");
    const mark = entry.status === "done" ? "[x]" :
                 entry.status === "blocked" ? "[!]" : "[ ]";
    const note = entry.note && entry.note.trim().length > 0
      ? `  — ${oneLine(entry.note)}`
      : "";
    const line = `- ${mark} ${oneLine(entry.task)}${note}\n`;
    await this.appendBlock("progress", line);
  }

  /**
   * Replace the whole PROGRESS.md body with the given entries.
   * Used by compaction to keep the file from growing forever.
   */
  public async replaceProgress(entries: readonly ProgressEntry[]): Promise<void> {
    const lines = entries.map((e) => {
      const mark = e.status === "done" ? "[x]" :
                   e.status === "blocked" ? "[!]" : "[ ]";
      const note = e.note && e.note.trim().length > 0
        ? `  — ${oneLine(e.note)}`
        : "";
      return `- ${mark} ${oneLine(e.task)}${note}`;
    });
    const body = `${HEADERS.progress}\n${MARKER}\n\n${lines.join("\n")}\n`;
    await this.writeRaw("progress", body);
  }

  /** Parse PROGRESS.md into structured entries (best-effort). */
  public async readProgress(): Promise<readonly ProgressEntry[]> {
    const raw = await this.readRaw("progress");
    const out: ProgressEntry[] = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/^- \[(x|!| )\] (.+?)(?:\s+—\s+(.+))?$/);
      if (!m) continue;
      const status: ProgressEntry["status"] =
        m[1] === "x" ? "done" : m[1] === "!" ? "blocked" : "pending";
      const task = m[2].trim();
      const note = m[3]?.trim();
      out.push(note ? { task, status, note } : { task, status });
    }
    return out;
  }


  // ----------------------------------------------------------------
  // PLAN
  // ----------------------------------------------------------------

  /**
   * Replace PLAN.md with the given sections.
   * Plan is small and best replaced wholesale on each replan.
   */
  public async replacePlan(sections: readonly PlanSection[]): Promise<void> {
    const parts: string[] = [`${HEADERS.plan}`, MARKER, ""];
    for (const s of sections) {
      parts.push(`## ${oneLine(s.heading)}`);
      for (const item of s.items) parts.push(`- ${oneLine(item)}`);
      parts.push("");
    }
    await this.writeRaw("plan", parts.join("\n"));
  }

  /** Read PLAN.md sections (best-effort). */
  public async readPlan(): Promise<readonly PlanSection[]> {
    const raw = await this.readRaw("plan");
    const out: PlanSection[] = [];
    const chunks = raw.split(/\n## /);
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      const firstNl = chunk.indexOf("\n");
      if (firstNl === -1) continue;
      const heading = chunk.slice(0, firstNl).trim();
      const items = chunk
        .slice(firstNl + 1)
        .split("\n")
        .map((l) => l.match(/^- (.+)$/)?.[1]?.trim())
        .filter((x): x is string => typeof x === "string" && x.length > 0);
      out.push({ heading, items });
    }
    return out;
  }


  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async appendBlock(kind: MemoryFileKind, block: string): Promise<void> {
    const current = await this.readRaw(kind);
    const base = current.trim().length > 0 ? current : this.emptyContent(kind);
    const next = base.endsWith("\n") ? base + block : base + "\n" + block;
    await this.writeRaw(kind, next);
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}