/**
 * src/orchestrator/StateMachine.ts
 * --------------------------------
 * The core loop: PLAN → EXECUTE → VERIFY → RETRY (ARCHITECTURE.md §11).
 *
 * Responsibilities:
 *   • Ask Planner for the plan (or accept an existing one).
 *   • Load tasks into TaskGraph and persist them.
 *   • Pick the next ready task, execute it (via injected executor).
 *   • Run the acceptance check via VerifyRunner.
 *   • On failure: record → EscalationLadder decides next action.
 *       - retry / retry-new-approach  → re-run the same task
 *       - rollback-and-debug          → rollback + launch sub-agent for debug
 *       - ask-user                    → stop, surface to the user
 *   • Persist progress after every transition.
 *
 * NOT responsible for:
 *   • How a task is actually executed (the model call + tool loop lives in
 *     the injected ExecutorFn — see below).
 *   • How verification is defined (VerifyRunner decides).
 *
 * No AI calls of its own. All model interaction goes through the injected
 * executor and the SubAgentLauncher.
 */

import type { Plan } from "./Planner";
import { buildPlan, type PlanFn } from "./Planner";
import type { RepoMap } from "../context/RepoMap";
import type { Task, TaskGraph } from "./TaskGraph";
import type { VerifyKind, VerifyReport } from "../tools/VerifyRunner";
import { runVerification } from "../tools/VerifyRunner";
import type { EscalationDecision, EscalationLadder } from "../recovery/EscalationLadder";
import { buildEscalationBrief } from "../recovery/EscalationLadder";
import type { SubAgentResult, SubAgentLaunchOptions } from "./SubAgentLauncher";
import { launchSubAgent } from "./SubAgentLauncher";
import type { SessionLog } from "../session/SessionLog";
import type { MemoryStore } from "../memory/MemoryStore";
import type { PermissionManager } from "../policy/PermissionManager";
import type { AdapterConfig, ProviderAdapter } from "../providers/AdapterBase";
import { estimateTokens } from "../context/TokenBudget";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface TaskExecutionResult {
  /** True if the model believes it finished the task. */
  readonly ok: boolean;
  /** Human-readable summary (English). */
  readonly summary: string;
  /** Combined stdout+stderr of any command the task ran (for fingerprints). */
  readonly output?: string;
  /** Optional exit code, if the task ran a command. */
  readonly exitCode?: number;
  /** Optional English description of the approach used (for escalation brief). */
  readonly approach?: string;
}

export interface ExecutionContext {
  readonly cwd: string;
  /** Current task. */
  readonly task: Task;
  /** Attempt number (1-based, resets per task). */
  readonly attempt: number;
  /** True when the approach must change (from a prior decision). */
  readonly mustChangeApproach: boolean;
  /** Emit an activity event. Never throws. */
  readonly onEvent: (ev: StateMachineEvent) => void;
}

export type ExecutorFn = (ctx: ExecutionContext) => Promise<TaskExecutionResult>;

export type AskUserFn = (question: string) => Promise<string>;
export type RollbackFn = (reason: string) => Promise<void>;

export interface StateMachineOptions {
  readonly cwd: string;
  readonly repoMap: RepoMap;
  readonly taskGraph: TaskGraph;
  readonly sessionLog: SessionLog;
  readonly memoryStore: MemoryStore;
  readonly escalation: EscalationLadder;
  /** VerifyRunner options (permissions, timeout, etc.). */
  readonly verify?: {
    readonly kinds?: readonly VerifyKind[];
    readonly permissions?: PermissionManager;
    readonly timeoutMs?: number;
  };
  /** The provider adapter + config used ONLY for sub-agent launches. */
  readonly subAgent: {
    readonly adapter: ProviderAdapter;
    readonly adapterConfig: AdapterConfig;
  };
  /** Executes one task. Required. */
  readonly executor: ExecutorFn;
  /** Asked only on the final escalation rung. Optional (defaults to abort). */
  readonly askUser?: AskUserFn;
  /** Runs a git rollback. Optional (defaults to no-op with a warning). */
  readonly rollback?: RollbackFn;
  /** Max attempts per task before the ladder forces escalation. Default 5. */
  readonly maxAttemptsPerTask?: number;
}

