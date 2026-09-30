/**
 * src/index.ts — main entry point of agent-cli.
 * Bootstraps: args → cwd → config → resume-check → TUI.
 * All user-facing strings MUST be English (terminal UTF-8 safety).
 */

import { Command, CommanderError } from "commander";
import * as fs from "fs";
import * as path from "path";
import React from "react";
import { render } from "ink";

import { Renderer } from "./ui/Renderer";
import { loadHomeConfig, type HomeConfig } from "./config/HomeConfig";
import {
  loadProjectConfig,
  type ProjectConfig,
  type PermissionMode,
} from "./config/ProjectConfig";
import { ResumeManager, type ResumeState } from "./session/ResumeManager";

import { getActiveProfile } from "./config/HomeConfig";
import { loadApiKey } from "./commands/apiCommand";
import { detectProtocol } from "./providers/ProtocolDetector";
import type {
  AdapterConfig,
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
  ToolSchema,
} from "./providers/AdapterBase";
import { normalizeError, ProviderError } from "./providers/ErrorClassifier";
import { SessionLog } from "./session/SessionLog";
import type { ActivityItem } from "./ui/ActivityStream";
import { askPermission } from "./ui/permissionPrompt";
import { PermissionManager } from "./policy/PermissionManager";
import { loadAgentsMd } from "./memory/AgentsMdLoader";
import { loadInstructions, assembleInstructionBlock } from "./memory/InstructionLoader";
import { getSessionInstructions } from "./memory/SessionInstructions";
import { readFile } from "./tools/FileRead";
import { patchFile } from "./tools/FilePatchEdit";
import { createFile } from "./tools/FileCreate";
import { deleteFile } from "./tools/FileDelete";
import { grep } from "./tools/GrepSymbolSearch";
import { runTerminal } from "./tools/TerminalExec";
import { runVerification, type VerifyKind } from "./tools/VerifyRunner";
import { buildRepoMap } from "./context/RepoMap";
import { buildPlan, flattenPlan, type PlanFn } from "./orchestrator/Planner";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


function readVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}


interface ParsedArgs {
  readonly cwd: string;
  readonly verbose: boolean;
  readonly resume: boolean;
}


function buildProgram(): Command {
  const program = new Command();

  program
    .name("agent-cli")
    .description("Custom AI Coding Agent CLI — provider-agnostic, verification-first.")
    .version(readVersion(), "-v, --version", "print version and exit")
    .option("-C, --cwd <dir>", "working directory (default: current shell cwd)")
    .option("--verbose", "show more detail in the TUI", false)
    .option("--resume", "force-resume the previous unfinished session", false)
    .allowExcessArguments(false)
    .allowUnknownOption(false)
    .showHelpAfterError(true)
    .exitOverride();

  return program;
}


// ------------------------------------------------------------------
// Turn runner — wires one user message through the orchestrator.
// ------------------------------------------------------------------
// NOTE: this runs a real model call via the active profile's adapter.
// Tool execution (patch_edit / create / terminal) is NOT yet wired into the
// executor below — the model's text response is streamed to the activity
// panel, but its tool calls are only displayed, not executed. That is a
// follow-up (the tool loop).
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Tool definitions sent to the model on every call
// ------------------------------------------------------------------
// The model itself decides when to call any of these. The `plan` tool is
// how the model asks for a plan; `verify` is how it checks its own work.
// ------------------------------------------------------------------

function buildToolDefinitions(): ToolSchema[] {
  return [
    {
      name: "plan",
      description:
        "Break a large or multi-file task into phases and steps. Call this " +
        "ONLY when the request is genuinely big, spans multiple files, or is " +
        "unclear. For a single obvious change, skip planning and act directly. " +
        "For plain conversation, do not call any tool at all.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Short description of the task." },
        },
        required: ["task"],
      },
    },
    {
      name: "read_file",
      description: "Read a file from the working directory. Always fresh from disk.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
      },
    },
    {
      name: "patch_edit",
      description: "Replace an exact substring in an existing file. oldStr must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldStr: { type: "string" },
          newStr: { type: "string" },
        },
        required: ["path", "oldStr", "newStr"],
      },
    },
    {
      name: "create_file",
      description: "Create a new file. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a regular file inside the working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "grep",
      description: "Search for text or a regex across files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          regex: { type: "boolean" },
          extensions: { type: "array", items: { type: "string" } },
        },
        required: ["pattern"],
      },
    },
    {
      name: "run_terminal",
      description: "Run a shell command in the working directory.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "verify",
      description:
        "Run the project's build / test / lint checks. Call this after making " +
        "any change. Do not claim a task is done unless this passes (or the " +
        "project has no checks — then say so honestly).",
      parameters: {
        type: "object",
        properties: {
          kinds: { type: "array", items: { type: "string" } },
        },
      },
    },
  ];
}

