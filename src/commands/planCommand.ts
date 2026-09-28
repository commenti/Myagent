/**
 * src/commands/planCommand.ts
 * ---------------------------
 * The `/plan` slash command.
 *
 * Usage:
 *   /plan                     show PLAN.md + PROGRESS.md summary
 *   /plan full                show full PLAN.md and PROGRESS.md
 *   /plan decisions           show recent DECISIONS.md entries
 *   /plan history <query>     search archived history (HistoryRetriever)
 *   /plan clear               empty PLAN.md (does not touch PROGRESS.md)
 *
 * Notes:
 *   - Reads through MemoryStore; this command never touches files directly.
 *   - /plan history uses HistoryRetriever, which searches archive_index.json
 *     and returns only the matching slice of old conversation.
 *
 * All user-facing text is English.
 */

import type { CommandContext } from "../ui/Renderer";
import { MemoryStore } from "../memory/MemoryStore";
import { SessionLog } from "../session/SessionLog";
import { HistoryRetriever } from "../context/HistoryRetriever";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const RECENT_DECISIONS = 5;
const PLAN_ITEM_PREVIEW = 120;


// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

export async function run(ctx: CommandContext, args: string): Promise<string> {
  const trimmed = args.trim();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const head = tokens.length > 0 ? tokens[0].toLowerCase() : "";

  if (head === "full") return showFull(ctx);
  if (head === "decisions") return showDecisions(ctx);
  if (head === "history") return showHistory(ctx, tokens.slice(1).join(" ").trim());
  if (head === "clear") return clearPlan(ctx);

  return showSummary(ctx);
}


// ------------------------------------------------------------------
// Show (default)
// ------------------------------------------------------------------

async function showSummary(ctx: CommandContext): Promise<string> {
  const store = new MemoryStore(ctx.projectConfig.paths);

  const plan = await store.readPlan();
  const progress = await store.readProgress();

  if (plan.length === 0 && progress.length === 0) {
    return "no plan or progress yet.";
  }

  // Plan overview.
  if (plan.length > 0) {
    ctx.emit({ type: "note", text: `plan (${plan.length} section(s)):` });
    for (const section of plan) {
      ctx.emit({ type: "note", text: `  ${section.heading}` });
      for (const item of section.items.slice(0, 6)) {
        ctx.emit({ type: "note", text: `    - ${clip(item, PLAN_ITEM_PREVIEW)}` });
      }
      if (section.items.length > 6) {
        ctx.emit({
          type: "note",
          text: `    ... ${section.items.length - 6} more item(s)`,
        });
      }
    }
  } else {
    ctx.emit({ type: "note", text: "plan: (empty)" });
  }

  // Progress counters.
  const counts = countProgress(progress);
  const progressLine =
    `progress: ${counts.done} done, ${counts.pending} pending, ` +
    `${counts.blocked} blocked, ${counts.total} total`;
  ctx.emit({ type: "note", text: progressLine });

  return progressLine;
}


// ------------------------------------------------------------------
// Show (full)
// ------------------------------------------------------------------

async function showFull(ctx: CommandContext): Promise<string> {
  const store = new MemoryStore(ctx.projectConfig.paths);

  const planRaw = await store.readRaw("plan");
  const progressRaw = await store.readRaw("progress");

  ctx.emit({ type: "note", text: "=== PLAN.md ===" });
  ctx.emit({
    type: "note",
    text: planRaw.trim().length > 0 ? planRaw : "(empty)",
  });
  ctx.emit({ type: "note", text: "=== PROGRESS.md ===" });
  ctx.emit({
    type: "note",
    text: progressRaw.trim().length > 0 ? progressRaw : "(empty)",
  });

  return "plan + progress shown";
}


// ------------------------------------------------------------------
// Decisions
// ------------------------------------------------------------------

async function showDecisions(ctx: CommandContext): Promise<string> {
  const store = new MemoryStore(ctx.projectConfig.paths);
  const decisions = await store.readDecisions();

  if (decisions.length === 0) {
    return "no decisions recorded yet.";
  }

  const recent = decisions.slice(-RECENT_DECISIONS);
  ctx.emit({
    type: "note",
    text: `recent decisions (${recent.length} of ${decisions.length}):`,
  });
  for (const d of recent) {
    ctx.emit({ type: "note", text: `  [${d.ts}] ${clip(d.decision, 160)}` });
    if (d.reason.length > 0) {
      ctx.emit({ type: "note", text: `      reason: ${clip(d.reason, 160)}` });
    }
  }

  return `${recent.length} decision(s) shown`;
}


// ------------------------------------------------------------------
// History (raw archive search)
// ------------------------------------------------------------------

async function showHistory(ctx: CommandContext, query: string): Promise<string> {
  if (query.length === 0) {
    return "usage: /plan history <query>";
  }

  const log = new SessionLog(ctx.projectConfig.paths);
  try {
    await log.init();
  } catch (err) {
    return `cannot open session log: ${err instanceof Error ? err.message : String(err)}`;
  }

  const retriever = new HistoryRetriever(log);

  let result;
  try {
    result = await retriever.retrieve({ query });
  } catch (err) {
    return `history search failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!result.found) {
    ctx.emit({ type: "note", text: result.summary });
    return `no archived match for "${query}"`;
  }

  ctx.emit({ type: "note", text: result.markdown });
  return result.summary;
}


// ------------------------------------------------------------------
// Clear plan (not progress)
// ------------------------------------------------------------------

async function clearPlan(ctx: CommandContext): Promise<string> {
  const store = new MemoryStore(ctx.projectConfig.paths);
  try {
    await store.replacePlan([]);
  } catch (err) {
    return `failed to clear plan: ${err instanceof Error ? err.message : String(err)}`;
  }
  ctx.emit({ type: "note", text: "PLAN.md cleared (PROGRESS.md untouched)" });
  return "plan cleared";
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

interface ProgressCounts {
  readonly done: number;
  readonly pending: number;
  readonly blocked: number;
  readonly total: number;
}

function countProgress(
  entries: readonly { status: "done" | "pending" | "blocked" }[]
): ProgressCounts {
  let done = 0;
  let pending = 0;
  let blocked = 0;
  for (const e of entries) {
    if (e.status === "done") done++;
    else if (e.status === "blocked") blocked++;
    else pending++;
  }
  return { done, pending, blocked, total: entries.length };
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  return one.slice(0, n - 1) + "...";
}