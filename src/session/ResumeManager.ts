/**
 * src/session/ResumeManager.ts
 * ----------------------------
 * Startup-time check: is there an unfinished session in this project?
 *
 * Called by src/index.ts after config load. If a resumable session exists,
 * the TUI can prompt the user (or auto-resume when --resume was passed).
 *
 * Signals consulted:
 *   • sessions/current.jsonl  — non-empty, and last entry is not a clean end
 *   • PLAN.md / PROGRESS.md   — tasks with status pending / active / blocked
 *   • last-entry timestamp    — for the "resumed from X minutes ago" line
 *
 * Read-only. No writes. No AI calls.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { HomeConfig } from "../config/HomeConfig";
import type { ProjectConfig } from "../config/ProjectConfig";
import type { SessionEntry } from "./SessionLog";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface ResumeSignals {
  readonly hasSessionEntries: boolean;
  readonly sessionEntryCount: number;
  readonly lastEntryAt: string | null;
  readonly pendingTasks: number;
  readonly activeTasks: number;
  readonly blockedTasks: number;
  readonly totalTasks: number;
}

export interface ResumeState {
  /** ISO timestamp of the last session activity. */
  readonly lastActivityIso: string | null;
  /** Rough age in minutes since last activity (null if unknown). */
  readonly minutesAgo: number | null;
  /** English one-liner suitable for the TUI. */
  readonly summary: string;
  /** Where the resume data comes from (English names). */
  readonly signals: ResumeSignals;
  /** True when the caller forced resume via --resume. */
  readonly forced: boolean;
}

export interface DetectOptions {
  /** When true, return a state even if signals are weak (still requires a session). */
  readonly forceResume?: boolean;
}

export class ResumeManagerError extends Error {
  public readonly code: "io_error" | "no_project";
  constructor(code: ResumeManagerError["code"], message: string) {
    super(message);
    this.name = "ResumeManagerError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// ResumeManager
// ------------------------------------------------------------------

export class ResumeManager {
  private readonly homeConfig: HomeConfig;
  private readonly projectConfig: ProjectConfig;

  constructor(opts: { homeConfig: HomeConfig; projectConfig: ProjectConfig }) {
    this.homeConfig = opts.homeConfig;
    this.projectConfig = opts.projectConfig;
  }


  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Detect whether there is an unfinished session to resume.
   * Returns null when there's nothing meaningful to resume and forceResume
   * is not set. Never throws for a missing file — that's just "no session".
   */
  public async detectResumableState(
    opts: DetectOptions = {}
  ): Promise<ResumeState | null> {
    const paths = this.projectConfig.paths;

    // 1. Read current.jsonl (tail only — we don't need the whole log).
    const entries = await readJsonlSafe(paths.currentSessionFile);
    const entryCount = entries.length;
    const last = entryCount > 0 ? entries[entryCount - 1] : null;
    const lastAt = last?.ts ?? null;

    // 2. Read task counts from PROGRESS.md (cheap parse, no MemoryStore dep).
    const taskCounts = await countTasksSafe(paths.progressFile);

    // 3. Decide whether this is resumable.
    const hasWork =
      taskCounts.pending > 0 ||
      taskCounts.active > 0 ||
      taskCounts.blocked > 0;

    const hasSession = entryCount > 0;

    // No session at all → nothing to resume (even with --resume).
    if (!hasSession) return null;

    // Session exists but no outstanding work and not forced → treat as clean.
    if (!hasWork && !opts.forceResume) {
      // Edge case: the last entry may be a compaction-marker only; still clean.
      return null;
    }

    const signals: ResumeSignals = {
      hasSessionEntries: hasSession,
      sessionEntryCount: entryCount,
      lastEntryAt: lastAt,
      pendingTasks: taskCounts.pending,
      activeTasks: taskCounts.active,
      blockedTasks: taskCounts.blocked,
      totalTasks: taskCounts.total,
    };

    const minutesAgo = lastAt ? minutesSince(lastAt) : null;
    const summary = buildSummary(signals, minutesAgo);

    return {
      lastActivityIso: lastAt,
      minutesAgo,
      summary,
      signals,
      forced: opts.forceResume === true,
    };
  }


  /**
   * Cheap "should I even ask?" check used by the TUI before rendering the
   * prompt. Same logic as detectResumableState but no summary built.
   */
  public async hasResumableSession(): Promise<boolean> {
    const state = await this.detectResumableState({ forceResume: true });
    return state !== null && state.signals.hasSessionEntries;
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function readJsonlSafe(absPath: string): Promise<SessionEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    return [];
  }
  if (raw.length === 0) return [];

  const out: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const parsed = JSON.parse(t) as { kind?: unknown; ts?: unknown; seq?: unknown };
      if (typeof parsed.ts === "string" && typeof parsed.seq === "number" && typeof parsed.kind === "string") {
        out.push(parsed as unknown as SessionEntry);
      }
    } catch {
      // skip malformed lines
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

interface TaskCounts {
  pending: number;
  active: number;
  blocked: number;
  total: number;
}

async function countTasksSafe(progressPath: string): Promise<TaskCounts> {
  let raw: string;
  try {
    raw = await fs.readFile(progressPath, "utf8");
  } catch {
    return { pending: 0, active: 0, blocked: 0, total: 0 };
  }

  let pending = 0;
  let active = 0;
  let blocked = 0;
  let total = 0;

  for (const line of raw.split("\n")) {
    // Match: "- [ ] task", "- [x] task", "- [!] task", "- [~] task"
    const m = line.match(/^\s*-\s*\[(x|!|~| )\]\s+\S/);
    if (!m) continue;
    total++;
    switch (m[1]) {
      case " ": pending++; break;
      case "~": active++; break;
      case "!": blocked++; break;
      case "x": break; // done, not outstanding
    }
  }

  return { pending, active, blocked, total };
}

function minutesSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = Date.now() - t;
  return Math.max(0, Math.floor(diff / 60_000));
}

function buildSummary(signals: ResumeSignals, minutesAgo: number | null): string {
  const parts: string[] = [];
  if (minutesAgo !== null) {
    if (minutesAgo < 1) parts.push("last activity just now");
    else if (minutesAgo === 1) parts.push("last activity 1 minute ago");
    else if (minutesAgo < 60) parts.push(`last activity ${minutesAgo} minutes ago`);
    else {
      const h = Math.floor(minutesAgo / 60);
      parts.push(`last activity ${h}h ago`);
    }
  }
  const outstanding =
    signals.pendingTasks + signals.activeTasks + signals.blockedTasks;
  if (outstanding > 0) {
    const bits: string[] = [];
    if (signals.pendingTasks > 0) bits.push(`${signals.pendingTasks} pending`);
    if (signals.activeTasks > 0) bits.push(`${signals.activeTasks} active`);
    if (signals.blockedTasks > 0) bits.push(`${signals.blockedTasks} blocked`);
    parts.push(`${outstanding} task(s) outstanding (${bits.join(", ")})`);
  } else {
    parts.push("unfinished session log");
  }
  return parts.join(" — ");
}


// ------------------------------------------------------------------
// Convenience for callers that want a one-shot check without a class
// ------------------------------------------------------------------

export async function detectResumable(
  homeConfig: HomeConfig,
  projectConfig: ProjectConfig,
  forceResume = false
): Promise<ResumeState | null> {
  const mgr = new ResumeManager({ homeConfig, projectConfig });
  return mgr.detectResumableState({ forceResume });
}


// Re-export the paths field so callers can keep imports tidy if needed.
export type { ProjectConfig };
void path; // keep path import meaningful for future use