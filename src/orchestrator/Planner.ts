/**
 * src/orchestrator/Planner.ts
 * ---------------------------
 * Builds the INITIAL plan for a task from:
 *   • the user's task description
 *   • a compact repo map (RepoMap.formatRepoMap)
 *   • current memory (PLAN.md + PROGRESS.md snapshot)
 *
 * Output is a structured Plan (sections + steps) that TaskGraph consumes.
 * The model call is INJECTED (PlanFn) so this module stays provider-agnostic.
 *
 * No file writes. No AI wiring. Pure orchestration + parsing.
 */

import type { RepoMap } from "../context/RepoMap";
import { formatRepoMap } from "../context/RepoMap";
import type { SummarySections } from "../context/Summarizer";
import { estimateTokens } from "../context/TokenBudget";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const MAX_MAP_FILES = 300;
const MAX_MAP_CHARS = 12_000;
const DEFAULT_MAX_STEPS = 20;


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface PlanStep {
  /** Short imperative title (English). */
  readonly title: string;
  /** Files likely involved (relative paths). */
  readonly files: readonly string[];
  /** Optional acceptance check hint (e.g. "npm run build"). */
  readonly verify?: string;
}

export interface PlanSection {
  /** Section heading, e.g. "Phase 1 — read code". */
  readonly heading: string;
  readonly steps: readonly PlanStep[];
}

export interface Plan {
  readonly task: string;
  readonly sections: readonly PlanSection[];
  readonly totalSteps: number;
  readonly builtAt: string;
  readonly raw: string;
  readonly usedFallback: boolean;
}

export interface PlannerInput {
  readonly task: string;
  readonly repoMap: RepoMap;
  /** Verbatim memory snapshot (optional). */
  readonly memory?: {
    readonly decisions?: string;
    readonly plan?: string;
    readonly progress?: string;
  };
  /** Where the CLI is running (for the brief). */
  readonly cwd: string;
  /** Cap on total steps across all sections. Default 20. */
  readonly maxSteps?: number;
}

