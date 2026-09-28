/**
 * src/orchestrator/TaskGraph.ts
 * -----------------------------
 * The live task graph for the current plan.
 *
 * Responsibilities:
 *   • Hold tasks with status (pending / active / done / failed / blocked).
 *   • Track dependencies between tasks.
 *   • Answer "what can run now?" (dependencies satisfied, not yet done).
 *   • Persist a human-readable snapshot to MemoryStore (PLAN.md + PROGRESS.md).
 *   • Reload from MemoryStore on startup so progress survives restarts.
 *
 * Not responsible for:
 *   • Deciding how to plan (that is Planner).
 *   • Executing tasks (that is StateMachine).
 *   • Recovery on failure (that is EscalationLadder + FailureLedger).
 *
 * No AI calls. Persistence only through MemoryStore.
 */

import type { MemoryStore, ProgressEntry } from "../memory/MemoryStore";
import type { Plan } from "./Planner";

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type TaskStatus = "pending" | "active" | "done" | "failed" | "blocked";

export interface Task {
  /** Stable id, e.g. "t1", "t2". */
  readonly id: string;
  /** Human title (English). */
  readonly title: string;
  /** Files likely involved. */
  readonly files: readonly string[];
  /** Optional verify command hint. */
  readonly verify?: string;
  /** Ids of tasks that must be `done` before this one can start. */
  readonly dependsOn: readonly string[];
  /** Phase heading this task came from (for grouping). */
  readonly phase: string;
  /** Current status. */
  status: TaskStatus;
  /** Optional note (English) — why failed/blocked, etc. */
  note?: string;
}

export interface TaskGraphSnapshot {
  readonly tasks: readonly Task[];
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly blocked: number;
  readonly pending: number;
  readonly active: number;
  readonly isComplete: boolean;
  readonly hasFailures: boolean;
}

export interface TaskGraphOptions {
  /** Cwd used for display only. */
  readonly cwd: string;
  /** MemoryStore for persistence (optional). */
  readonly memoryStore?: MemoryStore;
  /** If tasks carry a verify command that should be prefilled from the plan. */
  readonly defaultVerify?: string;
}

export class TaskGraphError extends Error {
  public readonly code: "unknown_task" | "cycle" | "io_error";

  constructor(code: TaskGraphError["code"], message: string) {
    super(message);
    this.name = "TaskGraphError";
    this.code = code;
  }
}

// ------------------------------------------------------------------
// TaskGraph
// ------------------------------------------------------------------

export class TaskGraph {
  private readonly memoryStore?: MemoryStore;
  private readonly defaultVerify?: string;

  /** Insertion-ordered map of id → Task. */
  private readonly tasks = new Map<string, Task>();

  constructor(opts: TaskGraphOptions) {
    if (opts.memoryStore) this.memoryStore = opts.memoryStore;
    if (opts.defaultVerify) this.defaultVerify = opts.defaultVerify;
  }

  // ----------------------------------------------------------------
  // Building from a plan
  // ----------------------------------------------------------------

  /**
   * Replace the graph with tasks derived from a plan.
   * Dependencies are linear within each phase (t1 → t2 → t3 …).
   * Phases depend on the last task of the previous phase.
   */
  public loadFromPlan(plan: Plan): void {
    this.tasks.clear();
    let counter = 0;
    let previousPhaseTail: string | null = null;

    for (const section of plan.sections) {
      let prevInPhase: string | null = previousPhaseTail;

      for (const step of section.steps) {
        counter++;
        const id = `t${counter}`;
        const dependsOn: string[] = [];

        if (prevInPhase) dependsOn.push(prevInPhase);

        const task: Task = {
          id,
          title: step.title,
          files: step.files,
          ...(step.verify
            ? { verify: step.verify }
            : this.defaultVerify
              ? { verify: this.defaultVerify }
              : {}),
          dependsOn,
          phase: section.heading,
          status: "pending",
        };

        this.tasks.set(id, task);
        prevInPhase = id;
      }

      previousPhaseTail = prevInPhase;
    }

    this.assertNoCycles();
  }

