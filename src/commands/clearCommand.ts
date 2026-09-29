/**
 * src/commands/clearCommand.ts
 * ----------------------------
 * The /clear slash command.
 *
 * Usage:
 *   /clear              show what would be cleared and how to confirm
 *   /clear yes          clear the current session log (current.jsonl)
 *   /clear yes all      clear current.jsonl AND every archive file + index
 *
 * Two-step on purpose: the confirmation lives in the second command, so a
 * typo cannot destroy session history. No interactive overlay is required.
 *
 * All user-facing text is English.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { CommandContext } from "../ui/Renderer";
import { SessionLog } from "../session/SessionLog";


export async function run(ctx: CommandContext, args: string): Promise<string> {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 0) return showWarning(ctx);

  if (tokens[0] === "yes") {
    const all = tokens.includes("all");
    return execute(ctx, all);
  }

  return "usage: /clear            (show warning)\n" +
         "       /clear yes        (clear current session)\n" +
         "       /clear yes all    (clear current session + archives)";
}


async function showWarning(ctx: CommandContext): Promise<string> {
  const log = new SessionLog(ctx.projectConfig.paths);
  let stats = { entries: 0, bytes: 0 };
  try {
    await log.init();
    stats = await log.stats();
  } catch { /* show zeroes */ }

  let archiveCount = 0;
  try {
    const index = await log.readIndex();
    archiveCount = index.length;
  } catch { /* none */ }

  ctx.emit({ type: "note", text: "/clear — this deletes saved history. Cannot be undone." });
  ctx.emit({ type: "note", text: "  current session: " + stats.entries + " entry(ies), " + stats.bytes + " bytes" });
  ctx.emit({ type: "note", text: "  archived slices: " + archiveCount + " file(s)" });
  ctx.emit({ type: "note", text: "To confirm, run: /clear yes        (current session only)" });
  ctx.emit({ type: "note", text: "                /clear yes all    (current session + archives)" });

  return "clear pending — run /clear yes to confirm";
}


async function execute(ctx: CommandContext, all: boolean): Promise<string> {
  const log = new SessionLog(ctx.projectConfig.paths);

  try {
    await log.init();
  } catch (err) {
    return "clear failed: " + (err instanceof Error ? err.message : String(err));
  }

  // 1. Clear current.jsonl.
  try {
    await log.clearCurrent();
  } catch (err) {
    return "failed to clear current session: " + (err instanceof Error ? err.message : String(err));
  }

  if (!all) {
    ctx.emit({ type: "note", text: "current session cleared (archives kept)" });
    return "cleared current session";
  }

  // 2. Also clear every archive file + reset index.
  try {
    await log.clearArchives();
  } catch (err) {
    return "current cleared, but archives failed: " + (err instanceof Error ? err.message : String(err));
  }

  ctx.emit({ type: "note", text: "current session + all archives cleared" });
  return "cleared current session and archives";
}