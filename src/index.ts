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
import { loadApiKey } from "./commands/apiCommand";
import { detectProtocol } from "./providers/ProtocolDetector";
import type {
  AdapterConfig,
  ChatRequest,
  ProviderAdapter,
} from "./providers/AdapterBase";
import { normalizeError, ProviderError } from "./providers/ErrorClassifier";
import { buildRepoMap } from "./context/RepoMap";
import { TaskGraph } from "./orchestrator/TaskGraph";
import { StateMachine, type ExecutorFn } from "./orchestrator/StateMachine";
import { FailureLedger } from "./recovery/FailureLedger";
import { EscalationLadder } from "./recovery/EscalationLadder";
import { MemoryStore } from "./memory/MemoryStore";
import { SessionLog } from "./session/SessionLog";
import type { ActivityItem } from "./ui/ActivityStream";

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
    // 1. Require an active profile.
    const active = getActiveProfile(homeConfig);
    if (!active) {
      emit({
        type: "note",
        text: "No active API profile. Add one with: /api <baseUrl> <key> <model>",
      });
      return;
    }

    // 2. Load the encrypted key.
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
      emit({
        type: "tool-result",
        name: "handshake",
        ok: true,
        summary: "protocol=" + detected.protocol,
      });
    } catch (err) {
      const pe = err instanceof ProviderError ? err : normalizeError(err);
      emit({
        type: "error",
        text: "Provider error [" + pe.type + "]: " + pe.message,
      });
      return;
    }

    // 4. Supporting infra for the orchestrator.
    const memoryStore = new MemoryStore(projectConfig.paths);
    const sessionLog = new SessionLog(projectConfig.paths);
    try {
      await sessionLog.init();
      await memoryStore.ensureSeeded("decisions");
      await memoryStore.ensureSeeded("plan");
      await memoryStore.ensureSeeded("progress");
    } catch (err) {
      emit({
        type: "error",
        text:
          "Init failed: " + (err instanceof Error ? err.message : String(err)),
      });
      return;
    }

    const repoMap = await buildRepoMap({ cwd });
    const taskGraph = new TaskGraph({ cwd, memoryStore });
    const ledger = new FailureLedger(projectConfig.paths);
    const escalation = new EscalationLadder({ ledger });

    // 5. Planner callback — isolated model call, no streaming.
    const planFn = async (
      systemPrompt: string,
      userPrompt: string
    ): Promise<string> => {
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

    // 6. Executor — one streamed model call per task.
    const executor: ExecutorFn = async (ctx) => {
      const changeHint = ctx.mustChangeApproach
        ? "\n\nIMPORTANT: previous attempts failed. Try a DIFFERENT approach."
        : "";
      const systemPrompt =
        "You are a coding agent working inside the user's project. " +
        "Reply in English only. Be concise. Do not invent file paths." +
        changeHint;
      const userPrompt =
        "Task: " + ctx.task.title + "\n" +
        (ctx.task.files.length > 0
          ? "Files: " + ctx.task.files.join(", ") + "\n"
          : "") +
        "Attempt: " + ctx.attempt + "\n\n" +
        "Describe the concrete change. Keep it short.";

      const req: ChatRequest = {
        model: adapterConfig.model,
        messages: [
          { role: "system", parts: [{ kind: "text", text: systemPrompt }] },
          { role: "user", parts: [{ kind: "text", text: userPrompt }] },
        ],
      };

      emit({
        type: "thinking",
        label: ctx.task.id + " — " + ctx.task.title,
      });

      let accumulated = "";
      let buffer = "";
      const flush = (): void => {
        if (buffer.length === 0) return;
        emit({ type: "note", text: "assistant: " + buffer });
        buffer = "";
      };

      try {
        for await (const ev of adapter.streamChat(adapterConfig, req)) {
          if (ev.type === "text-delta") {
            accumulated += ev.text;
            buffer += ev.text;
            // Flush at a natural boundary or every ~160 chars — live but
            // not one item per token.
            if (buffer.includes("\n") || buffer.length >= 160) flush();
          } else if (ev.type === "tool-call-start") {
            flush();
            emit({ type: "tool-call", name: ev.name });
          } else if (ev.type === "done") {
            break;
          }
        }
        flush();
      } catch (err) {
        const pe = normalizeError(err);
        return {
          ok: false,
          summary: "Model call failed [" + pe.type + "]: " + pe.message,
          output: pe.message,
        };
      }

      return {
        ok: true,
        summary: accumulated.trim().slice(0, 200) || "(no output)",
        output: accumulated,
        approach: "single-shot model call (tools not executed)",
      };
    };

    // 7. Run the orchestrator.
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

    try {
      const result = await sm.run(text, planFn);
      emit({
        type: "note",
        text:
          "run complete: " +
          result.tasksDone + " done, " +
          result.tasksFailed + " failed, " +
          result.tasksBlocked + " blocked (" +
          result.durationMs + "ms)",
      });
    } catch (err) {
      emit({
        type: "error",
        text:
          "Orchestrator failed: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }
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
