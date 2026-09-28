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
import { loadProjectConfig, type ProjectConfig } from "./config/ProjectConfig";
import { ResumeManager, type ResumeState } from "./session/ResumeManager";
import { getActiveProfile } from "./config/HomeConfig";
import { SessionLog } from "./session/SessionLog";
import { PermissionManager } from "./policy/PermissionManager";
import { MemoryStore } from "./memory/MemoryStore";
import { loadAgentsMd } from "./memory/AgentsMdLoader";
import { loadInstructions, assembleInstructionBlock } from "./memory/InstructionLoader";
import { getSessionInstructions } from "./memory/SessionInstructions";
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
import { readFile } from "./tools/FileRead";
import { patchFile } from "./tools/FilePatchEdit";
import { createFile } from "./tools/FileCreate";
import { deleteFile } from "./tools/FileDelete";
import { grep } from "./tools/GrepSymbolSearch";
import { runTerminal } from "./tools/TerminalExec";
import { buildRepoMap } from "./context/RepoMap";
import { TaskGraph } from "./orchestrator/TaskGraph";
import { StateMachine, type ExecutorFn } from "./orchestrator/StateMachine";
import { FailureLedger } from "./recovery/FailureLedger";
import { EscalationLadder } from "./recovery/EscalationLadder";
import type { ActivityItem } from "./ui/ActivityStream";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


// ------------------------------------------------------------------
// Version
// ------------------------------------------------------------------

function readVersion(): string {
  try {
    const pkgPath = path.join(
      __dirname,
      "..",
      "package.json"
    );

    const raw = fs.readFileSync(
      pkgPath,
      "utf8"
    );

    const parsed = JSON.parse(raw) as {
      version?: string;
    };

    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}


// ------------------------------------------------------------------
// CLI args
// ------------------------------------------------------------------

interface ParsedArgs {
  readonly cwd: string;
  readonly verbose: boolean;
  readonly resume: boolean;
}


// ------------------------------------------------------------------
// Commander program
// ------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();

  program
    .name("agent-cli")
    .description(
      "Custom AI Coding Agent CLI — provider-agnostic, verification-first."
    )
    .version(
      readVersion(),
      "-v, --version",
      "print version and exit"
    )
    .option(
      "-C, --cwd <dir>",
      "working directory (default: current shell cwd)"
    )
    .option(
      "--verbose",
      "show more detail in the TUI",
      false
    )
    .option(
      "--resume",
      "force-resume the previous unfinished session",
      false
    )
    .allowExcessArguments(false)
    .allowUnknownOption(false)
    .showHelpAfterError(true)
    .exitOverride();

  return program;
}


// ------------------------------------------------------------------
// Tool definitions sent to the model
// ------------------------------------------------------------------

function buildToolDefinitions(): ToolSchema[] {
  return [
    { name: "read_file",   description: "Read a file from the working directory.",
      parameters: { type: "object", properties: {
        path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" },
      }, required: ["path"] } },
    { name: "patch_edit",  description: "Replace an exact substring in a file.",
      parameters: { type: "object", properties: {
        path: { type: "string" }, oldStr: { type: "string" }, newStr: { type: "string" },
      }, required: ["path", "oldStr", "newStr"] } },
    { name: "create_file", description: "Create a new file.",
      parameters: { type: "object", properties: {
        path: { type: "string" }, content: { type: "string" },
      }, required: ["path", "content"] } },
    { name: "delete_file", description: "Delete a file inside the working directory.",
      parameters: { type: "object", properties: { path: { type: "string" } },
        required: ["path"] } },
    { name: "grep",        description: "Search text or regex across files.",
      parameters: { type: "object", properties: {
        pattern: { type: "string" }, regex: { type: "boolean" },
        extensions: { type: "array", items: { type: "string" } },
      }, required: ["pattern"] } },
    { name: "run_terminal", description: "Run a shell command in the working directory.",
      parameters: { type: "object", properties: { command: { type: "string" } },
        required: ["command"] } },
  ];
}


// ------------------------------------------------------------------
// Tool execution
// ------------------------------------------------------------------

interface ToolExecCtx {
  readonly cwd: string;
  readonly permissions: PermissionManager | undefined;
  readonly emit: (item: ActivityItem) => void;
}

interface ToolExecResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly output: string;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch { return null; }
}

function str(v: unknown): string | null { return typeof v === "string" ? v : null; }