function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function argStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface ToolCtx {
  readonly cwd: string;
  readonly permissions: PermissionManager | undefined;
  readonly emit: (item: ActivityItem) => void;
}

interface ToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly output: string;
}

async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolCtx
): Promise<ToolResult> {
  const a = parseArgs(argsJson);
  if (!a) return { ok: false, summary: "invalid JSON args for " + name, output: "" };

  try {
    switch (name) {
      case "read_file": {
        const p = argStr(a.path);
        if (!p) return { ok: false, summary: "read_file: missing path", output: "" };
        ctx.emit({ type: "tool-call", name: "read", args: p });
        const startLine = typeof a.startLine === "number" ? a.startLine : undefined;
        const endLine = typeof a.endLine === "number" ? a.endLine : undefined;
        const r = await readFile({
          cwd: ctx.cwd,
          filePath: p,
          ...(startLine !== undefined ? { startLine } : {}),
          ...(endLine !== undefined ? { endLine } : {}),
        });
        ctx.emit({ type: "file-read", path: r.relPath, lines: r.totalLines });
        return { ok: true, summary: r.relPath + " (" + r.totalLines + " lines)", output: r.content };
      }
      case "patch_edit": {
        const p = argStr(a.path);
        const o = argStr(a.oldStr);
        const n = argStr(a.newStr);
        if (!p || o === null || n === null) {
          return { ok: false, summary: "patch_edit: missing path/oldStr/newStr", output: "" };
        }
        ctx.emit({ type: "tool-call", name: "edit", args: p });
        const r = await patchFile({ cwd: ctx.cwd, filePath: p, oldStr: o, newStr: n });
        ctx.emit({ type: "file-edit", path: r.relPath, preview: r.preview, added: 0, removed: 0 });
        return { ok: true, summary: "patched " + r.relPath + " (" + r.matches + " match)", output: "OK" };
      }
      case "create_file": {
        const p = argStr(a.path);
        if (!p) return { ok: false, summary: "create_file: missing path", output: "" };
        ctx.emit({ type: "tool-call", name: "create", args: p });
        const r = await createFile({
          cwd: ctx.cwd,
          filePath: p,
          content: argStr(a.content) ?? "",
          ...(ctx.permissions ? { permissions: ctx.permissions } : {}),
        });
        return { ok: true, summary: "created " + r.relPath, output: "OK" };
      }
      case "delete_file": {
        const p = argStr(a.path);
        if (!p) return { ok: false, summary: "delete_file: missing path", output: "" };
        ctx.emit({ type: "tool-call", name: "delete", args: p });
        const r = await deleteFile({
          cwd: ctx.cwd,
          filePath: p,
          ...(ctx.permissions ? { permissions: ctx.permissions } : {}),
        });
        return { ok: true, summary: "deleted " + r.relPath, output: "OK" };
      }
      case "grep": {
        const pat = argStr(a.pattern);
        if (!pat) return { ok: false, summary: "grep: missing pattern", output: "" };
        ctx.emit({ type: "tool-call", name: "grep", args: pat });
        const extensions = Array.isArray(a.extensions)
          ? (a.extensions.filter((x) => typeof x === "string") as string[])
          : undefined;
        const r = await grep({
          cwd: ctx.cwd,
          pattern: pat,
          regex: a.regex === true,
          ...(extensions && extensions.length > 0 ? { extensions } : {}),
        });
        const body = r.matches.slice(0, 30)
          .map((m) => m.relPath + ":" + m.line + ": " + m.text).join("\n");
        return {
          ok: true,
          summary: r.matches.length + " match(es) in " + r.filesWithMatches + " file(s)",
          output: body || "(no matches)",
        };
      }
      case "run_terminal": {
        const cmd = argStr(a.command);
        if (!cmd) return { ok: false, summary: "run_terminal: missing command", output: "" };
        ctx.emit({ type: "tool-call", name: "run", args: cmd });
        const r = await runTerminal({
          cwd: ctx.cwd,
          command: cmd,
          ...(ctx.permissions ? { permissions: ctx.permissions } : {}),
        });
        const out = (r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim();
        if (out.length > 0) ctx.emit({ type: "terminal", chunk: out });
        return {
          ok: r.exitCode === 0 && !r.timedOut,
          summary: "exit " + (r.exitCode ?? "?") + (r.timedOut ? " (timeout)" : ""),
          output: out.slice(0, 4000) || "(no output)",
        };
      }
      case "verify": {
        const kinds = Array.isArray(a.kinds)
          ? (a.kinds.filter((x) => typeof x === "string") as VerifyKind[])
          : undefined;
        ctx.emit({ type: "tool-call", name: "verify", args: kinds ? kinds.join(",") : "all" });
        const r = await runVerification({
          cwd: ctx.cwd,
          ...(kinds ? { kinds } : {}),
          ...(ctx.permissions ? { permissions: ctx.permissions } : {}),
        });
        if (r.nothingToRun) {
          return { ok: false, summary: "no verify script found", output: "no scripts" };
        }
        const lines = r.checks.filter((c) => !c.skipped)
          .map((c) => c.kind + ": " + (c.passed ? "PASS" : "FAIL")).join("\n");
        return {
          ok: r.allPassed,
          summary: r.allPassed ? "all checks passed" : "failed: " + (r.firstFailure ?? "?"),
          output: lines,
        };
      }
      default:
        return { ok: false, summary: "unknown tool: " + name, output: "" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: name + " failed: " + msg, output: msg };
  }
}


type TurnRunner = (
  text: string,
  emit: (item: ActivityItem) => void
) => Promise<void>;

function buildTurnRunner(
  homeConfig: HomeConfig,
  projectConfig: ProjectConfig,
  cwd: string
): TurnRunner {
  return async (text, emit) => {
    // 1. Active profile.
    const active = getActiveProfile(homeConfig);
    if (!active) {
      emit({
        type: "note",
        text: "No active API profile. Add one with /api (opens a form).",
      });
      return;
    }

    // 2. Load key.
    let apiKey: string;
    try {
      apiKey = await loadApiKey(homeConfig.paths, active.keyRef);
    } catch (err) {
      emit({
        type: "error",
        text:
          'Cannot read API key for "' + active.id + '": ' +
          (err instanceof Error ? err.message : String(err)),
      });
      return;
    }

    // 3. Detect protocol → adapter + config.
    emit({ type: "thinking", label: "connecting to " + active.id });
    let adapter: ProviderAdapter;
    let adapterConfig: AdapterConfig;
    try {
      const detected = await detectProtocol({
        baseUrl: active.baseUrl,
        apiKey,
        model: active.model,
        ...(active.protocol ? { protocol: active.protocol } : {}),
        ...(active.customMappingFile
          ? { customMappingFile: active.customMappingFile }
          : {}),
      });
      adapter = detected.adapter;
      adapterConfig = detected.config;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : normalizeError(err);
      emit({ type: "error", text: "Provider error [" + pe.type + "]: " + pe.message });
      return;
    }

    // 4. Session log.
    const sessionLog = new SessionLog(projectConfig.paths);
    let historyEntries: Awaited<ReturnType<typeof sessionLog.readTail>> = [];
    try {
      await sessionLog.init();
      historyEntries = await sessionLog.readTail(20);
    } catch { /* non-fatal */ }
    try {
      await sessionLog.append({ kind: "user", text });
    } catch { /* non-fatal */ }

    // 6. Permissions — reload each turn so a mode change (first-run picker
    //    or a manual edit to .agent-runtime/permission.json) is picked up.
    let currentMode: PermissionMode = projectConfig.permission ?? "ask-every-time";
    try {
      const fresh = await loadProjectConfig(cwd);
      currentMode = fresh.permission ?? "ask-every-time";
    } catch { /* use fallback */ }

    const permissions = new PermissionManager({
      mode: currentMode,
      prompt: async (req) => {
        // Show the request in the activity stream, then wait for the user's
        // y/n in the Renderer. In all-allowed mode this is only reached for
        // dangerous terminal commands (PermissionManager handles that).
        emit({
          type: "note",
          text: "permission requested (" + currentMode + "): " + req.summary,
        });
        return await askPermission(req);
      },
    });

    // 6. System prompt — identity + language + tool discipline.
    let systemPrompt =
  "You are agent-cli, a coding assistant CLI running inside the user's terminal. " +
  "If asked who you are or who made you, say only that you are agent-cli. " +
  "Do not name any company, model vendor, or creator — if you do not know, say so.\n" +
  "Reply in the SAME language the user wrote in. " +
  "If the user mixes languages, match the dominant one. " +
  "Do not translate technical terms, code, file paths, or command names.\n\n" +
  "You are a real agent, not a chat window. You have real tools that act on " +
  "the user's filesystem in the current working directory. When the user asks " +
  "you to create, edit, delete, read, or run something, you can and should " +
  "use the tools to do it — do not just describe what should be done. Do not " +
  "ask for confirmation in your reply; the CLI handles permissions itself " +
  "(the user is asked separately when required).\n" +
  "Never claim a file was created, edited, or deleted unless the matching " +
  "tool actually succeeded in this turn. If a tool failed, say so plainly and " +
  "try a different approach or ask the user.\n\n" +
  "You are in control of how to handle each turn. Use the tools as you see fit:\n";
  
  
    try {
      const agents = await loadAgentsMd(cwd);
      if (agents.content.trim().length > 0) systemPrompt += "\n\n" + agents.content;
    } catch { /* ignore */ }
    try {
      const instr = await loadInstructions(homeConfig, projectConfig);
      const block = assembleInstructionBlock(instr);
      if (block.length > 0) systemPrompt += "\n\n" + block;
    } catch { /* ignore */ }
    try {
      const sessionInstr = getSessionInstructions();
      if (sessionInstr.trim().length > 0) {
        systemPrompt +=
          "\n\n--- SESSION INSTRUCTIONS (verbatim, this run only) ---\n" + sessionInstr;
      }
    } catch { /* ignore */ }

    // 7. Build messages.
    const priorMessages: ChatMessage[] = [];
    for (const e of historyEntries) {
      if (e.kind === "user") {
        priorMessages.push({ role: "user", parts: [{ kind: "text", text: e.text }] });
      } else if (e.kind === "assistant") {
        priorMessages.push({ role: "assistant", parts: [{ kind: "text", text: e.text }] });
      }
    }

    const messages: ChatMessage[] = [
      { role: "system", parts: [{ kind: "text", text: systemPrompt }] },
      ...priorMessages,
      { role: "user", parts: [{ kind: "text", text }] },
    ];

    // 8. Planner access — only invoked when the model calls the "plan" tool.
    const planFn: PlanFn = async (systemPrompt, userPrompt) => {
      const req: ChatRequest = {
        model: adapterConfig.model,
        messages: [
          { role: "system", parts: [{ kind: "text", text: systemPrompt }] },
          { role: "user", parts: [{ kind: "text", text: userPrompt }] },
        ],
      };
      let out = "";
      for await (const ev of adapter.streamChat(adapterConfig, req)) {
        if (ev.type === "text-delta") out += ev.text;
        else if (ev.type === "done") break;
      }
      return out;
    };

    // 9. Tool-loop. The model drives every step.
    const tools = buildToolDefinitions();
    const toolCtx: ToolCtx = { cwd, permissions, emit };
    const MAX_ITER = 8;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const req: ChatRequest = {
        model: adapterConfig.model,
        messages,
        tools,
      };

      let assistantText = "";
      const collected: { id: string; name: string; argsJson: string }[] = [];
      const open = new Map<string, { name: string; buf: string }>();

      try {
        for await (const ev of adapter.streamChat(adapterConfig, req)) {
          if (ev.type === "text-delta") {
            assistantText += ev.text;
          } else if (ev.type === "tool-call-start") {
            open.set(ev.id, { name: ev.name, buf: "" });
          } else if (ev.type === "tool-call-delta") {
            const o = open.get(ev.id);
            if (o) o.buf += ev.argumentsDelta;
          } else if (ev.type === "tool-call-end") {
            const o = open.get(ev.id);
            if (o) {
              collected.push({ id: ev.id, name: o.name, argsJson: o.buf });
              open.delete(ev.id);
            }
          } else if (ev.type === "done") {
            break;
          }
        }
      } catch (err) {
        const pe = normalizeError(err);
        emit({ type: "error", text: "Model error [" + pe.type + "]: " + pe.message });
        return;
      }

      if (assistantText.trim().length > 0) {
        emit({ type: "assistant-message", text: assistantText.trim() });
        try { await sessionLog.append({ kind: "assistant", text: assistantText }); } catch { /* non-fatal */ }
      }

      if (collected.length === 0) break; // text-only — done

      messages.push({
        role: "assistant",
        parts: assistantText.length > 0 ? [{ kind: "text", text: assistantText }] : [],
        toolCalls: collected.map((tc) => ({
          id: tc.id,
          name: tc.name,
          argumentsJson: tc.argsJson,
        })),
      });

      for (const tc of collected) {
        // The "plan" tool is special — it does not touch the filesystem.
        // It asks the Planner for phases and steps, and returns them to the
        // model as a normal tool result. The model then executes them.
        if (tc.name === "plan") {
          const a = parseArgs(tc.argsJson) ?? {};
          const taskStr = argStr(a.task) ?? text;
          emit({ type: "tool-call", name: "plan", args: taskStr.slice(0, 200) });
          try {
            const repoMap = await buildRepoMap({ cwd });
            const plan = await buildPlan({ task: taskStr, repoMap, cwd }, planFn);
            const flat = flattenPlan(plan);
            const planText = flat.length === 0
              ? "(planner returned no steps)"
              : flat.map((x) => "[" + x.phase + "] " + x.step.title).join("\n");
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              parts: [{ kind: "text", text: "OK: plan ready\n\n" + planText }],
            });
            try { await sessionLog.append({ kind: "tool-call", id: tc.id, name: "plan", argumentsJson: tc.argsJson }); } catch { /* non-fatal */ }
            try { await sessionLog.append({ kind: "tool-result", id: tc.id, name: "plan", ok: true, summary: "plan ready" }); } catch { /* non-fatal */ }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              parts: [{ kind: "text", text: "ERROR: plan failed: " + msg }],
            });
          }
          continue;
        }

        // All other tools.
        const r = await executeTool(tc.name, tc.argsJson, toolCtx);
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          parts: [{
            kind: "text",
            text: (r.ok ? "OK" : "ERROR") + ": " + r.summary + "\n\n" + r.output,
          }],
        });
        try { await sessionLog.append({ kind: "tool-call", id: tc.id, name: tc.name, argumentsJson: tc.argsJson }); } catch { /* non-fatal */ }
        try { await sessionLog.append({ kind: "tool-result", id: tc.id, name: tc.name, ok: r.ok, summary: r.summary }); } catch { /* non-fatal */ }
      }
    }
    // Loop ends when the model returns text-only, or the iteration cap hits.
  };
}


