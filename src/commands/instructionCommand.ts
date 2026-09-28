/**
 * src/commands/instructionCommand.ts
 * ----------------------------------
 * The `/instruction` slash command.
 *
 * Usage:
 *   /instruction                       show both (short preview)
 *   /instruction global                show global instructions (full)
 *   /instruction project               show project instructions (full)
 *   /instruction path                  show both file paths
 *
 *   /instruction global set <text>     replace global instructions
 *   /instruction global append <text>  append a line to global
 *   /instruction global clear          empty the global file
 *
 *   /instruction project set <text>    replace project instructions
 *   /instruction project append <text> append a line to project
 *   /instruction project clear         empty the project file
 *
 * Notes (ARCHITECTURE.md §7):
 *   - Both files are sent VERBATIM on every call. They are never summarized.
 *   - Global lives at ~/.agent-cli/instructions.md
 *   - Project lives at <cwd>/.agent-runtime/instructions.md
 *
 * All user-facing text is English.
 */

import type { CommandContext } from "../ui/Renderer";
import {
  loadInstructions,
  setGlobalInstructions,
  setProjectInstructions,
  type InstructionBundle,
} from "../memory/InstructionLoader";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const PREVIEW_CHARS = 400;
const TARGETS = ["global", "project"] as const;
type Target = (typeof TARGETS)[number];

const ACTIONS = ["set", "append", "clear"] as const;
type Action = (typeof ACTIONS)[number];


// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

export async function run(ctx: CommandContext, args: string): Promise<string> {
  const trimmed = args.trim();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];

  // /instruction  → preview both
  if (tokens.length === 0) {
    return showBoth(ctx);
  }

  const head = tokens[0].toLowerCase();

  if (head === "path" || head === "paths") {
    return showPaths(ctx);
  }

  if (!isTarget(head)) {
    return `unknown target "${head}". usage: /instruction [global|project|path] [...]`;
  }

  const target: Target = head;
  const rest = tokens.slice(1);

  // /instruction global      → show full
  if (rest.length === 0) {
    return showOne(ctx, target);
  }

  const action = rest[0].toLowerCase();
  if (!isAction(action)) {
    return `unknown action "${action}". usage: /instruction ${target} [set|append|clear] <text>`;
  }

  const payload = rest.slice(1).join(" ").trim();

  if (action === "clear") {
    return applyClear(ctx, target);
  }

  if (payload.length === 0) {
    return `usage: /instruction ${target} ${action} <text>`;
  }

  if (action === "set") return applySet(ctx, target, payload);
  return applyAppend(ctx, target, payload);
}


// ------------------------------------------------------------------
// Show
// ------------------------------------------------------------------

async function showBoth(ctx: CommandContext): Promise<string> {
  const bundle = await loadInstructions(ctx.homeConfig, ctx.projectConfig);

  ctx.emit({ type: "note", text: `global (${bundle.globalPath}):` });
  ctx.emit({
    type: "note",
    text: bundle.global.trim().length > 0 ? preview(bundle.global) : "(empty)",
  });

  ctx.emit({ type: "note", text: `project (${bundle.projectPath}):` });
  ctx.emit({
    type: "note",
    text: bundle.project.trim().length > 0 ? preview(bundle.project) : "(empty)",
  });

  return "instruction files shown (use /instruction path for full paths)";
}

async function showOne(ctx: CommandContext, target: Target): Promise<string> {
  const bundle = await loadInstructions(ctx.homeConfig, ctx.projectConfig);
  const content = target === "global" ? bundle.global : bundle.project;
  const path = target === "global" ? bundle.globalPath : bundle.projectPath;

  ctx.emit({ type: "note", text: `${target}: ${path}` });
  ctx.emit({
    type: "note",
    text: content.trim().length > 0 ? content : "(empty)",
  });

  const lines = content.split("\n").length;
  return `${target} instructions: ${lines} line(s), ${content.length} char(s)`;
}

async function showPaths(ctx: CommandContext): Promise<string> {
  const bundle = await loadInstructions(ctx.homeConfig, ctx.projectConfig);
  ctx.emit({ type: "note", text: `global:  ${bundle.globalPath}` });
  ctx.emit({ type: "note", text: `project: ${bundle.projectPath}` });
  return "paths shown";
}


// ------------------------------------------------------------------
// Mutations
// ------------------------------------------------------------------

async function applySet(
  ctx: CommandContext,
  target: Target,
  text: string
): Promise<string> {
  if (target === "global") {
    await setGlobalInstructions(ctx.homeConfig, text + "\n");
  } else {
    await setProjectInstructions(ctx.projectConfig, text + "\n");
  }
  const line = `${target} instructions replaced (${text.length} char(s))`;
  ctx.emit({ type: "note", text: line });
  return line;
}

async function applyAppend(
  ctx: CommandContext,
  target: Target,
  text: string
): Promise<string> {
  const bundle = await loadInstructions(ctx.homeConfig, ctx.projectConfig);
  const current = target === "global" ? bundle.global : bundle.project;
  const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const next = current + sep + text + "\n";

  if (target === "global") {
    await setGlobalInstructions(ctx.homeConfig, next);
  } else {
    await setProjectInstructions(ctx.projectConfig, next);
  }
  const line = `${target} instructions appended`;
  ctx.emit({ type: "note", text: line });
  return line;
}

async function applyClear(
  ctx: CommandContext,
  target: Target
): Promise<string> {
  if (target === "global") {
    await setGlobalInstructions(ctx.homeConfig, "");
  } else {
    await setProjectInstructions(ctx.projectConfig, "");
  }
  const line = `${target} instructions cleared`;
  ctx.emit({ type: "note", text: line });
  return line;
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isTarget(s: string): s is Target {
  return (TARGETS as readonly string[]).indexOf(s) >= 0;
}

function isAction(s: string): s is Action {
  return (ACTIONS as readonly string[]).indexOf(s) >= 0;
}

function preview(s: string): string {
  const one = s.trim();
  if (one.length <= PREVIEW_CHARS) return one;
  return one.slice(0, PREVIEW_CHARS - 1) + "...";
}

// Referenced so the imported type stays meaningful even if unused in a build.
export type { InstructionBundle };