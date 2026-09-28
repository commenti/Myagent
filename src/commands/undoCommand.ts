/**
 * src/commands/undoCommand.ts
 * ---------------------------
 * The `/undo` slash command (ARCHITECTURE.md §11).
 *
 * Usage:
 *   /undo                       show the last 5 commits (checkpoints)
 *   /undo list [n]              show the last n commits (default 5, max 30)
 *   /undo last                  show the single most recent commit
 *   /undo back <n>              plan to reset HEAD back n commits
 *   /undo to <sha>              plan to reset to a specific commit
 *   /undo confirm               execute the pending plan (from back/to)
 *   /undo cancel                drop any pending plan
 *   /undo status                show git status --short
 *
 * Safety:
 *   - back/to only PLANS the reset; it does not run it. You must call
 *     /undo confirm next. This prevents a single typo from wiping work.
 *   - Before executing, the command prints what will be lost (uncommitted
 *     changes and the commits being discarded).
 *   - Nothing runs outside the working directory.
 *
 * All user-facing text is English.
 */

import type { CommandContext } from "../ui/Renderer";
import { runTerminal, type TerminalResult } from "../tools/TerminalExec";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_LIST = 5;
const MAX_LIST = 30;
const GIT_TIMEOUT_MS = 30_000;


// ------------------------------------------------------------------
// Pending plan (module-scoped, per-process)
// ------------------------------------------------------------------
// A slash command has no per-session state object available today, so we
// keep the plan here. It resets when the CLI exits.
// ------------------------------------------------------------------

type Pending =
  | { readonly kind: "back"; readonly n: number }
  | { readonly kind: "to"; readonly sha: string }
  | null;

let pending: Pending = null;


// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

export async function run(ctx: CommandContext, args: string): Promise<string> {
  const trimmed = args.trim();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const head = tokens.length > 0 ? tokens[0].toLowerCase() : "";

  if (head === "confirm") return confirm(ctx);
  if (head === "cancel") return cancel(ctx);
  if (head === "list") return list(ctx, parseCount(tokens[1]));
  if (head === "last") return showLast(ctx);
  if (head === "back") return planBack(ctx, tokens.slice(1));
  if (head === "to") return planTo(ctx, tokens.slice(1));
  if (head === "status") return showStatus(ctx);

  return list(ctx, DEFAULT_LIST);
}


// ------------------------------------------------------------------
// Git helpers
// ------------------------------------------------------------------

async function git(
  ctx: CommandContext,
  args: string
): Promise<TerminalResult> {
  return runTerminal({
    cwd: ctx.cwd,
    command: "git " + args,
    timeoutMs: GIT_TIMEOUT_MS,
  });
}

async function isGitRepo(ctx: CommandContext): Promise<boolean> {
  const r = await git(ctx, "rev-parse --is-inside-work-tree");
  return r.exitCode === 0 && r.stdout.trim() === "true";
}


// ------------------------------------------------------------------
// Read sub-commands
// ------------------------------------------------------------------

async function list(ctx: CommandContext, n: number): Promise<string> {
  if (!(await isGitRepo(ctx))) {
    return "not a git repository — /undo needs git.";
  }

  const count = Math.max(1, Math.min(MAX_LIST, n));
  const r = await git(
    ctx,
    `log --oneline --decorate -n ${count} --no-color`
  );

  if (r.exitCode !== 0) {
    return "git log failed: " + firstLine(r.stderr) || "git log failed";
  }

  const lines = r.stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return "no commits yet.";
  }

  ctx.emit({ type: "note", text: `last ${lines.length} commit(s):` });
  for (const l of lines) {
    ctx.emit({ type: "note", text: "  " + l });
  }

  if (pending) {
    ctx.emit({ type: "note", text: pendingLabel() });
  }

  return `${lines.length} commit(s) shown (use /undo back <n> or /undo to <sha>)`;
}

async function showLast(ctx: CommandContext): Promise<string> {
  if (!(await isGitRepo(ctx))) {
    return "not a git repository — /undo needs git.";
  }
  const r = await git(
    ctx,
    "log -1 --pretty=format:%h %s (%ci) --no-color"
  );
  if (r.exitCode !== 0 || r.stdout.trim().length === 0) {
    return "no commits yet.";
  }
  const line = r.stdout.trim();
  ctx.emit({ type: "note", text: "last commit: " + line });
  return line;
}

async function showStatus(ctx: CommandContext): Promise<string> {
  if (!(await isGitRepo(ctx))) {
    return "not a git repository — /undo needs git.";
  }
  const r = await git(ctx, "status --short --no-color");
  if (r.exitCode !== 0) {
    return "git status failed: " + firstLine(r.stderr);
  }
  const out = r.stdout.trim();
  if (out.length === 0) {
    ctx.emit({ type: "note", text: "working tree is clean." });
    return "clean";
  }
  ctx.emit({ type: "note", text: "git status:" });
  for (const line of out.split("\n")) {
    ctx.emit({ type: "note", text: "  " + line });
  }
  return "working tree has changes";
}


