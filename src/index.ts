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

  // 5. render TUI
  const app = render(
    React.createElement(Renderer, {
      homeConfig,
      projectConfig,
      cwd: args.cwd,
      resumeState,
      verbose: args.verbose,
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
