/**
 * src/recovery/EscalationLadder.ts
 * --------------------------------
 * Decides what to do when a task fails. Per ARCHITECTURE.md §11 +
 * Core Principle #9:
 *
 *   1st failure (same fingerprint)  → retry (may use same approach)
 *   2nd failure (same fingerprint)  → retry, but approach MUST change
 *   3rd failure (same fingerprint)  → rollback + fresh-context sub-agent
 *   still failing                   → ask the user, stop
 *
 * "Same fingerprint" means the FailureLedger's ErrorFingerprint.hash matches.
 * Different fingerprints each start their own count.
 *
 * This module makes the DECISION and returns a plan. Execution (retry,
 * rollback, launching a sub-agent) belongs to StateMachine.
 *
 * No AI calls. No file writes.
 */

import type {
  FailureLedger,
  FailureRecord,
} from "./FailureLedger";
import { fingerprint, type ErrorCategory } from "./ErrorFingerprint";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_RETRY_LIMIT = 1;       // retries allowed without changing approach
const DEFAULT_CHANGE_LIMIT = 2;      // after this many, escalate further
const DEFAULT_ROLLBACK_LIMIT = 3;    // at this many, rollback + fresh context
    // at this many, stop and ask the user


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type EscalationAction =
  | "retry"                 // same approach is still allowed
  | "retry-new-approach"    // must change something (files, plan, strategy)
  | "rollback-and-debug"    // rollback + launch fresh-context sub-agent
  | "ask-user"              // stop and ask the human
  ;

export interface EscalationDecision {
  readonly action: EscalationAction;
  /** 1-based count of this fingerprint at the time of decision. */
  readonly occurrence: number;
  /** True if the caller must apply `gitRollback` before the next attempt. */
  readonly mustRollback: boolean;
  /** True if a fresh-context sub-agent should be launched for debug. */
  readonly launchSubAgent: boolean;
  /** English one-liner for the activity stream. */
  readonly explanation: string;
  /** Previous attempts for this fingerprint (most recent last). */
  readonly history: readonly FailureRecord[];
}

export interface EscalationOptions {
  readonly ledger: FailureLedger;
  /** Override defaults per project if needed. */
  readonly retryLimit?: number;
  readonly changeLimit?: number;
  readonly rollbackLimit?: number;
  readonly askUserLimit?: number;
}

export class EscalationError extends Error {
  public readonly code: "io_error";
  constructor(message: string) {
    super(message);
    this.name = "EscalationError";
    this.code = "io_error";
  }
}


// ------------------------------------------------------------------
// EscalationLadder
// ------------------------------------------------------------------

export class EscalationLadder {
  private readonly ledger: FailureLedger;
  private readonly retryLimit: number;
  private readonly changeLimit: number;
  private readonly rollbackLimit: number;
  

  constructor(opts: EscalationOptions) {
    this.ledger = opts.ledger;
    this.retryLimit = opts.retryLimit ?? DEFAULT_RETRY_LIMIT;
    this.changeLimit = opts.changeLimit ?? DEFAULT_CHANGE_LIMIT;
    this.rollbackLimit = opts.rollbackLimit ?? DEFAULT_ROLLBACK_LIMIT;
    
  }


  // ----------------------------------------------------------------
  // Recording
  // ----------------------------------------------------------------

  /**
   * Record a failure in the ledger and return the decision.
   * Combines "record" + "decide" so callers can't forget one of them.
   */
  public async recordAndDecide(input: {
    output: string;
    command?: string;
    exitCode?: number;
    taskId?: string;
    approach?: string;
  }): Promise<EscalationDecision> {
    let count: number;
    try {
      const result = await this.ledger.record(input);
      count = result.count;
    } catch (err) {
      throw new EscalationError(err instanceof Error ? err.message : String(err));
    }

    const { hash } = fingerprint({
      output: input.output,
      command: input.command,
      exitCode: input.exitCode,
    });
    const history = this.ledger.occurrencesFor(hash);

    return this.decideFromCount(count, history, hash);
  }


  /**
   * Decide without recording — useful when the caller already recorded,
   * or wants a dry-run answer.
   */
  public async decide(input: {
    output: string;
    command?: string;
    exitCode?: number;
  }): Promise<EscalationDecision> {
    const { hash } = fingerprint({
      output: input.output,
      command: input.command,
      exitCode: input.exitCode,
    });
    await this.ledger.load();
    const count = this.ledger.countFor(hash);
    const history = this.ledger.occurrencesFor(hash);
    return this.decideFromCount(count, history, hash);
  }


