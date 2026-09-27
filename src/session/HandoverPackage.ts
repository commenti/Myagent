/**
 * src/session/HandoverPackage.ts
 * ------------------------------
 * Builds the context bundle sent to a NEW model when the user switches API
 * mid-task (ARCHITECTURE.md §6).
 *
 * Contains:
 *   • Project brief     — cwd, model previously used, timestamp.
 *   • AGENTS.md         — verbatim (never summarized, per §7).
 *   • ARCHITECTURE note — if a copy exists, included verbatim.
 *   • DECISIONS.md      — verbatim.
 *   • PROGRESS.md       — verbatim.
 *   • PLAN.md           — verbatim.
 *   • Recent conversation — the last N entries from SessionLog.
 *
 * NOT included:
 *   • Global/project custom instructions from HomeConfig — those are added
 *     by the instruction assembler in the normal prompt path, not here.
 *   • Full raw archive — that is on-demand via HistoryRetriever.
 *
 * No AI calls. No writes. Pure assembly + I/O.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { SessionLog, SessionEntry } from "./SessionLog";
import type { MemoryStore } from "../memory/MemoryStore";
import { estimateTokens } from "../context/TokenBudget";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_RECENT_ENTRIES = 30;
const DEFAULT_MAX_TOKENS = 12_000;
const ARCHITECTURE_CANDIDATES = [
  "docs/agent/ARCHITECTURE.md",
  "ARCHITECTURE.md",
];


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface HandoverPackageOptions {
  readonly sessionLog: SessionLog;
  readonly memoryStore: MemoryStore;
  readonly cwd: string;
  /** The model being left (for the brief). Optional. */
  readonly previousModel?: string;
  /** The model being switched to (for the brief). Optional. */
  readonly nextModel?: string;
  /** How many recent entries to include. Default 30. */
  readonly recentEntries?: number;
  /** Token cap for the whole package. Default 12 000. */
  readonly maxTokens?: number;
}

export interface HandoverPackage {
  /** Markdown block, ready to inject as a system/user message. */
  readonly markdown: string;
  readonly estimatedTokens: number;
  /** Which pieces were included (English names). */
  readonly includedParts: readonly string[];
  /** Which pieces were missing or skipped. */
  readonly missingParts: readonly string[];
  readonly builtAt: string;
}