// ------------------------------------------------------------------
// Plan (non-destructive)
// ------------------------------------------------------------------

async function planBack(ctx: CommandContext, rest: string[]): Promise<string> {
  if (!(await isGitRepo(ctx))) {
    return "not a git repository — /undo needs git.";
  }
  const raw = rest[0];
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    return "usage: /undo back <n>   (n between 1 and 100)";
  }

  // Sanity check: does HEAD~n exist?
  const check = await git(ctx, `rev-parse --verify HEAD~${n}`);
  if (check.exitCode !== 0) {
    return `cannot go back ${n} commit(s) — not enough history.`;
  }

  pending = { kind: "back", n };

  const commits = await git(
    ctx,
    `log --oneline -n ${n} --no-color`
  );
  ctx.emit({
    type: "note",
    text: `about to discard the last ${n} commit(s):`,
  });
  for (const line of commits.stdout.split("\n")) {
    if (line.trim().length > 0) {
      ctx.emit({ type: "note", text: "  " + line.trimEnd() });
    }
  }

  await warnIfDirty(ctx);

  return `plan ready: reset HEAD back ${n} commit(s). run /undo confirm to execute.`;
}

async function planTo(ctx: CommandContext, rest: string[]): Promise<string> {
  if (!(await isGitRepo(ctx))) {
    return "not a git repository — /undo needs git.";
  }
  const sha = rest[0];
  if (!sha) return "usage: /undo to <sha>";

  const check = await git(ctx, `rev-parse --verify ${sha}`);
  if (check.exitCode !== 0) {
    return `unknown commit: ${sha}`;
  }
  const resolved = check.stdout.trim();

  pending = { kind: "to", sha: resolved };

  const info = await git(
    ctx,
    `log -1 --pretty=format:%h %s (%ci) --no-color ${resolved}`
  );
  ctx.emit({
    type: "note",
    text: `target commit: ${info.stdout.trim()}`,
  });
  ctx.emit({
    type: "note",
    text: "warning: this discards every commit AFTER the target on this branch.",
  });

  await warnIfDirty(ctx);

  return `plan ready: reset to ${resolved.slice(0, 7)}. run /undo confirm to execute.`;
}


// ------------------------------------------------------------------
// Confirm / cancel
// ------------------------------------------------------------------

async function confirm(ctx: CommandContext): Promise<string> {
  if (!pending) {
    return "nothing pending. use /undo back <n> or /undo to <sha> first.";
  }

  if (!(await isGitRepo(ctx))) {
    pending = null;
    return "not a git repository — /undo needs git.";
  }

  const p = pending;
  pending = null;

  const cmd =
    p.kind === "back"
      ? `git reset --hard HEAD~${p.n}`
      : `git reset --hard ${p.sha}`;

  const r = await git(ctx, cmd.replace(/^git\s+/, ""));
  if (r.exitCode !== 0) {
    return "undo failed: " + (firstLine(r.stderr) || "unknown error");
  }

  const headNow = await git(ctx, "rev-parse --short HEAD");
  const head = headNow.exitCode === 0 ? headNow.stdout.trim() : "?";

  const line =
    p.kind === "back"
      ? `undone: reset back ${p.n} commit(s) — HEAD is now ${head}`
      : `undone: reset to ${p.sha.slice(0, 7)} — HEAD is now ${head}`;

  ctx.emit({ type: "tool-result", name: "/undo", ok: true, summary: line });
  return line;
}

function cancel(ctx: CommandContext): string {
  if (!pending) return "nothing pending.";
  pending = null;
  ctx.emit({ type: "note", text: "pending undo cancelled." });
  return "cancelled";
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function warnIfDirty(ctx: CommandContext): Promise<void> {
  const st = await git(ctx, "status --short --no-color");
  if (st.exitCode !== 0) return;
  const dirty = st.stdout.trim();
  if (dirty.length > 0) {
    ctx.emit({
      type: "note",
      text: "WARNING: working tree has uncommitted changes;",
    });
    ctx.emit({
      type: "note",
      text: "         reset --hard will discard them permanently.",
    });
  }
}

function pendingLabel(): string {
  if (!pending) return "";
  return pending.kind === "back"
    ? `pending: reset back ${pending.n} commit(s) (use /undo confirm)`
    : `pending: reset to ${pending.sha.slice(0, 7)} (use /undo confirm)`;
}

function parseCount(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIST;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIST;
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}