export type PlanFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export class PlannerError extends Error {
  public readonly code: "empty_task" | "model_error";
  constructor(code: PlannerError["code"], message: string) {
    super(message);
    this.name = "PlannerError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Prompts (English)
// ------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a coding planner. Given a task and a repo map, produce a plan.

Output STRICT format, nothing else:

PHASE: <short phase name>
- <step title> | files: <comma-separated relative paths, or "unknown"> | verify: <optional command>

Rules:
- Use English only.
- Group steps into one or more PHASE blocks.
- Each step is ONE line. Use the exact " | files: ... | verify: ..." shape.
- "verify:" is optional; omit the segment when not applicable.
- Prefer small, verifiable steps over large vague ones.
- Do not include prose, commentary, or code fences.
- Do not invent file paths — only use paths from the repo map, or write "unknown".`;

function buildUserPrompt(input: PlannerInput): string {
  const lines: string[] = [];
  lines.push(`TASK: ${input.task}`);
  lines.push(`WORKING DIRECTORY: ${input.cwd}`);
  lines.push("");

  if (input.memory?.plan && input.memory.plan.trim().length > 0) {
    lines.push("CURRENT PLAN.MD:");
    lines.push(clip(input.memory.plan, 2000));
    lines.push("");
  }
  if (input.memory?.progress && input.memory.progress.trim().length > 0) {
    lines.push("CURRENT PROGRESS.MD:");
    lines.push(clip(input.memory.progress, 2000));
    lines.push("");
  }
  if (input.memory?.decisions && input.memory.decisions.trim().length > 0) {
    lines.push("CURRENT DECISIONS.MD (most recent only):");
    lines.push(clipTail(input.memory.decisions, 2000));
    lines.push("");
  }

  const mapText = clip(formatRepoMap(input.repoMap, MAX_MAP_FILES), MAX_MAP_CHARS);
  lines.push("REPO MAP:");
  lines.push(mapText);

  return lines.join("\n");
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Build a plan. Never throws for a parse failure — falls back to a single
 * phase with one generic step. Throws only for empty task or hard model error.
 */
export async function buildPlan(
  input: PlannerInput,
  callModel: PlanFn
): Promise<Plan> {
  if (!input.task || input.task.trim().length === 0) {
    throw new PlannerError("empty_task", "cannot plan an empty task");
  }

  const maxSteps = Math.max(1, input.maxSteps ?? DEFAULT_MAX_STEPS);
  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(input);

  let raw: string;
  try {
    raw = await callModel(systemPrompt, userPrompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PlannerError("model_error", `planner call failed: ${msg}`);
  }

  const parsed = parsePlan(raw, maxSteps);
  if (parsed.sections.length === 0) {
    return fallbackPlan(input.task, raw);
  }

  return {
    task: input.task,
    sections: parsed.sections,
    totalSteps: parsed.totalSteps,
    builtAt: new Date().toISOString(),
    raw,
    usedFallback: false,
  };
}


/** Convenience: flatten a plan into a linear list of steps with their phase. */
export function flattenPlan(plan: Plan): readonly { phase: string; step: PlanStep }[] {
  const out: { phase: string; step: PlanStep }[] = [];
  for (const s of plan.sections) {
    for (const step of s.steps) {
      out.push({ phase: s.heading, step });
    }
  }
  return out;
}


// ------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------

const PHASE_RE = /^PHASE:\s*(.+)$/i;

function parsePlan(raw: string, maxSteps: number): { sections: PlanSection[]; totalSteps: number } {
  const lines = raw.split(/\r?\n/);
  const sections: PlanSection[] = [];
  let current: { heading: string; steps: PlanStep[] } | null = null;
  let total = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const phaseMatch = trimmed.match(PHASE_RE);
    if (phaseMatch) {
      if (current) sections.push({ heading: current.heading, steps: current.steps });
      current = { heading: phaseMatch[1].trim() || "Phase", steps: [] };
      continue;
    }

    if (!current) continue;
    if (total >= maxSteps) break;

    const step = parseStep(trimmed);
    if (step) {
      current.steps.push(step);
      total++;
    }
  }

  if (current) sections.push({ heading: current.heading, steps: current.steps });

  // Drop empty sections.
  return {
    sections: sections.filter((s) => s.steps.length > 0),
    totalSteps: total,
  };
}

function parseStep(line: string): PlanStep | null {
  // Strip leading bullet.
  const body = line.replace(/^[-*•]\s*/, "").trim();
  if (body.length === 0) return null;

  const parts = body.split("|").map((p) => p.trim());
  const title = parts[0] ?? "";
  if (title.length === 0) return null;

  let files: string[] = [];
  let verify: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const mFiles = seg.match(/^files:\s*(.*)$/i);
    if (mFiles) {
      const list = mFiles[1].trim();
      if (list.length > 0 && list.toLowerCase() !== "unknown") {
        files = list.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
      }
      continue;
    }
    const mVerify = seg.match(/^verify:\s*(.*)$/i);
    if (mVerify) {
      const v = mVerify[1].trim();
      if (v.length > 0) verify = v;
    }
  }

  const step: PlanStep = {
    title: title.slice(0, 200),
    files,
    ...(verify ? { verify } : {}),
  };
  return step;
}


// ------------------------------------------------------------------
// Fallback
// ------------------------------------------------------------------

function fallbackPlan(task: string, raw: string): Plan {
  const fallback: PlanSection = {
    heading: "Phase 1",
    steps: [
      {
        title: `Read the code relevant to: ${clip(task, 120)}`,
        files: [],
      },
      {
        title: "Make the smallest change that satisfies the task",
        files: [],
      },
      {
        title: "Run the project's build/test to verify",
        files: [],
        verify: "npm run build",
      },
    ],
  };
  return {
    task,
    sections: [fallback],
    totalSteps: fallback.steps.length,
    builtAt: new Date().toISOString(),
    raw,
    usedFallback: true,
  };
}


// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function clipTail(s: string, n: number): string {
  if (s.length <= n) return s;
  return "…" + s.slice(s.length - n);
}

/** Re-exported for callers that want to convert a plan into memory sections. */
export type { PlanSection as PlanSectionType };

/** Turn a plan into MemoryStore.PlanSection[] shape. */
export function planToMemorySections(plan: Plan): readonly { heading: string; items: readonly string[] }[] {
  return plan.sections.map((s) => ({
    heading: s.heading,
    items: s.steps.map((st) => st.title),
  }));
}

/** Silence unused import warning if SummarySections is not referenced elsewhere. */
export type _SummarySections = SummarySections;