/**
 * src/tools/VerifyRunner.ts
 * -------------------------
 * Runs the project's acceptance checks and returns a structured verdict.
 *
 * Philosophy (Core Principle #8): a task is "done" only when a REAL check
 * passes — not when the model claims success.
 *
 * What counts as a check:
 *   • build  — "build" or "compile" script in package.json
 *   • test   — "test" script in package.json
 *   • lint   — "lint" script in package.json
 *
 * Auto-detect:
 *   • If kind is omitted, run build → test → lint in that order, skipping any
 *     that are not defined. The first failure short-circuits the rest.
 *
 * Depends on:
 *   • tools/TerminalExec   — for the actual spawn.
 *   • policy/PermissionManager — for the permission gate (passed in).
 *
 * No caching. No writes.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { PermissionManager } from "../policy/PermissionManager";
import {
  runTerminal,
  type TerminalChunk,
  type TerminalResult,
} from "./TerminalExec";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type VerifyKind = "build" | "test" | "lint";

export interface VerifyRunnerOptions {
  readonly cwd: string;
  /** Which checks to run. Omit to auto-detect (build → test → lint). */
  readonly kinds?: readonly VerifyKind[];
  /** Permission gate — required if terminal commands must be confirmed. */
  readonly permissions?: PermissionManager;
  /** Per-command timeout override (ms). Default: TerminalExec's default. */
  readonly timeoutMs?: number;
  /** Live output callback (forwarded to TerminalExec). */
  readonly onOutput?: (chunk: TerminalChunk & { kind: VerifyKind }) => void;
  /** Force a specific package manager. Default: auto-detect from lockfile. */
  readonly packageManager?: "npm" | "pnpm" | "yarn" | "bun";
}

export interface VerifyCheck {
  readonly kind: VerifyKind;
  /** The exact command string that was run (or "" if skipped). */
  readonly command: string;
  /** True if this check was skipped because no script is defined. */
  readonly skipped: boolean;
  /** English reason (empty unless skipped). */
  readonly skipReason: string;
  /** Present only when skipped === false. */
  readonly result?: TerminalResult;
  /** exitCode === 0 && !timedOut. False when skipped. */
  readonly passed: boolean;
}

export interface VerifyReport {
  readonly checks: readonly VerifyCheck[];
  /** True if every non-skipped check passed AND at least one ran. */
  readonly allPassed: boolean;
  /** True if every check was skipped (nothing to verify). */
  readonly nothingToRun: boolean;
  /** Name of the first failing check, or null. */
  readonly firstFailure: VerifyKind | null;
  readonly totalDurationMs: number;
}

