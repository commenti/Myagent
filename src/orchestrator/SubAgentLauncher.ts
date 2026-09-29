/**
 * src/orchestrator/SubAgentLauncher.ts
 * ------------------------------------
 * Decides WHEN a sub-agent should be launched, and runs it in an isolated
 * context. Per ARCHITECTURE.md §11 + Core Principle #6:
 *
 *   • Sub-agents launch ONLY for large / self-contained work, or to clean up
 *     a tangled context — NOT for small tasks.
 *   • The sub-agent gets a SCOPED brief (not the whole conversation).
 *   • Its result is condensed back into a few lines for the main agent.
 *
 * Reasons a sub-agent is launched (any is sufficient):
 *   • recovery: the same error repeated 3× (EscalationLadder reached final rung)
 *   • size: the task touches many files / spans multiple phases
 *   • isolation: the task is independent of the current working set
 *
 * No file writes. Model call injected via SubAgentFn.
 */

import type {
  AdapterConfig,
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
} from "../providers/AdapterBase";
import { normalizeError } from "../providers/ErrorClassifier";
import type { RepoMap } from "../context/RepoMap";
import { formatRepoMap, findSymbols } from "../context/RepoMap";
import type { Task } from "./TaskGraph";
import { estimateTokens } from "../context/TokenBudget";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const MAX_BRIEF_CHARS = 8_000;
const MAX_MAP_FILES = 150;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;
const DEFAULT_TIMEOUT_MS = 180_000;

// ------------------------------------------------------------------
// Hard caps — code-level guarantees, never delegated to the model
// ------------------------------------------------------------------

const HARD_MAX_TOTAL_SUBAGENTS = 4;          // per process / session
const HARD_MAX_TOKENS_PER_SUBAGENT = 8_000;  // per launch
const HARD_MAX_STEPS_PER_SUBAGENT = 12;      // per launch (informational)


// ------------------------------------------------------------------
// Session-wide sub-agent counter
// ------------------------------------------------------------------
// Sub-agents are opt-in. The launcher refuses to run once the session cap
// is reached, so a mistaken caller cannot exhaust the budget silently.
// ------------------------------------------------------------------

let launchedThisSession = 0;

export function resetSubAgentBudget(): void {
  launchedThisSession = 0;
}

export function subAgentsUsed(): number {
  return launchedThisSession;
}

export function subAgentsRemaining(): number {
  return Math.max(0, HARD_MAX_TOTAL_SUBAGENTS - launchedThisSession);
}


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type SubAgentReason = "recovery" | "size" | "isolation";

export interface LaunchDecision {
  readonly shouldLaunch: boolean;
  readonly reason: SubAgentReason | null;
  /** English explanation, safe for the activity stream. */
  readonly explanation: string;
}

export interface SubAgentBrief {
  /** Short, self-contained task description (English). */
  readonly taskTitle: string;
  /** Files that matter for this task. */
  readonly files: readonly string[];
  /** Optional hint about the current failure (for recovery mode). */
  readonly failureContext?: string;
  /** Optional hint: what the previous approach was. */
  readonly previousApproach?: string;
  /** Optional acceptance check. */
  readonly verifyHint?: string;
}

