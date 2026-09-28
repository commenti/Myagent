/**
 * src/commands/costCommand.ts
 * ---------------------------
 * The `/cost` slash command.
 *
 * Usage:
 *   /cost                show active profile, context window, estimated usage
 *   /cost model          show only the active model + capabilities
 *   /cost session        show only session-log token estimate
 *
 * Notes:
 *   - We do not persist real provider usage counts across process restarts,
 *     so numbers here are ESTIMATES derived from the session log.
 *     They are labeled as such.
 *   - Context window comes from CapabilityRegistry (per model).
 *   - No dollar pricing is shown — pricing depends on the user's provider
 *     and is intentionally out of scope.
 *
 * All user-facing text is English.
 */

import type { CommandContext } from "../ui/Renderer";
import { SessionLog } from "../session/SessionLog";
import { loadHomeConfig, getActiveProfile } from "../config/HomeConfig";
import {
  getContextWindow,
  getCapabilities,
  isKnownModel,
} from "../providers/CapabilityRegistry";
import { estimateTokens } from "../context/TokenBudget";


// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

export async function run(ctx: CommandContext, args: string): Promise<string> {
  const trimmed = args.trim().toLowerCase();

  if (trimmed === "model") return showModel(ctx);
  if (trimmed === "session") return showSession(ctx);

  return showFull(ctx);
}


// ------------------------------------------------------------------
// Full
// ------------------------------------------------------------------

async function showFull(ctx: CommandContext): Promise<string> {
  const modelLine = await showModelInternal(ctx);
  const sessionLine = await showSessionInternal(ctx);

  return modelLine + " | " + sessionLine;
}


// ------------------------------------------------------------------
// Model
// ------------------------------------------------------------------

async function showModel(ctx: CommandContext): Promise<string> {
  return showModelInternal(ctx);
}

async function showModelInternal(ctx: CommandContext): Promise<string> {
  const home = await loadHomeConfig();
  const active = getActiveProfile(home);

  if (!active) {
    const msg = "no active profile. use /api to add one.";
    ctx.emit({ type: "note", text: msg });
    return msg;
  }

  const window = getContextWindow(active.model);
  const caps = getCapabilities(active.model);
  const known = isKnownModel(active.model) ? "known" : "unknown";

  ctx.emit({ type: "note", text: "profile:  " + active.id });
  ctx.emit({ type: "note", text: "model:    " + active.model + " (" + known + ")" });
  if (active.effort) {
    ctx.emit({ type: "note", text: "effort:   " + active.effort });
  }
  if (active.summaryModel) {
    ctx.emit({ type: "note", text: "summary:  " + active.summaryModel });
  }
  ctx.emit({
    type: "note",
    text: "context:  " + window.toLocaleString("en-US") + " tokens",
  });
  ctx.emit({
    type: "note",
    text:
      "features: " +
      [
        caps.supportsTools ? "tools" : null,
        caps.supportsStreaming ? "streaming" : null,
        caps.supportsImages ? "images" : null,
        caps.supportsThinking ? "thinking" : null,
      ]
        .filter((x): x is string => x !== null)
        .join(", "),
  });

  return active.model + " (" + window.toLocaleString("en-US") + " ctx)";
}


// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------

async function showSession(ctx: CommandContext): Promise<string> {
  return showSessionInternal(ctx);
}

async function showSessionInternal(ctx: CommandContext): Promise<string> {
  const log = new SessionLog(ctx.projectConfig.paths);
  try {
    await log.init();
  } catch (err) {
    const msg = "cannot open session log: " + (err instanceof Error ? err.message : String(err));
    ctx.emit({ type: "note", text: msg });
    return msg;
  }

  let entries;
  try {
    entries = await log.readAll();
  } catch (err) {
    const msg = "cannot read session log: " + (err instanceof Error ? err.message : String(err));
    ctx.emit({ type: "note", text: msg });
    return msg;
  }

  if (entries.length === 0) {
    ctx.emit({ type: "note", text: "session is empty." });
    return "0 entries";
  }

  // Estimate tokens per entry kind.
  let inputEst = 0;
  let outputEst = 0;
  let toolEst = 0;

  for (const e of entries) {
    switch (e.kind) {
      case "user":
        inputEst += estimateTokens(e.text);
        break;
      case "assistant":
        outputEst += estimateTokens(e.text);
        break;
      case "tool-call":
        toolEst += estimateTokens(e.name + " " + e.argumentsJson);
        break;
      case "tool-result":
        toolEst += estimateTokens(e.name + " " + e.summary);
        break;
      case "system-note":
        toolEst += estimateTokens(e.text);
        break;
      case "compaction-marker":
        break;
    }
  }

  const total = inputEst + outputEst + toolEst;

  ctx.emit({
    type: "note",
    text: "session entries: " + entries.length,
  });
  ctx.emit({
    type: "note",
    text: "estimated tokens (input):   " + inputEst.toLocaleString("en-US"),
  });
  ctx.emit({
    type: "note",
    text: "estimated tokens (output):  " + outputEst.toLocaleString("en-US"),
  });
  ctx.emit({
    type: "note",
    text: "estimated tokens (tool I/O):" + " " + toolEst.toLocaleString("en-US"),
  });
  ctx.emit({
    type: "note",
    text: "estimated total:            " + total.toLocaleString("en-US"),
  });
  ctx.emit({
    type: "note",
    text: "(estimates only — real counts come from provider usage events)",
  });

  return "~" + total.toLocaleString("en-US") + " tokens across " + entries.length + " entries";
}