  // ----------------------------------------------------------------
  // Decision table
  // ----------------------------------------------------------------

  private decideFromCount(
    count: number,
    history: readonly FailureRecord[],
    hash: string
  ): EscalationDecision {
    // 0 → this is not really a failure; treat as first retry.
    if (count <= this.retryLimit) {
      return {
        action: "retry",
        occurrence: Math.max(1, count),
        mustRollback: false,
        launchSubAgent: false,
        explanation:
          `failure #${count} of fingerprint ${hash} — same approach is still allowed once`,
        history,
      };
    }

    if (count <= this.changeLimit) {
      return {
        action: "retry-new-approach",
        occurrence: count,
        mustRollback: false,
        launchSubAgent: false,
        explanation:
          `failure #${count} of fingerprint ${hash} — approach MUST change`,
        history,
      };
    }

    if (count <= this.rollbackLimit) {
      return {
        action: "rollback-and-debug",
        occurrence: count,
        mustRollback: true,
        launchSubAgent: true,
        explanation:
          `failure #${count} of fingerprint ${hash} — rolling back and launching a fresh-context sub-agent`,
        history,
      };
    }

    // Past the rollback limit: still failing after fresh-context debug.
    return {
      action: "ask-user",
      occurrence: count,
      mustRollback: false,
      launchSubAgent: false,
      explanation:
        `failure #${count} of fingerprint ${hash} — stopping and asking the user`,
      history,
    };
  }


  // ----------------------------------------------------------------
  // Success
  // ----------------------------------------------------------------

  /**
   * Call this after a successful attempt to clear the fingerprint for that
   * error. Prevents a fixed error from being "remembered" against the task.
   */
  public async clearFor(input: {
    output: string;
    command?: string;
    exitCode?: number;
  }): Promise<void> {
    const { hash } = fingerprint({
      output: input.output,
      command: input.command,
      exitCode: input.exitCode,
    });
    await this.ledger.clearFor(hash);
  }

  /** Clear the whole ledger for a task (called when the task completes). */
  public async clearTask(taskId: string): Promise<void> {
    await this.ledger.clearTask(taskId);
  }


  // ----------------------------------------------------------------
  // Convenience
  // ----------------------------------------------------------------

  /** Number of past failures for the given raw error, without recording. */
  public async peekCount(input: {
    output: string;
    command?: string;
    exitCode?: number;
  }): Promise<number> {
    return this.ledger.peek(input.output, input.command, input.exitCode);
  }

  /** Whether this action means the task should be aborted. */
  public static isTerminal(action: EscalationAction): boolean {
    return action === "ask-user";
  }

  /** Whether this action means the previous changes must be undone. */
  public static requiresRollback(action: EscalationAction): boolean {
    return action === "rollback-and-debug";
  }
}


// ------------------------------------------------------------------
// Convenience: build a sub-agent brief from an escalation decision
// ------------------------------------------------------------------

export interface EscalationBriefInput {
  readonly taskTitle: string;
  readonly files: readonly string[];
  readonly currentError: string;
  readonly previousApproach?: string;
  readonly decision: EscalationDecision;
}

export interface EscalationBrief {
  readonly taskTitle: string;
  readonly files: readonly string[];
  readonly failureContext: string;
  readonly previousApproach?: string;
}

/**
 * Produce the brief that StateMachine passes to SubAgentLauncher when the
 * decision is "rollback-and-debug". Trims the error text and includes the
 * last attempted approach.
 */
export function buildEscalationBrief(input: EscalationBriefInput): EscalationBrief {
  const failureLines: string[] = [];
  failureLines.push(`Occurrence: ${input.decision.occurrence}`);
  failureLines.push(`Category: ${categoryOf(input.decision.history)}`);
  failureLines.push("Error:");
  failureLines.push(clip(input.currentError, 1200));

  const lastApproach =
    input.previousApproach ??
    lastApproachFromHistory(input.decision.history);

  const brief: EscalationBrief = {
    taskTitle: input.taskTitle,
    files: input.files,
    failureContext: failureLines.join("\n"),
    ...(lastApproach ? { previousApproach: lastApproach } : {}),
  };
  return brief;
}

function categoryOf(history: readonly FailureRecord[]): ErrorCategory {
  const last = history[history.length - 1];
  return last?.category ?? "unknown";
}

function lastApproachFromHistory(history: readonly FailureRecord[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const a = history[i].approach;
    if (a && a.trim().length > 0) return a;
  }
  return undefined;
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}