export interface SubAgentLaunchOptions {
  readonly cwd: string;
  readonly repoMap: RepoMap;
  readonly brief: SubAgentBrief;
  readonly adapter: ProviderAdapter;
  readonly adapterConfig: AdapterConfig;
  readonly reason: SubAgentReason;
  /**
   * MUST be `true`. The launcher refuses to run without it, which makes it
   * impossible for a caller to launch a sub-agent silently. Set this only
   * after the user has explicitly said yes to a proposal.
   */
  readonly userConfirmed: true;
  /** Optional slot id when this launch is part of a proposal. */
  readonly slotId?: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SubAgentResult {
  readonly ok: boolean;
  /** Short summary the main agent can ingest (English, few lines). */
  readonly summary: string;
  /** Full raw response from the sub-agent (for logs). */
  readonly raw: string;
  /** Estimated tokens of the summary (for budget accounting). */
  readonly estimatedTokens: number;
  readonly durationMs: number;
  readonly reason: SubAgentReason;
  /** Populated only when ok === false. */
  readonly error?: string;
}

// ------------------------------------------------------------------
// Proposal — describes a set of sub-agents WITHOUT launching any
// ------------------------------------------------------------------

export interface SubAgentSlot {
  readonly id: string;                    // "sa-1", "sa-2", ...
  readonly title: string;                 // short imperative
  readonly files: readonly string[];      // non-overlapping set
  readonly folders: readonly string[];    // top-level dirs derived from files
  readonly estimatedTokens: number;       // upper bound per slot
  readonly maxSteps: number;              // step cap per slot
}

export interface SubAgentProposal {
  readonly reason: SubAgentReason;
  readonly slots: readonly SubAgentSlot[];
  readonly totalEstimatedTokens: number;
  /** Ready-to-show yes/no question. */
  readonly question: string;
}

export interface PlanSubAgentsInput {
  readonly taskTitle: string;
  readonly files: readonly string[];
  readonly reason: SubAgentReason;
  readonly maxSlots?: number;
  readonly tokensPerSubagent?: number;
  readonly stepsPerSubagent?: number;
}


/**
 * Injection point for tests / alternate transports.
 * Default wiring streams from a ProviderAdapter.
 */
export type SubAgentFn = (req: ChatRequest) => Promise<string>;

export class SubAgentLaunchError extends Error {
  public readonly code:
    | "empty_brief"
    | "model_error"
    | "timeout"
    | "not_confirmed"
    | "budget_exhausted";
  constructor(code: SubAgentLaunchError["code"], message: string) {
    super(message);
    this.name = "SubAgentLaunchError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Decision
// ------------------------------------------------------------------

export interface DecideInput {
  /** The task being considered. */
  readonly task: Task;
  /** How many times the same error has recurred (from FailureLedger). */
  readonly sameErrorCount: number;
  /** Number of files in the current working set. */
  readonly workingSetSize: number;
  /** Optional: has the context grown past the compaction threshold twice? */
  readonly compactedRecently?: boolean;
}

const SIZE_FILE_THRESHOLD = 12;
const SIZE_TASK_FILE_THRESHOLD = 6;

/**
 * Decide whether to launch a sub-agent. Pure function.
 * Returns shouldLaunch:false with a reason when not needed — callers just
 * proceed in the main context.
 */
export function decideLaunch(input: DecideInput): LaunchDecision {
  // 1. Recovery — same error 3+ times (escalation reaches this rung).
  if (input.sameErrorCount >= 3) {
    return {
      shouldLaunch: true,
      reason: "recovery",
      explanation:
        `same error repeated ${input.sameErrorCount} times — ` +
        `escalating to a fresh-context sub-agent for debug`,
    };
  }

  // 2. Size — the task is large enough to deserve an isolated run.
  if (input.task.files.length >= SIZE_TASK_FILE_THRESHOLD) {
    return {
      shouldLaunch: true,
      reason: "size",
      explanation: `task touches ${input.task.files.length} files — isolating it`,
    };
  }
  if (input.workingSetSize >= SIZE_FILE_THRESHOLD) {
    return {
      shouldLaunch: true,
      reason: "size",
      explanation: `working set has ${input.workingSetSize} files — isolating to keep context small`,
    };
  }

  // 3. Isolation — tangled context after recent compaction.
  if (input.compactedRecently && input.task.dependsOn.length === 0) {
    return {
      shouldLaunch: true,
      reason: "isolation",
      explanation: "context was recently compacted; running this independent task in isolation",
    };
  }

  return {
    shouldLaunch: false,
    reason: null,
    explanation: "task is small and coupled to the current context — running inline",
  };
}

// ------------------------------------------------------------------
// Planning — split files by top-level folder so slots never overlap
// ------------------------------------------------------------------

function bucketByTopFolder(files: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const seg = f.split("/")[0] || ".";
    const list = map.get(seg);
    if (list) list.push(f);
    else map.set(seg, [f]);
  }
  return map;
}

/**
 * Build a proposal. Nothing is launched here — this is a pure description
 * of what COULD be launched, ready to show the user for a yes/no.
 *
 * Guarantees:
 *   - slots never share files (they are bucketed by top-level folder)
 *   - total slots ≤ HARD_MAX_TOTAL_SUBAGENTS
 *   - per-slot tokens ≤ HARD_MAX_TOKENS_PER_SUBAGENT
 *   - per-slot steps ≤ HARD_MAX_STEPS_PER_SUBAGENT
 */
export function planSubAgents(input: PlanSubAgentsInput): SubAgentProposal {
  const maxSlots = Math.max(
    1,
    Math.min(
      input.maxSlots ?? HARD_MAX_TOTAL_SUBAGENTS,
      HARD_MAX_TOTAL_SUBAGENTS
    )
  );
  const perTokens = Math.max(
    500,
    Math.min(
      input.tokensPerSubagent ?? 4_000,
      HARD_MAX_TOKENS_PER_SUBAGENT
    )
  );
  const perSteps = Math.max(
    1,
    Math.min(
      input.stepsPerSubagent ?? 6,
      HARD_MAX_STEPS_PER_SUBAGENT
    )
  );

  const buckets = bucketByTopFolder(input.files);
  const slots: SubAgentSlot[] = [];
  let idx = 0;

  for (const entry of buckets) {
    const folder = entry[0];
    const files = entry[1];

    if (slots.length >= maxSlots) {
      // Fold any remaining files into the last slot rather than dropping them.
      const last = slots[slots.length - 1];
      const mergedFiles = [...last.files, ...files];
      slots[slots.length - 1] = {
        id: last.id,
        title: last.title,
        files: mergedFiles,
        folders: last.folders,
        estimatedTokens: Math.min(
          HARD_MAX_TOKENS_PER_SUBAGENT,
          last.estimatedTokens + perTokens
        ),
        maxSteps: last.maxSteps,
      };
      continue;
    }

    idx++;
    slots.push({
      id: "sa-" + idx,
      title: input.taskTitle + " (" + folder + ")",
      files: [...files],
      folders: [folder],
      estimatedTokens: perTokens,
      maxSteps: perSteps,
    });
  }

  if (slots.length === 0) {
    // No files known — a single text-only slot is still useful.
    slots.push({
      id: "sa-1",
      title: input.taskTitle,
      files: [],
      folders: [],
      estimatedTokens: perTokens,
      maxSteps: perSteps,
    });
  }

  const total = slots.reduce((n, s) => n + s.estimatedTokens, 0);

  return {
    reason: input.reason,
    slots,
    totalEstimatedTokens: total,
    question:
      "This looks like a large task. Split it into " +
      slots.length +
      " sub-agent(s)? Each will work on its own folder — no overlap. " +
      "Estimated tokens: ~" +
      total +
      ".  (yes / no)",
  };
}

/** Human-readable rendering of a proposal for the confirmation prompt. */
export function renderProposal(proposal: SubAgentProposal): string {
  const lines: string[] = [];
  lines.push(proposal.question);
  lines.push("");
  for (const s of proposal.slots) {
    const scope =
      s.folders.length > 0 ? s.folders.join(", ") : "(no files — text-only)";
    lines.push(
      "  " +
        s.id +
        ": " +
        s.title +
        "   scope=" +
        scope +
        "   files=" +
        s.files.length +
        "   ~tokens=" +
        s.estimatedTokens +
        "   maxSteps=" +
        s.maxSteps
    );
  }
  return lines.join("\n");
}


// ------------------------------------------------------------------
// Brief building
// ------------------------------------------------------------------

function buildSystemPrompt(reason: SubAgentReason): string {
  const base =
    "You are a focused coding sub-agent. You receive a SELF-CONTAINED brief.\n" +
    "You do NOT have access to the main conversation — only what is below.\n" +
    "Be concise. Output a short summary at the end, prefixed with SUMMARY:";
  switch (reason) {
    case "recovery":
      return base + "\nThis is a RECOVERY run: the same error repeated. Try a DIFFERENT approach.";
    case "size":
      return base + "\nThis is a SIZED run: the task is large. Break it down if needed.";
    case "isolation":
      return base + "\nThis is an ISOLATION run: keep the change minimal and self-contained.";
  }
}

function buildUserPrompt(opts: SubAgentLaunchOptions): string {
  const { brief, repoMap, cwd } = opts;
  const lines: string[] = [];

  lines.push(`WORKING DIRECTORY: ${cwd}`);
  lines.push(`TASK: ${brief.taskTitle}`);
  lines.push("");

  if (brief.files.length > 0) {
    lines.push("RELEVANT FILES:");
    for (const f of brief.files.slice(0, 30)) lines.push(`- ${f}`);
    lines.push("");
  }

  if (brief.failureContext && brief.failureContext.trim().length > 0) {
    lines.push("CURRENT FAILURE:");
    lines.push(clip(brief.failureContext, 1500));
    lines.push("");
  }

  if (brief.previousApproach && brief.previousApproach.trim().length > 0) {
    lines.push("PREVIOUS APPROACH (do not repeat):");
    lines.push(clip(brief.previousApproach, 800));
    lines.push("");
  }

  if (brief.verifyHint && brief.verifyHint.trim().length > 0) {
    lines.push(`ACCEPTANCE CHECK: ${brief.verifyHint}`);
    lines.push("");
  }

  // Symbol context for the relevant files (cheap, focused).
  const symbols = collectSymbols(opts.repoMap, brief.files);
  if (symbols.length > 0) {
    lines.push("SYMBOLS IN THOSE FILES:");
    lines.push(symbols.join("\n"));
    lines.push("");
  }

  // A small repo map slice (top files only) — helps orient without flooding.
  lines.push("REPO MAP (excerpt):");
  lines.push(clip(formatRepoMap(repoMap, MAX_MAP_FILES), MAX_BRIEF_CHARS));

  return lines.join("\n");
}

function collectSymbols(map: RepoMap, files: readonly string[]): string[] {
  const wanted = new Set(files);
  const out: string[] = [];
  for (const f of map.files) {
    if (!wanted.has(f.relPath)) continue;
    if (f.symbols.length === 0) continue;
    const syms = f.symbols.slice(0, 20).map((s) => `${s.kind} ${s.name}`).join(", ");
    out.push(`${f.relPath}: ${syms}`);
  }
  return out;
}


// ------------------------------------------------------------------
// Default SubAgentFn (streams from an adapter)
// ------------------------------------------------------------------

export function makeAdapterSubAgentFn(
  adapter: ProviderAdapter,
  config: AdapterConfig
): SubAgentFn {
  return async (req: ChatRequest): Promise<string> => {
    let text = "";
    for await (const ev of adapter.streamChat(config, req)) {
      if (ev.type === "text-delta") text += ev.text;
      else if (ev.type === "done") break;
    }
    return text;
  };
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Launch a sub-agent. The brief must be self-contained; nothing else is
 * sent. Never throws for a model error — returns ok:false with a message.
 * Throws SubAgentLaunchError only for an empty brief or a timeout setup.
 */
export async function launchSubAgent(
  opts: SubAgentLaunchOptions,
  callSubAgent?: SubAgentFn
): Promise<SubAgentResult> {
  const started = Date.now();

  // Refuse to run without an explicit user confirmation.
  if (opts.userConfirmed !== true) {
    throw new SubAgentLaunchError(
      "not_confirmed",
      "sub-agent launch refused: explicit user confirmation is required"
    );
  }

  // Refuse to run once the session cap is reached.
  if (launchedThisSession >= HARD_MAX_TOTAL_SUBAGENTS) {
    throw new SubAgentLaunchError(
      "budget_exhausted",
      "sub-agent budget exhausted (" +
        HARD_MAX_TOTAL_SUBAGENTS +
        " per session)"
    );
  }

  if (!opts.brief.taskTitle || opts.brief.taskTitle.trim().length === 0) {
    throw new SubAgentLaunchError("empty_brief", "sub-agent brief has no taskTitle");
  }

  // Count this launch against the session budget before any work begins.
  launchedThisSession++;

  const systemPrompt = buildSystemPrompt(opts.reason);
  const userPrompt = buildUserPrompt(opts);

  const messages: ChatMessage[] = [
    { role: "system", parts: [{ kind: "text", text: systemPrompt }] },
    { role: "user", parts: [{ kind: "text", text: userPrompt }] },
  ];

  // Per-launch token cap — enforced in code, never left to the caller.
  const requestedTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const effectiveTokens = Math.max(
    128,
    Math.min(requestedTokens, HARD_MAX_TOKENS_PER_SUBAGENT)
  );

  const req: ChatRequest = {
    model: opts.adapterConfig.model,
    messages,
    maxOutputTokens: effectiveTokens,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const fn = callSubAgent ?? makeAdapterSubAgentFn(opts.adapter, opts.adapterConfig);

  let raw: string;
  try {
    raw = await withTimeout(fn(req), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof SubAgentLaunchError) throw err;
    const pe = normalizeError(err);
    return {
      ok: false,
      summary: `Sub-agent failed: ${pe.message}`,
      raw: "",
      estimatedTokens: 0,
      durationMs: Date.now() - started,
      reason: opts.reason,
      error: pe.message,
    };
  }

  const summary = extractSummary(raw);
  return {
    ok: summary.length > 0,
    summary: summary.length > 0 ? summary : "(sub-agent returned no summary)",
    raw,
    estimatedTokens: estimateTokens(summary),
    durationMs: Date.now() - started,
    reason: opts.reason,
  };
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function extractSummary(raw: string): string {
  if (!raw) return "";
  // Prefer an explicit SUMMARY: line, else the last non-empty paragraph.
  const idx = raw.lastIndexOf("SUMMARY:");
  if (idx !== -1) {
    const after = raw.slice(idx + "SUMMARY:".length).trim();
    const lines = after.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.slice(0, 6).join("\n").slice(0, 1000);
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.slice(-6).join("\n").slice(0, 1000);
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SubAgentLaunchError("timeout", `sub-agent timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}


// ------------------------------------------------------------------
// Convenience: symbol lookup re-export so callers don't import RepoMap twice
// ------------------------------------------------------------------

export { findSymbols };