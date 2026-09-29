/**
 * src/context/TokenBudget.ts
 * --------------------------
 * Tracks how full the model's context window is, and answers one key
 * question: "have we hit the compaction threshold yet?" (default 75%).
 *
 * Used by:
 *   • context/Compaction      — decides WHEN to summarize.
 *   • commands/costCommand    — shows token usage to the user.
 *   • orchestrator            — guards a single request before sending.
 *
 * Estimation:
 *   • Real token counts come from providers (UsageEvent) and are recorded.
 *   • For text we don't yet know the token count of, we estimate with a
 *     conservative heuristic: ~4 characters per token, rounded up.
 *   • Estimates are clearly marked as estimates, never mixed with real counts.
 *
 * No AI calls. No I/O. Pure arithmetic.
 */

import { getContextWindow, getCapabilities } from "../providers/CapabilityRegistry";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_COMPACTION_THRESHOLD = 0.75; // 75%
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MIN_RESERVE_TOKENS = 512;            // keep some room for the reply


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface TokenBudgetOptions {
  /** Model id — used to look up the context window. */
  readonly model: string;
  /** Fraction of the window at which compaction should trigger. Default 0.75. */
  readonly compactionThreshold?: number;
  /**
   * Override the context window entirely (e.g. user knows better than the
   * registry). If omitted, CapabilityRegistry is used.
   */
  readonly contextWindowOverride?: number;
}

export interface BudgetStatus {
  /** Total window size in tokens. */
  readonly contextWindow: number;
  /** Tokens currently counted as used (real + estimated). */
  readonly usedTokens: number;
  /** Tokens still free. */
  readonly freeTokens: number;
  /** usedTokens / contextWindow (0..1). */
  readonly fillRatio: number;
  /** True when fillRatio >= compactionThreshold. */
  readonly shouldCompact: boolean;
  /** The threshold that was used (0..1). */
  readonly compactionThreshold: number;
  /** True if any used tokens are estimates, not real provider counts. */
  readonly hasEstimates: boolean;
}


// ------------------------------------------------------------------
// TokenBudget
// ------------------------------------------------------------------

export class TokenBudget {
  private readonly model: string;
  private readonly contextWindow: number;
  private readonly compactionThreshold: number;

  /** Real token counts reported by providers. */
  private realInputTokens = 0;
  private realOutputTokens = 0;

  /** Tokens counted from text we haven't gotten a real count for. */
  private estimatedTokens = 0;

  constructor(opts: TokenBudgetOptions) {
    this.model = opts.model;

    // Priority for the context window:
    //   1. Explicit override passed by the caller (opts.contextWindowOverride)
    //   2. Testing override via env var AGENT_CLI_TEST_TOKEN_BUDGET
    //   3. The model's real window from CapabilityRegistry
    const envOverride = readEnvContextWindow();
    this.contextWindow =
      opts.contextWindowOverride && opts.contextWindowOverride > 0
        ? opts.contextWindowOverride
        : envOverride !== null
        ? envOverride
        : getContextWindow(opts.model);

    const t = opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
    this.compactionThreshold = clamp01(t);
  }


  // ----------------------------------------------------------------
  // Recording
  // ----------------------------------------------------------------

  /**
   * Record a real usage report from a provider.
   * Replaces the "current turn" input estimate, adds output.
   */
  public recordUsage(inputTokens: number, outputTokens: number): void {
    if (inputTokens > 0) this.realInputTokens = inputTokens;
    if (outputTokens > 0) this.realOutputTokens += outputTokens;
  }

  /**
   * Add a text blob whose tokens we do not know yet.
   * The estimate stays separate from real counts.
   */
  public recordEstimate(text: string): number {
    const n = estimateTokens(text);
    this.estimatedTokens += n;
    return n;
  }

  /** Replace all counts with the current conversation's numbers. */
  public reset(): void {
    this.realInputTokens = 0;
    this.realOutputTokens = 0;
    this.estimatedTokens = 0;
  }


  // ----------------------------------------------------------------
  // Status
  // ----------------------------------------------------------------

  public status(): BudgetStatus {
    const used = this.usedTokens();
    const free = Math.max(0, this.contextWindow - used);
    const ratio = this.contextWindow > 0 ? used / this.contextWindow : 0;
    return {
      contextWindow: this.contextWindow,
      usedTokens: used,
      freeTokens: free,
      fillRatio: ratio,
      shouldCompact: ratio >= this.compactionThreshold,
      compactionThreshold: this.compactionThreshold,
      hasEstimates: this.estimatedTokens > 0,
    };
  }

  /** Current used tokens (real input + real output + estimates). */
  public usedTokens(): number {
    return this.realInputTokens + this.realOutputTokens + this.estimatedTokens;
  }

  /** True once the fill ratio crosses the compaction threshold. */
  public shouldCompact(): boolean {
    return this.status().shouldCompact;
  }

  /**
   * Can we afford to send a request of `requestTokens` and still leave room
   * for a reply of at least MIN_RESERVE_TOKENS?
   */
  public canAfford(requestTokens: number): boolean {
    const used = this.usedTokens();
    return used + requestTokens + MIN_RESERVE_TOKENS <= this.contextWindow;
  }

  /** Free tokens, never below 0. */
  public free(): number {
    return Math.max(0, this.contextWindow - this.usedTokens());
  }

  /** The model this budget belongs to. */
  public getModel(): string {
    return this.model;
  }

  /** Capabilities of the model (tools, images, thinking…). */
  public capabilities() {
    return getCapabilities(this.model);
  }

  /** English one-line summary, safe to show in the TUI. */
  public summary(): string {
    const s = this.status();
    const pct = Math.round(s.fillRatio * 100);
    const est = s.hasEstimates ? " (includes estimates)" : "";
    return `${s.usedTokens}/${s.contextWindow} tokens (${pct}%)${est}`;
  }
}


// ------------------------------------------------------------------
// Estimation helpers (exported so callers stay consistent)
// ------------------------------------------------------------------

/**
 * Rough token estimate for a text blob.
 * Deliberately conservative (over-counts rather than under-counts).
 * Never returns 0 for non-empty input.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const byChars = Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
  // Whitespace-heavy text tokenizes worse; add a small cushion.
  const whitespace = (text.match(/\s/g) ?? []).length;
  const cushion = Math.ceil(whitespace / 16);
  return Math.max(1, byChars + cushion);
}

/** Estimate tokens for a list of strings, summed. */
export function estimateTokensMany(parts: readonly string[]): number {
  let total = 0;
  for (const p of parts) total += estimateTokens(p);
  return total;
}


// ------------------------------------------------------------------
// Testing override (env var)
// ------------------------------------------------------------------
// AGENT_CLI_TEST_TOKEN_BUDGET — if set to a positive integer, the context
// window is clamped to that many tokens. Intended ONLY for testing the
// Compaction / Summarizer path with a realistic-length conversation, without
// waiting for the real 128k+ window to fill. Never set by the CLI itself.
// ------------------------------------------------------------------

function readEnvContextWindow(): number | null {
  const raw = process.env.AGENT_CLI_TEST_TOKEN_BUDGET;
  if (!raw || raw.trim().length === 0) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}


// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return DEFAULT_COMPACTION_THRESHOLD;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
