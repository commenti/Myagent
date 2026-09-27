/**
 * src/tools/TerminalExec.ts
 * -------------------------
 * Runs a shell command with the working directory as its jail.
 *
 * Rules:
 *   • PermissionManager.checkTerminal() is consulted FIRST. Deny → no spawn.
 *   • cwd is the jail. Commands that try to escape are the user's problem —
 *     PathGuard protects file tools, not arbitrary shell. That is why the
 *     danger list + permission prompt exist.
 *   • Hard timeout (default 120s). On timeout, the whole process group is killed.
 *   • Output is streamed line-by-line via onOutput, and also captured in full
 *     (up to a byte cap) for the caller.
 *   • Never throws on non-zero exit — the caller decides what a failure means.
 *
 * No caching. No writes of its own.
 */

import { spawn, type ChildProcess } from "child_process";
import * as os from "os";

import type { PermissionManager } from "../policy/PermissionManager";
import { classifyCommand, type DangerVerdict } from "../policy/DangerousCommandList";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB per stream


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface TerminalExecOptions {
  /** Working directory (the jail). */
  readonly cwd: string;
  /** Shell command string (e.g. "npm test"). */
  readonly command: string;
  /** Optional PermissionManager — if omitted, no prompt is made. */
  readonly permissions?: PermissionManager;
  /** Hard timeout in ms. Default 120000. */
  readonly timeoutMs?: number;
  /** Cap on captured bytes per stream (stdout/stderr). Default 512 KB. */
  readonly maxOutputBytes?: number;
  /** Called for each chunk of stdout/stderr as it arrives. */
  readonly onOutput?: (chunk: TerminalChunk) => void;
  /** Extra env vars merged over process.env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Extra arguments passed to `sh -c` (rarely needed). */
  readonly shellArgs?: readonly string[];
}

export interface TerminalChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface TerminalResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  /** Signal name if the process was killed (e.g. "SIGTERM", "SIGKILL"). */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True if the process hit the timeout and was killed. */
  readonly timedOut: boolean;
  /** True if output was cut by the byte cap. */
  readonly truncated: boolean;
  readonly durationMs: number;
  /** Danger classification of the command (for logging). */
  readonly danger: DangerVerdict;
}

export class TerminalExecError extends Error {
  public readonly code: "denied" | "spawn_failed";
  constructor(code: TerminalExecError["code"], message: string) {
    super(message);
    this.name = "TerminalExecError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function pickShell(): { bin: string; args: string[] } {
  if (os.platform() === "win32") {
    return { bin: "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  // POSIX: sh is present on Termux, macOS, Linux, BSD.
  return { bin: "sh", args: ["-c"] };
}

function mergeEnv(
  extra?: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  if (!extra) return process.env;
  return { ...process.env, ...extra };
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Run a shell command. Never throws for non-zero exit.
 * Throws TerminalExecError only for denied permission or spawn failure.
 */
export async function runTerminal(
  opts: TerminalExecOptions
): Promise<TerminalResult> {
  const danger = classifyCommand(opts.command);

  // 1. Permission check first.
  if (opts.permissions) {
    const decision = await opts.permissions.checkTerminal(opts.command);
    if (decision !== "allow") {
      throw new TerminalExecError(
        "denied",
        `permission denied for command: ${opts.command}`
      );
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const shell = pickShell();
  const args = [...shell.args, opts.command, ...(opts.shellArgs ?? [])];

  const started = Date.now();

  let child: ChildProcess;
  try {
    child = spawn(shell.bin, args, {
      cwd: opts.cwd,
      env: mergeEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
      // detached so we can kill the whole group on timeout (POSIX only)
      detached: os.platform() !== "win32",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TerminalExecError("spawn_failed", `failed to spawn shell: ${msg}`);
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;

  const append = (
    target: "stdout" | "stderr",
    text: string
  ): void => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (target === "stdout") {
      if (stdoutBytes < maxBytes) {
        const room = maxBytes - stdoutBytes;
        if (bytes <= room) {
          stdoutChunks.push(text);
          stdoutBytes += bytes;
        } else {
          const slice = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
          stdoutChunks.push(slice);
          stdoutBytes = maxBytes;
          truncated = true;
        }
      } else {
        truncated = true;
      }
    } else {
      if (stderrBytes < maxBytes) {
        const room = maxBytes - stderrBytes;
        if (bytes <= room) {
          stderrChunks.push(text);
          stderrBytes += bytes;
        } else {
          const slice = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
          stderrChunks.push(slice);
          stderrBytes = maxBytes;
          truncated = true;
        }
      } else {
        truncated = true;
      }
    }
    if (opts.onOutput) {
      try { opts.onOutput({ stream: target, text }); } catch { /* ignore */ }
    }
  };

  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => append("stdout", d));
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => append("stderr", d));
  }

  // 2. Timeout — kill the whole process group on POSIX, else just the child.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (os.platform() !== "win32" && typeof child.pid === "number") {
        // negative pid = process group
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  // 3. Wait for exit.
  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", () => {
        // spawn errors after start — resolve with null
        resolve({ code: null, signal: null });
      });
      child.on("close", (code, signal) => {
        resolve({ code, signal });
      });
    }
  );

  clearTimeout(timer);
  const durationMs = Date.now() - started;

  return {
    command: opts.command,
    cwd: opts.cwd,
    exitCode: exitInfo.code,
    signal: exitInfo.signal,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    timedOut,
    truncated,
    durationMs,
    danger,
  };
}