async function executeTool(
  name: string, argsJson: string, ctx: ToolExecCtx
): Promise<ToolExecResult> {
  const a = parseArgs(argsJson);
  if (!a) return { ok: false, summary: "invalid JSON args for " + name, output: "" };

  try {
    switch (name) {
      case "read_file": {
        const p = str(a.path);
        if (!p) return { ok: false, summary: "read_file: missing path", output: "" };
        ctx.emit({ type: "tool-call", name: "read", args: p });
        const r = await readFile({ cwd: ctx.cwd, filePath: p });
        ctx.emit({ type: "file-read", path: r.relPath, lines: r.totalLines });
        return { ok: true, summary: r.relPath + " (" + r.totalLines + " lines)", output: r.content };
      }
      case "patch_edit": {
        const p = str(a.path), o = str(a.oldStr), n = str(a.newStr);
        if (!p || o === null || n === null)
          return { ok: false, summary: "patch_edit: missing fields", output: "" };
        ctx.emit({ type: "tool-call", name: "edit", args: p });
        const r = await patchFile({ cwd: ctx.cwd, filePath: p, oldStr: o, newStr: n });
        ctx.emit({ type: "file-edit", path: r.relPath, preview: r.preview, added: 0, removed: 0 });
        return { ok: true, summary: "patched " + r.relPath, output: "OK" };
      }
      case "create_file": {
        const p = str(a.path);
        if (!p) return { ok: false, summary: "create_file: missing path", output: "" };
        ctx.emit({ type: "tool-call", name: "create", args: p });
        const r = await createFile({
          cwd: ctx.cwd, filePath: p, content: str(a.content) ?? "",
          ...(ctx.permissions ? { permissions: ctx.permissions } : {}),
        });
        return { ok: true, summary: "created " + r.relPath, output: "OK" };
      }
      case "delete_file": {
        const p = str(a.path);
        if (!p) return { ok: false, summary: "delete_file: missing path", output: "" };
        ctx.emit({ type: "tool-call", name: "delete", args: p });
        const r = await deleteFile({
          cwd: ctx.cwd, filePath: p,
          ...(ctx.permissions ? { permissions: ctx.permissions } : {}),
        });
        return { ok: true, summary: "deleted " + r.relPath, output: "OK" };
      }
      case "grep": {
        const pat = str(a.pattern);
        if (!pat) return { ok: false, summary: "grep: missing pattern", output: "" };
        ctx.emit({ type: "tool-call", name: "grep", args: pat });
        const r = await grep({ cwd: ctx.cwd, pattern: pat, regex: a.regex === true });
        const body = r.matches.slice(0, 30)
          .map((m) => m.relPath + ":" + m.line + ": " + m.text).join("\n");
        return {
          ok: true,
          summary: r.matches.length + " match(es) in " + r.filesWithMatches + " file(s)",
          output: body || "(no matches)",
        };
      }
      case "run_terminal": {
        const cmd = str(a.command);
        if (!cmd) return { ok: false, summary: "run_terminal: missing command", output: "" };
        ctx.emit({ type: "tool-call", name: "run", args: cmd });
        const r = await runTerminal({
          cwd: ctx.cwd, command: cmd,
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
      default:
        return { ok: false, summary: "unknown tool: " + name, output: "" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: name + " failed: " + msg, output: msg };
  }
}

// ------------------------------------------------------------------
// Turn runner
// ------------------------------------------------------------------

type TurnRunner = (
  text: string,
  emit: (item: ActivityItem) => void
) => Promise<void>;

function buildTurnRunner(
  _homeConfig: HomeConfig,
  projectConfig: ProjectConfig,
  cwd: string
): TurnRunner {
  return async (text, emit) => {
    // 1. Reload home config (a /api-added profile must be visible).
    let liveHome: HomeConfig;
    try {
      liveHome = await loadHomeConfig();
    } catch (err) {
      emit({ type: "error", text: "Cannot read home config: " + (err instanceof Error ? err.message : String(err)) });
      return;
    }

    // 2. Require an active profile.
    const active = getActiveProfile(liveHome);
    if (!active) {
      emit({ type: "note", text: "No active API profile. Add one with /api (opens a form)." });
      return;
    }

    // 3. Load key.
    let apiKey: string;
    try {
      apiKey = await loadApiKey(liveHome.paths, active.keyRef);
    } catch (err) {
      emit({ type: "error", text: "Cannot read API key for '" + active.id + "': " + (err instanceof Error ? err.message : String(err)) });
      return;
    }

    // 4. Detect protocol → adapter + config.
    emit({ type: "thinking", label: "connecting to " + active.id });
    let adapter: ProviderAdapter;
    let adapterConfig: AdapterConfig;
    try {
      const detected = await detectProtocol({
        baseUrl: active.baseUrl,
        apiKey,
        model: active.model,
        ...(active.protocol ? { protocol: active.protocol } : {}),
        ...(active.customMappingFile ? { customMappingFile: active.customMappingFile } : {}),
      });
      adapter = detected.adapter;
      adapterConfig = detected.config;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : normalizeError(err);
      emit({ type: "error", text: "Provider error [" + pe.type + "]: " + pe.message });
      return;
    }

    // 5. Session log + memory.
    const sessionLog = new SessionLog(projectConfig.paths);
    const memoryStore = new MemoryStore(projectConfig.paths);
    try {
      await sessionLog.init();
      await sessionLog.append({ kind: "user", text });
    } catch { /* non-fatal */ }

    // 6. Permissions.
    const mode = projectConfig.permission ?? "ask-every-time";
    const permissions = new PermissionManager({
      mode,
      prompt: async (req) => {
        const allow = mode === "all-allowed";
        emit({ type: "note", text: "permission (" + mode + "): " + req.summary + " → " + (allow ? "allow" : "deny") });
        return allow;
      },
    });

    // 7. System prompt: identity + AGENTS.md + instructions (verbatim).
    let systemPrompt =
      "You are agent-cli, a coding agent inside the user's project. " +
      "Reply in English only. Use the provided tools to inspect and change files. " +
      "Do not claim a change was made without using a tool.";
    try {
      const agents = await loadAgentsMd(cwd);
      if (agents.content.trim().length > 0) systemPrompt += "\n\n" + agents.content;
    } catch { /* ignore */ }
    try {
      const instr = await loadInstructions(liveHome, projectConfig);
      const block = assembleInstructionBlock(instr);
      if (block.length > 0) systemPrompt += "\n\n" + block;
    } catch { /* ignore */ }
    try {
      const sessionInstr = getSessionInstructions();
      if (sessionInstr.trim().length > 0) {
        systemPrompt +=
          "\n\n--- SESSION INSTRUCTIONS (verbatim, this run only) ---\n" +
          sessionInstr;
      }
    } catch { /* ignore */ }

    // 8. Executor — runs the tool loop for the single task.
    const tools = buildToolDefinitions();
    const toolsCtx: ToolExecCtx = { cwd, permissions, emit };

    const executor: ExecutorFn = async (ctx) => {
      const messages: ChatMessage[] = [
        { role: "system", parts: [{ kind: "text", text: systemPrompt }] },
        { role: "user", parts: [{ kind: "text", text: ctx.task.title }] },
      ];

      const MAX_ITER = 8;
      let lastAssistantText = "";
      let toolsRan = 0;

      for (let i = 0; i < MAX_ITER; i++) {
        const req: ChatRequest = {
          model: adapterConfig.model,
          messages,
          tools,
          ...(active.effort ? { effort: active.effort } : {}),
        };

        let assistantText = "";
        const collected: { id: string; name: string; argsJson: string }[] = [];
        const open = new Map<string, { name: string; buf: string }>();

        try {
          for await (const ev of adapter.streamChat(adapterConfig, req)) {
            if (ev.type === "text-delta") assistantText += ev.text;
            else if (ev.type === "tool-call-start") open.set(ev.id, { name: ev.name, buf: "" });
            else if (ev.type === "tool-call-delta") {
              const o = open.get(ev.id);
              if (o) o.buf += ev.argumentsDelta;
            } else if (ev.type === "tool-call-end") {
              const o = open.get(ev.id);
              if (o) { collected.push({ id: ev.id, name: o.name, argsJson: o.buf }); open.delete(ev.id); }
            } else if (ev.type === "done") break;
          }
        } catch (err) {
          const pe = normalizeError(err);
          return { ok: false, summary: "Model error [" + pe.type + "]: " + pe.message, output: pe.message };
        }

        if (assistantText.trim().length > 0) {
          emit({ type: "note", text: "assistant: " + assistantText.trim().slice(0, 4000) });
          lastAssistantText = assistantText;
        }

        if (collected.length === 0) break; // chat answer — done

        messages.push({
          role: "assistant",
          parts: assistantText.length > 0 ? [{ kind: "text", text: assistantText }] : [],
          toolCalls: collected.map((tc) => ({ id: tc.id, name: tc.name, argumentsJson: tc.argsJson })),
        });

        for (const tc of collected) {
          const r = await executeTool(tc.name, tc.argsJson, toolsCtx);
          toolsRan++;
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            parts: [{ kind: "text", text: (r.ok ? "OK" : "ERROR") + ": " + r.summary + "\n\n" + r.output }],
          });
        }
      }

      return {
        ok: true,
        summary: lastAssistantText.trim().slice(0, 200) || "(no text)",
        output: lastAssistantText,
        approach: toolsRan + " tool(s) executed",
      };
    };

    // 9. Repo map + graph with ONE pre-loaded task (skip Planner for chat).
    const repoMap = await buildRepoMap({ cwd });
    const taskGraph = new TaskGraph({ cwd, memoryStore });
    taskGraph.addTask({ title: text.slice(0, 200), files: [], phase: "chat" });

    const ledger = new FailureLedger(projectConfig.paths);
    const escalation = new EscalationLadder({ ledger });

    const sm = new StateMachine({
      cwd,
      repoMap,
      taskGraph,
      sessionLog,
      memoryStore,
      escalation,
      subAgent: { adapter, adapterConfig },
      executor,
    });

    // planFn is never called (task graph is pre-loaded).
    const planFn = async (_s: string, _u: string): Promise<string> => "";

    // 10. Run the loop.
    try {
      const result = await sm.run(text, planFn);
      if (result.tasksDone > 0) {
        emit({ type: "tool-result", name: "turn", ok: true, summary: "done (" + result.durationMs + "ms)" });
      } else if (result.tasksBlocked > 0) {
        emit({ type: "note", text: "task blocked — see above." });
      } else {
        emit({ type: "note", text: "run finished without task completion." });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "error", text: "Orchestrator failed: " + msg });
    }
  };
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

export async function main(
  argv: string[]
): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.stack ?? err.message
        : String(err);

    process.stderr.write(
      `\nagent-cli: unexpected error\n\n${msg}\n\n`
    );

    return 1;
  }
}


// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------

async function run(
  argv: string[]
): Promise<number> {
  // 1. parse args
  const program =
    buildProgram();

  try {
    program.parse(
      argv,
      {
        from: "user",
      }
    );
  } catch (err) {
    if (
      err instanceof CommanderError
    ) {
      return err.exitCode;
    }

    throw err;
  }

  const opts =
    program.opts<{
      cwd?: string;
      verbose?: boolean;
      resume?: boolean;
    }>();

  const args: ParsedArgs = {
    cwd:
      opts.cwd
        ? path.resolve(opts.cwd)
        : process.cwd(),
    verbose:
      opts.verbose === true,
    resume:
      opts.resume === true,
  };

  // 2. validate cwd
  if (
    !fs.existsSync(args.cwd) ||
    !fs.statSync(args.cwd).isDirectory()
  ) {
    process.stderr.write(
      `agent-cli: working directory not found — ${args.cwd}\n`
    );

    return 1;
  }

  // 3. load config
  let homeConfig: HomeConfig;
  let projectConfig: ProjectConfig;

  try {
    homeConfig =
      await loadHomeConfig();

    projectConfig =
      await loadProjectConfig(
        args.cwd
      );
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.stack ?? err.message
        : String(err);

    process.stderr.write(
      `agent-cli: failed to load config\n\n${msg}\n\n`
    );

    return 1;
  }

  // 4. detect resumable state
  let resumeState:
    ResumeState | null = null;

  try {
    const resumeManager =
      new ResumeManager({
        homeConfig,
        projectConfig,
      });

    resumeState =
      await resumeManager.detectResumableState(
        {
          forceResume: args.resume,
        }
      );
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.stack ?? err.message
        : String(err);

    process.stderr.write(
      `agent-cli: failed to check resume state\n\n${msg}\n\n`
    );

    return 1;
  }

  // 5. build the turn runner, then render TUI
  const onUserMessage = buildTurnRunner(homeConfig, projectConfig, args.cwd);

  const app =
    render(
      React.createElement(
        Renderer,
        {
          homeConfig,
          projectConfig,
          cwd: args.cwd,
          resumeState,
          verbose: args.verbose,
          onUserMessage,
        }
      ),
      {
        exitOnCtrlC: true,
        patchConsole: false,
      }
    );

  // 6. wait until TUI exits
  try {
    await app.waitUntilExit();
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.stack ?? err.message
        : String(err);

    process.stderr.write(
      `agent-cli: TUI exited unexpectedly\n\n${msg}\n\n`
    );

    return 1;
  }

  return 0;
}