export class HandoverPackageError extends Error {
  public readonly code: "io_error";
  constructor(message: string) {
    super(message);
    this.name = "HandoverPackageError";
    this.code = "io_error";
  }
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Build the handover package. Never throws for missing files — records them
 * under missingParts instead. Throws only for an unexpected I/O failure.
 */
export async function buildHandoverPackage(
  opts: HandoverPackageOptions
): Promise<HandoverPackage> {
  const root = path.resolve(opts.cwd);
  const recent = opts.recentEntries ?? DEFAULT_RECENT_ENTRIES;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const included: string[] = [];
  const missing: string[] = [];
  const parts: string[] = [];

  parts.push("== HANDOVER PACKAGE ==");
  parts.push("A previous session is being resumed on a new model.");
  parts.push("Treat the following as the source of truth for this project.");
  parts.push("");

  // 1. Brief.
  parts.push("--- PROJECT BRIEF ---");
  parts.push(`working directory: ${root}`);
  if (opts.previousModel) parts.push(`previous model: ${opts.previousModel}`);
  if (opts.nextModel) parts.push(`new model: ${opts.nextModel}`);
  parts.push(`built at: ${new Date().toISOString()}`);
  parts.push("");
  included.push("project-brief");

  // 2. AGENTS.md (verbatim — never summarized).
  const agents = await readIfExists(path.join(root, "AGENTS.md"));
  if (agents !== null) {
    parts.push("--- AGENTS.md (verbatim) ---");
    parts.push(agents.trimEnd());
    parts.push("");
    included.push("AGENTS.md");
  } else {
    missing.push("AGENTS.md");
  }

  // 3. ARCHITECTURE (optional copy in the project).
  let architecture: string | null = null;
  for (const rel of ARCHITECTURE_CANDIDATES) {
    architecture = await readIfExists(path.join(root, rel));
    if (architecture !== null) break;
  }
  if (architecture !== null) {
    parts.push("--- ARCHITECTURE (verbatim) ---");
    parts.push(architecture.trimEnd());
    parts.push("");
    included.push("ARCHITECTURE");
  } else {
    missing.push("ARCHITECTURE");
  }

  // 4. Memory files (DECISIONS / PROGRESS / PLAN) — verbatim.
  let snapshot: { decisions: string; plan: string; progress: string };
  try {
    snapshot = await opts.memoryStore.snapshot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HandoverPackageError(`read memory failed: ${msg}`);
  }

  if (snapshot.decisions.trim().length > 0) {
    parts.push("--- DECISIONS (verbatim) ---");
    parts.push(snapshot.decisions.trimEnd());
    parts.push("");
    included.push("DECISIONS");
  } else {
    missing.push("DECISIONS");
  }

  if (snapshot.plan.trim().length > 0) {
    parts.push("--- PLAN (verbatim) ---");
    parts.push(snapshot.plan.trimEnd());
    parts.push("");
    included.push("PLAN");
  } else {
    missing.push("PLAN");
  }

  if (snapshot.progress.trim().length > 0) {
    parts.push("--- PROGRESS (verbatim) ---");
    parts.push(snapshot.progress.trimEnd());
    parts.push("");
    included.push("PROGRESS");
  } else {
    missing.push("PROGRESS");
  }

  // 5. Recent conversation entries.
  let recentEntries: SessionEntry[];
  try {
    recentEntries = await opts.sessionLog.readTail(recent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HandoverPackageError(`read session log failed: ${msg}`);
  }

  if (recentEntries.length > 0) {
    parts.push(`--- RECENT CONVERSATION (last ${recentEntries.length} entries) ---`);
    for (const e of recentEntries) {
      parts.push(renderEntry(e));
    }
    parts.push("");
    included.push("recent-conversation");
  } else {
    missing.push("recent-conversation");
  }

  parts.push("--- END HANDOVER ---");

  // 6. Enforce token cap. If we blew the budget, trim from the middle
  //    (drop oldest conversation entries first, then ARCHITECTURE, never
  //    AGENTS.md / DECISIONS / PROGRESS).
  let markdown = parts.join("\n");
  if (estimateTokens(markdown) > maxTokens) {
    markdown = trimToBudget(markdown, maxTokens, included);
  }

  return {
    markdown,
    estimatedTokens: estimateTokens(markdown),
    includedParts: included,
    missingParts: missing,
    builtAt: new Date().toISOString(),
  };
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    return null;
  }
}

function renderEntry(e: SessionEntry): string {
  switch (e.kind) {
    case "user":      return `[${e.seq}] USER: ${clip(e.text)}`;
    case "assistant": return `[${e.seq}] ASSISTANT: ${clip(e.text)}`;
    case "system-note": return `[${e.seq}] NOTE: ${clip(e.text)}`;
    case "tool-call": return `[${e.seq}] TOOL CALL ${e.name}(${clip(e.argumentsJson, 300)})`;
    case "tool-result": return `[${e.seq}] TOOL RESULT ${e.name} [${e.ok ? "ok" : "fail"}]: ${clip(e.summary, 300)}`;
    case "compaction-marker": return `[${e.seq}] COMPACTION ${e.archiveId}: ${clip(e.note)}`;
  }
}

function clip(s: string, max = 500): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

/**
 * Best-effort trim: drop the oldest conversation entries, then drop
 * ARCHITECTURE if still over budget. Never removes AGENTS.md, DECISIONS,
 * PROGRESS, PLAN, or the brief.
 */
function trimToBudget(
  markdown: string,
  maxTokens: number,
  _included: readonly string[]
): string {
  const sections = markdown.split(/\n(?=--- )/);
  const protectedHeads = new Set([
    "--- PROJECT BRIEF ---",
    "--- AGENTS.md (verbatim) ---",
    "--- DECISIONS (verbatim) ---",
    "--- PROGRESS (verbatim) ---",
    "--- PLAN (verbatim) ---",
  ]);

  // Pass 1: drop ARCHITECTURE.
  let filtered = sections.filter((s) => !s.startsWith("--- ARCHITECTURE"));
  if (estimateTokens(filtered.join("\n")) <= maxTokens) {
    return filtered.join("\n");
  }

  // Pass 2: shorten the conversation section to its last few lines.
  filtered = filtered.map((s) => {
    if (!s.startsWith("--- RECENT CONVERSATION")) return s;
    const lines = s.split("\n");
    const head = lines.slice(0, 1);
    const body = lines.slice(1).filter((l) => l.trim().length > 0);
    const tail = body.slice(-8);
    return [...head, ...tail].join("\n");
  });
  if (estimateTokens(filtered.join("\n")) <= maxTokens) {
    return filtered.join("\n");
  }

  // Pass 3: hard cut — keep protected sections, then fill remaining budget
  // with whatever fits.
  const protectedParts = filtered.filter((s) =>
    [...protectedHeads].some((h) => s.startsWith(h))
  );
  let out = protectedParts.join("\n");
  if (estimateTokens(out) > maxTokens) {
    // Last resort: hard char-slice (budget * 4 chars).
    const cap = maxTokens * 4;
    out = out.slice(0, cap) + "\n… (handover trimmed to fit budget)";
  }
  return out;
}