  /**
   * Merge loaded tasks from disk (see loadFromMemory) without clobbering
   * statuses already set in memory. Uses task title as the join key.
   */
  public mergeFromPlan(plan: Plan): void {
    const existingByTitle = new Map<string, Task>();

    for (const t of this.tasks.values()) {
      existingByTitle.set(normalize(t.title), t);
    }

    let counter = this.tasks.size;
    let previousPhaseTail: string | null = null;

    for (const section of plan.sections) {
      let prevInPhase: string | null = previousPhaseTail;

      for (const step of section.steps) {
        const existing = existingByTitle.get(normalize(step.title));

        if (existing) {
          prevInPhase = existing.id;
          continue;
        }

        counter++;
        const id = `t${counter}`;
        const dependsOn: string[] = [];

        if (prevInPhase) dependsOn.push(prevInPhase);

        const task: Task = {
          id,
          title: step.title,
          files: step.files,
          ...(step.verify
            ? { verify: step.verify }
            : this.defaultVerify
              ? { verify: this.defaultVerify }
              : {}),
          dependsOn,
          phase: section.heading,
          status: "pending",
        };

        this.tasks.set(id, task);
        prevInPhase = id;
      }

      previousPhaseTail = prevInPhase;
    }

    this.assertNoCycles();
  }

  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  /** All tasks, in insertion order. */
  public all(): readonly Task[] {
    return [...this.tasks.values()];
  }

  /** Get one task by id. */
  public get(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  /** Tasks with all dependencies done and status pending. */
  public ready(): readonly Task[] {
    const out: Task[] = [];

    for (const t of this.tasks.values()) {
      if (t.status !== "pending") continue;
      if (this.depsSatisfied(t)) out.push(t);
    }

    return out;
  }

  /** The single next task to run: first ready, or null. */
  public next(): Task | null {
    const ready = this.ready();
    return ready.length > 0 ? ready[0] : null;
  }

  /** True if every task is done (no failed/blocked/pending/active). */
  public isComplete(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status !== "done") return false;
    }