export class VerifyRunnerError extends Error {
  public readonly code: "no_package_json" | "bad_package_json" | "exec_error";
  constructor(code: VerifyRunnerError["code"], message: string) {
    super(message);
    this.name = "VerifyRunnerError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// package.json discovery
// ------------------------------------------------------------------

interface ScriptsMap {
  readonly scripts: Readonly<Record<string, string>>;
  /** Absolute path to the package.json we used. */
  readonly absPath: string;
}

async function readScripts(cwd: string): Promise<ScriptsMap | null> {
  const absPath = path.join(cwd, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VerifyRunnerError("bad_package_json", `invalid JSON in ${absPath}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new VerifyRunnerError("bad_package_json", `package.json is not an object: ${absPath}`);
  }
  const scriptsRaw = (parsed as { scripts?: unknown }).scripts;
  const scripts: Record<string, string> = {};
  if (scriptsRaw && typeof scriptsRaw === "object") {
    for (const [k, v] of Object.entries(scriptsRaw as Record<string, unknown>)) {
      if (typeof v === "string") scripts[k] = v;
    }
  }
  return { scripts, absPath };
}


// ------------------------------------------------------------------
// Package manager detection
// ------------------------------------------------------------------

async function detectPackageManager(
  cwd: string
): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  const has = async (f: string): Promise<boolean> => {
    try { await fs.access(path.join(cwd, f)); return true; } catch { return false; }
  };
  if (await has("bun.lockb")) return "bun";
  if (await has("pnpm-lock.yaml")) return "pnpm";
  if (await has("yarn.lock")) return "yarn";
  return "npm";
}


// ------------------------------------------------------------------
// Script → command
// ------------------------------------------------------------------

const SCRIPT_KEYS: Readonly<Record<VerifyKind, readonly string[]>> = {
  build: ["build", "compile"],
  test: ["test"],
  lint: ["lint"],
};

function pickScript(scripts: Readonly<Record<string, string>>, kind: VerifyKind): string | null {
  for (const key of SCRIPT_KEYS[kind]) {
    if (typeof scripts[key] === "string" && scripts[key].trim().length > 0) {
      return key;
    }
  }
  return null;
}

function buildCommand(
  pm: "npm" | "pnpm" | "yarn" | "bun",
  scriptKey: string
): string {
  // npm/pnpm/yarn support `run <script>`; bun uses `run <script>` too.
  // `npm test` is special-cased but `npm run test` also works.
  return `${pm} run ${scriptKey}`;
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Run the requested (or auto-detected) acceptance checks.
 * Never throws on a failing check — that's a `passed: false` in the report.
 * Throws VerifyRunnerError only on setup problems (missing/bad package.json,
 * or a TerminalExecError caused by denied permission).
 */
export async function runVerification(
  opts: VerifyRunnerOptions
): Promise<VerifyReport> {
  const cwd = path.resolve(opts.cwd);

  const scriptsInfo = await readScripts(cwd);
  if (!scriptsInfo) {
    // No package.json → nothing to verify. Report it, don't throw.
    return {
      checks: [],
      allPassed: false,
      nothingToRun: true,
      firstFailure: null,
      totalDurationMs: 0,
    };
  }

  const pm = opts.packageManager ?? (await detectPackageManager(cwd));
  const kinds: readonly VerifyKind[] = opts.kinds ?? ["build", "test", "lint"];

  const checks: VerifyCheck[] = [];
  const startedAt = Date.now();
  let firstFailure: VerifyKind | null = null;

  for (const kind of kinds) {
    const scriptKey = pickScript(scriptsInfo.scripts, kind);

    if (!scriptKey) {
      checks.push({
        kind,
        command: "",
        skipped: true,
        skipReason: `no "${SCRIPT_KEYS[kind].join('" / "')}" script in package.json`,
        passed: false,
      });
      continue;
    }

    const command = buildCommand(pm, scriptKey);

    let result: TerminalResult;
    try {
      result = await runTerminal({
        cwd,
        command,
        permissions: opts.permissions,
        timeoutMs: opts.timeoutMs,
        onOutput: opts.onOutput
          ? (chunk) => opts.onOutput!({ ...chunk, kind })
          : undefined,
      });
    } catch (err) {
      // TerminalExecError("denied") should propagate — user said no.
      const code = (err as { code?: string }).code;
      if (code === "denied") throw err;
      throw new VerifyRunnerError(
        "exec_error",
        err instanceof Error ? err.message : String(err)
      );
    }

    const passed = result.exitCode === 0 && !result.timedOut;
    checks.push({
      kind,
      command,
      skipped: false,
      skipReason: "",
      result,
      passed,
    });

    if (!passed) {
      firstFailure = kind;
      break; // short-circuit — no point running the rest
    }
  }

  const ran = checks.filter((c) => !c.skipped);
  const allPassed = ran.length > 0 && ran.every((c) => c.passed);

  return {
    checks,
    allPassed,
    nothingToRun: ran.length === 0,
    firstFailure,
    totalDurationMs: Date.now() - startedAt,
  };
}


/**
 * Convenience: run everything (build → test → lint) and return only the verdict.
 */
export async function verifyProject(opts: VerifyRunnerOptions): Promise<boolean> {
  const report = await runVerification(opts);
  return report.allPassed;
}