export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`\nagent-cli: unexpected error\n\n${msg}\n\n`);
    return 1;
  }
}


async function run(argv: string[]): Promise<number> {
  // 1. parse args
  const program = buildProgram();
  try {
    program.parse(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    throw err;
  }

  const opts = program.opts<{ cwd?: string; verbose?: boolean; resume?: boolean }>();

  const args: ParsedArgs = {
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    verbose: opts.verbose === true,
    resume: opts.resume === true,
  };

  // 2. validate cwd
  if (!fs.existsSync(args.cwd) || !fs.statSync(args.cwd).isDirectory()) {
    process.stderr.write(`agent-cli: working directory not found — ${args.cwd}\n`);
    return 1;
  }

  // 3. load config
  let homeConfig: HomeConfig;
  let projectConfig: ProjectConfig;
  try {
    homeConfig = await loadHomeConfig();
    projectConfig = await loadProjectConfig(args.cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`agent-cli: failed to load config\n\n${msg}\n\n`);
    return 1;
  }

  // 4. detect resumable state
  let resumeState: ResumeState | null = null;
  try {
    const resumeManager = new ResumeManager({ homeConfig, projectConfig });
    resumeState = await resumeManager.detectResumableState({
      forceResume: args.resume,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`agent-cli: failed to check resume state\n\n${msg}\n\n`);
    return 1;
  }

  // 5. build the turn runner, then render TUI
  const onUserMessage = buildTurnRunner(homeConfig, projectConfig, args.cwd);

  const app = render(
    React.createElement(Renderer, {
      homeConfig,
      projectConfig,
      cwd: args.cwd,
      resumeState,
      verbose: args.verbose,
      onUserMessage,
    }),
    {
      exitOnCtrlC: true,
      patchConsole: false,
    }
  );

  // 6. wait until TUI exits
  try {
    await app.waitUntilExit();
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`agent-cli: TUI exited unexpectedly\n\n${msg}\n\n`);
    return 1;
  }

  return 0;
}