    return this.tasks.size > 0;
  }

  /** True if any task is failed or blocked. */
  public hasFailures(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status === "failed" || t.status === "blocked") {
        return true;
      }
    }

    return false;
  }

  /** Aggregate counts. */
  public snapshot(): TaskGraphSnapshot {
    let done = 0;
    let failed = 0;
    let blocked = 0;
    let pending = 0;
    let active = 0;

    for (const t of this.tasks.values()) {
      switch (t.status) {
        case "done":
          done++;
          break;
        case "failed":
          failed++;
          break;
        case "blocked":
          blocked++;
          break;
        case "active":
          active++;
          break;
        case "pending":
          pending++;
          break;
      }
    }

    return {
      tasks: [...this.tasks.values()],
      total: this.tasks.size,
      done,
      failed,
      blocked,
      pending,
      active,
      isComplete: this.isComplete(),
      hasFailures: this.hasFailures(),
    };
  }

  // ----------------------------------------------------------------
  // Mutations
  // ----------------------------------------------------------------

  public setStatus(
    id: string,
    status: TaskStatus,
    note?: string
  ): void {
    const t = this.tasks.get(id);

    if (!t) {
      throw new TaskGraphError(
        "unknown_task",
        `unknown task id: ${id}`
      );
    }

    t.status = status;

    if (note !== undefined) {
      t.note = note;
    } else if (status !== "failed" && status !== "blocked") {
      delete t.note;
    }
  }

  public markActive(id: string): void {
    this.setStatus(id, "active");
  }

  public markDone(id: string): void {
    this.setStatus(id, "done");
  }

  public markFailed(id: string, note: string): void {
    this.setStatus(id, "failed", note);
  }

  public markBlocked(id: string, note: string): void {
    this.setStatus(id, "blocked", note);
  }

  /**
   * Reset a task (and optionally its dependents) back to pending.
   * Used by /undo and rollbacks.
   */
  public reset(id: string, cascade = true): void {
    const t = this.tasks.get(id);

    if (!t) {
      throw new TaskGraphError(
        "unknown_task",
        `unknown task id: ${id}`
      );
    }

    t.status = "pending";
    delete t.note;

    if (cascade) {
      for (const other of this.tasks.values()) {
        if (other.dependsOn.includes(id)) {
          this.reset(other.id, true);
        }
      }
    }
  }

  /** Add a new task at the end, depending on the last task if none is given. */
  public addTask(input: {
    title: string;
    files?: readonly string[];
    verify?: string;
    dependsOn?: readonly string[];
    phase?: string;
  }): Task {
    let counter = this.tasks.size;
    let id: string;

    do {
      counter++;
      id = `t${counter}`;
    } while (this.tasks.has(id));

    const last = [...this.tasks.values()].pop();

    const deps = input.dependsOn
      ? [...input.dependsOn]
      : last
        ? [last.id]
        : [];

    const task: Task = {
      id,
      title: input.title,
      files: input.files ?? [],
      ...(input.verify ? { verify: input.verify } : {}),
      dependsOn: deps,
      phase: input.phase ?? "Ad-hoc",
      status: "pending",
    };

    this.tasks.set(id, task);
    this.assertNoCycles();

    return task;
  }

  // ----------------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------------

  /**
   * Write a readable snapshot to MemoryStore.
   * PLAN.md = structure (all tasks, with `[ ]`/`[x]`/`[!]` markers).
   * PROGRESS.md = the same, filtered by status.
   */
  public async persist(): Promise<void> {
    if (!this.memoryStore) return;

    const sections: {
      heading: string;
      items: string[];
    }[] = [];

    const grouped = new Map<string, string[]>();

    for (const t of this.tasks.values()) {
      const list = grouped.get(t.phase) ?? [];
      list.push(`${statusMark(t.status)} ${t.id} — ${t.title}`);
      grouped.set(t.phase, list);
    }

    for (const [heading, items] of grouped) {
      sections.push({ heading, items });
    }

    try {
      await this.memoryStore.replacePlan(sections);
    } catch (err) {
      throw new TaskGraphError(
        "io_error",
        err instanceof Error ? err.message : String(err)
      );
    }

    const progress: ProgressEntry[] = this.all().map((t) => {
      const status: ProgressEntry["status"] =
        t.status === "done"
          ? "done"
          : t.status === "failed"
            ? "blocked"
            : t.status === "blocked"
              ? "blocked"
              : "pending";

      return {
        task: `${t.id} — ${t.title}`,
        status,
        ...(t.note ? { note: t.note } : {}),
      };
    });

    try {
      await this.memoryStore.replaceProgress(progress);
    } catch (err) {
      throw new TaskGraphError(
        "io_error",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private depsSatisfied(t: Task): boolean {
    for (const depId of t.dependsOn) {
      const dep = this.tasks.get(depId);

      if (!dep) continue; // dangling dep — treat as satisfied

      if (dep.status !== "done") return false;
    }

    return true;
  }

  private assertNoCycles(): void {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const color = new Map<string, number>();

    for (const id of this.tasks.keys()) {
      color.set(id, WHITE);
    }

    const visit = (id: string): void => {
      const c = color.get(id) ?? WHITE;

      if (c === GRAY) {
        throw new TaskGraphError(
          "cycle",
          `cycle detected at task ${id}`
        );
      }

      if (c === BLACK) return;

      color.set(id, GRAY);

      const t = this.tasks.get(id);

      if (t) {
        for (const dep of t.dependsOn) {
          if (this.tasks.has(dep)) {
            visit(dep);
          }
        }
      }

      color.set(id, BLACK);
    };

    for (const id of this.tasks.keys()) {
      visit(id);
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function statusMark(s: TaskStatus): string {
  switch (s) {
    case "done":
      return "[x]";
    case "failed":
      return "[!]";
    case "blocked":
      return "[!]";
    case "active":
      return "[~]";
    case "pending":
      return "[ ]";
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// ------------------------------------------------------------------
// Convenience: convert task graph back to memory sections (already done in
// persist(); this export is for callers that want it without persisting).
// ------------------------------------------------------------------

export function tasksToMemorySections(
  tasks: readonly Task[]
): readonly {
  heading: string;
  items: readonly string[];
}[] {
  const grouped = new Map<string, string[]>();

  for (const t of tasks) {
    const list = grouped.get(t.phase) ?? [];
    list.push(`${statusMark(t.status)} ${t.id} — ${t.title}`);
    grouped.set(t.phase, list);
  }

  return [...grouped.entries()].map(
    ([heading, items]) => ({
      heading,
      items,
    })
  );
}