export type StateMachineEvent =
  | { type: "plan-built"; plan: Plan; usedFallback: boolean }
  | { type: "task-start"; task: Task; attempt: number }
  | { type: "task-executed"; task: Task; result: TaskExecutionResult }
  | { type: "verify-start"; task: Task }
  | { type: "verify-done"; task: Task; report: VerifyReport }
  | { type: "task-done"; task: Task }
  | { type: "task-failed"; task: Task; decision: EscalationDecision; error: string }
  | { type: "task-rolled-back"; task: Task; reason: string }
  | { type: "subagent-launched"; task: Task; result: SubAgentResult }
  | { type: "task-blocked"; task: Task; question: string; answer: string }
  | { type: "run-complete"; tasksDone: number; tasksFailed: number; durationMs: number }
  | { type: "note"; text: string };

export interface RunResult {
  readonly plan: Plan;
  readonly tasksDone: number;
  readonly tasksFailed: number;
  readonly tasksBlocked: number;
  readonly durationMs: number;
  readonly stoppedForUser: boolean;
}

export class StateMachineError extends Error {
  public readonly code: "no_executor" | "planner_error" | "io_error";
  constructor(code: StateMachineError["code"], message: string) {
    super(message);
    this.name = "StateMachineError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// StateMachine
// ------------------------------------------------------------------

export class StateMachine {
  private readonly opts: StateMachineOptions;
  private readonly maxAttemptsPerTask: number;

  constructor(opts: StateMachineOptions) {
    this.opts = opts;
    this.maxAttemptsPerTask = opts.maxAttemptsPerTask ?? 5;
    if (!opts.executor) {
      throw new StateMachineError("no_executor", "StateMachine requires an executor function");
    }
  }


  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Run the whole loop for a task. Builds a plan (or uses the one already
   * loaded in the TaskGraph if it is non-empty), executes ready tasks in
   * order, and returns a summary.
   */
  public async run(taskDescription: string, planFn: PlanFn): Promise<RunResult> {
    const started = Date.now();

    // 1. Plan — build fresh if the graph is empty; otherwise use what's there.
    let plan: Plan;
    if (this.opts.taskGraph.all().length === 0) {
      plan = await this.buildPlan(taskDescription, planFn);
      this.opts.taskGraph.loadFromPlan(plan);
      await this.persist();
      this.emit({ type: "plan-built", plan, usedFallback: plan.usedFallback });
    } else {
      plan = {
        task: taskDescription,
        sections: [],
        totalSteps: this.opts.taskGraph.all().length,
        builtAt: new Date().toISOString(),
        raw: "",
        usedFallback: false,
      };
    }

    // 2. Log the task start.
    try {
      await this.opts.sessionLog.append({ kind: "system-note", text: `task: ${taskDescription}` });
    } catch { /* non-fatal */ }

    // 3. Execute tasks until done, failed, or user asked to stop.
    let stoppedForUser = false;
    while (true) {
      if (this.opts.taskGraph.isComplete()) break;
      if (this.opts.taskGraph.hasFailures()) {
        // A failed/blocked task halts the graph (dependents can't run).
        break;
      }

      const next = this.opts.taskGraph.next();
      if (!next) {
        // Nothing ready but nothing complete either — treat as stuck.
        if (this.opts.taskGraph.ready().length === 0) {
          this.emit({ type: "note", text: "no ready tasks; stopping" });
          break;
        }
        continue;
      }

      const outcome = await this.runOneTask(next);
      if (outcome === "ask-user") {
        stoppedForUser = true;
        break;
      }
    }

    const snap = this.opts.taskGraph.snapshot();
    const durationMs = Date.now() - started;

    this.emit({
      type: "run-complete",
      tasksDone: snap.done,
      tasksFailed: snap.failed,
      durationMs,
    });

    try {
      await this.opts.sessionLog.append({
        kind: "system-note",
        text: `run complete: ${snap.done} done, ${snap.failed} failed, ${snap.blocked} blocked (${durationMs}ms)`,
      });
    } catch { /* non-fatal */ }

    return {
      plan,
      tasksDone: snap.done,
      tasksFailed: snap.failed,
      tasksBlocked: snap.blocked,
      durationMs,
      stoppedForUser,
    };
  }


  // ----------------------------------------------------------------
  // Single-task loop
  // ----------------------------------------------------------------

  private async runOneTask(task: Task): Promise<"continue" | "ask-user"> {
    let attempt = 0;
    let mustChangeApproach = false;
    let lastError = "";
    let lastOutput = "";
    let lastExitCode: number | undefined;
    let lastApproach: string | undefined;

    while (attempt < this.maxAttemptsPerTask) {
      attempt++;
      this.opts.taskGraph.markActive(task.id);
      await this.persist();
      this.emit({ type: "task-start", task, attempt });

      // 1. Execute.
      let exec: TaskExecutionResult;
      try {
        exec = await this.opts.executor({
          cwd: this.opts.cwd,
          task,
          attempt,
          mustChangeApproach,
          onEvent: (ev) => this.emit(ev),
        });
      } catch (err) {
        exec = {
          ok: false,
          summary: `executor threw: ${err instanceof Error ? err.message : String(err)}`,
          output: err instanceof Error ? err.stack ?? err.message : String(err),
        };
      }
      this.emit({ type: "task-executed", task, result: exec });
      lastApproach = exec.approach ?? lastApproach;

      // 2. If the executor itself failed, treat output as the failure signal.
      if (!exec.ok) {
        lastError = exec.summary;
        lastOutput = exec.output ?? exec.summary;
        lastExitCode = exec.exitCode;
      } else {
        // 3. Verify with a real check.
        this.emit({ type: "verify-start", task });
        const report = await this.runVerify();
        this.emit({ type: "verify-done", task, report });

        if (report.nothingToRun) {
          // No checks defined — accept the executor's own ok as final.
          this.opts.taskGraph.markDone(task.id);
          await this.persist();
          await this.clearTaskFailure(task.id);
          this.emit({ type: "task-done", task });
          return "continue";
        }

        if (report.allPassed) {
          this.opts.taskGraph.markDone(task.id);
          await this.persist();
          await this.clearTaskFailure(task.id);
          this.emit({ type: "task-done", task });
          return "continue";
        }

        // Verification failed — gather the output for the fingerprint.
        const firstFail = report.checks.find((c) => !c.skipped && !c.passed);
        lastError = `verify failed: ${firstFail?.kind ?? "unknown"}`;
        lastOutput =
          (firstFail?.result?.stdout ?? "") +
          (firstFail?.result?.stderr ?? "");
        lastExitCode = firstFail?.result?.exitCode ?? undefined;
        if (lastOutput.trim().length === 0) lastOutput = lastError;
      }

      // 4. Record + decide.
      const decision = await this.recordAndDecide({
        output: lastOutput,
        command: undefined,
        exitCode: lastExitCode,
        taskId: task.id,
        approach: lastApproach,
      });
      this.emit({ type: "task-failed", task, decision, error: lastError });

      // 5. Act on the decision.
      if (decision.action === "retry") {
        mustChangeApproach = false;
        continue;
      }

      if (decision.action === "retry-new-approach") {
        mustChangeApproach = true;
        continue;
      }

      if (decision.action === "rollback-and-debug") {
        // Roll back the working tree.
        try {
          if (this.opts.rollback) await this.opts.rollback(decision.explanation);
          this.emit({ type: "task-rolled-back", task, reason: decision.explanation });
        } catch (err) {
          this.emit({
            type: "note",
            text: `rollback failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        // Launch a fresh-context sub-agent for debug.
        const brief = buildEscalationBrief({
          taskTitle: task.title,
          files: task.files,
          currentError: lastOutput,
          previousApproach: lastApproach,
          decision,
        });
        const launchOpts: SubAgentLaunchOptions = {
          cwd: this.opts.cwd,
          repoMap: this.opts.repoMap,
          brief,
          adapter: this.opts.subAgent.adapter,
          adapterConfig: this.opts.subAgent.adapterConfig,
          reason: "recovery",
        };
        let subResult: SubAgentResult;
        try {
          subResult = await launchSubAgent(launchOpts);
        } catch (err) {
          subResult = {
            ok: false,
            summary: `sub-agent threw: ${err instanceof Error ? err.message : String(err)}`,
            raw: "",
            estimatedTokens: 0,
            durationMs: 0,
            reason: "recovery",
            error: err instanceof Error ? err.message : String(err),
          };
        }
        this.emit({ type: "subagent-launched", task, result: subResult });

        // Feed the sub-agent's summary into the next attempt as context.
        if (subResult.ok) {
          mustChangeApproach = true;
          lastApproach = `after sub-agent: ${subResult.summary}`.slice(0, 400);
          continue;
        }
        // Sub-agent failed too — fall through to ask-user on the next decision.
        lastOutput = lastOutput + "\n" + subResult.summary;
        continue;
      }

      if (decision.action === "ask-user") {
        return await this.askUser(task, lastError, decision);
      }
    }

    // Exceeded maxAttemptsPerTask — force an ask-user.
    const finalDecision = await this.recordAndDecide({
      output: lastOutput || lastError,
      exitCode: lastExitCode,
      taskId: task.id,
      approach: lastApproach,
    });
    return await this.askUser(task, lastError, finalDecision);
  }


  // ----------------------------------------------------------------
  // Ask-user rung
  // ----------------------------------------------------------------

  private async askUser(
    task: Task,
    lastError: string,
    decision: EscalationDecision
  ): Promise<"ask-user"> {
    const question =
      `Task "${task.id} — ${task.title}" is stuck.\n` +
      `Last error: ${clip(lastError, 300)}\n` +
      `Occurrence: ${decision.occurrence}.\n` +
      `Provide guidance to continue, or leave empty to abort this task.`;

    let answer = "";
    try {
      if (this.opts.askUser) answer = await this.opts.askUser(question);
    } catch { answer = ""; }

    this.emit({ type: "task-blocked", task, question, answer });

    this.opts.taskGraph.markBlocked(task.id, answer.trim().length > 0 ? "user replied" : "aborted");
    await this.persist();
    return "ask-user";
  }


  // ----------------------------------------------------------------
  // Planner / verify / ledger helpers
  // ----------------------------------------------------------------

  private async buildPlan(taskDescription: string, planFn: PlanFn): Promise<Plan> {
    const memory = await this.readMemorySafe();
    try {
      return await buildPlan(
        {
          task: taskDescription,
          repoMap: this.opts.repoMap,
          cwd: this.opts.cwd,
          memory,
        },
        planFn
      );
    } catch (err) {
      throw new StateMachineError(
        "planner_error",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async readMemorySafe(): Promise<{ decisions: string; plan: string; progress: string }> {
    try {
      return await this.opts.memoryStore.snapshot();
    } catch {
      return { decisions: "", plan: "", progress: "" };
    }
  }

  private async runVerify(): Promise<VerifyReport> {
    const v = this.opts.verify ?? {};
    return runVerification({
      cwd: this.opts.cwd,
      ...(v.kinds ? { kinds: v.kinds } : {}),
      ...(v.permissions ? { permissions: v.permissions } : {}),
      ...(v.timeoutMs !== undefined ? { timeoutMs: v.timeoutMs } : {}),
    });
  }

  private async recordAndDecide(input: {
    output: string;
    command?: string;
    exitCode?: number;
    taskId?: string;
    approach?: string;
  }): Promise<EscalationDecision> {
    return this.opts.escalation.recordAndDecide(input);
  }

  private async clearTaskFailure(taskId: string): Promise<void> {
    try {
      await this.opts.escalation.clearTask(taskId);
    } catch { /* non-fatal */ }
  }

  private async persist(): Promise<void> {
    try {
      await this.opts.taskGraph.persist();
    } catch (err) {
      this.emit({
        type: "note",
        text: `persist failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private emit(ev: StateMachineEvent): void {
    // Emit is best-effort; the caller may not have registered anything.
    // We currently only log to the session if it's a task-level event.
    if (ev.type === "task-done" || ev.type === "task-failed" || ev.type === "subagent-launched") {
      const line =
        ev.type === "task-done" ? `task ${ev.task.id} done` :
        ev.type === "task-failed" ? `task ${ev.task.id} failed: ${clip(ev.error, 200)}` :
        `subagent for ${ev.task.id}: ${ev.result.summary.slice(0, 200)}`;
      void this.opts.sessionLog.append({ kind: "system-note", text: line }).catch(() => {});
    }
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}


// Re-export for callers that want the estimator alongside StateMachine.
export { estimateTokens };