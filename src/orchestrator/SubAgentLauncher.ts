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


/**
 * Injection point for tests / alternate transports.
 * Default wiring streams from a ProviderAdapter.
 */
export type SubAgentFn = (req: ChatRequest) => Promise<string>;

export class SubAgentLaunchError extends Error {
  public readonly code: "empty_brief" | "model_error" | "timeout";
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

  if (!opts.brief.taskTitle || opts.brief.taskTitle.trim().length === 0) {
    throw new SubAgentLaunchError("empty_brief", "sub-agent brief has no taskTitle");
  }

  const systemPrompt = buildSystemPrompt(opts.reason);
  const userPrompt = buildUserPrompt(opts);

  const messages: ChatMessage[] = [
    { role: "system", parts: [{ kind: "text", text: systemPrompt }] },
    { role: "user", parts: [{ kind: "text", text: userPrompt }] },
  ];

  const req: ChatRequest = {
    model: opts.adapterConfig.model,
    messages,
    maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
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