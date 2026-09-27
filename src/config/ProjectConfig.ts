/**
 * src/config/ProjectConfig.ts
 * ---------------------------
 * Reads/writes the per-project runtime folder: <cwd>/.agent-runtime/
 *
 * Responsibilities:
 *   • Validate cwd.
 *   • Auto-create .agent-runtime/ structure on first use.
 *   • Report the permission mode (or null = first run, must ask user).
 *   • Expose every runtime path so other modules don't build paths by hand.
 *
 * Does NOT read/write DECISIONS.md contents — that is MemoryStore's job.
 * Does NOT handle AGENTS.md in project root — that is AgentsMdLoader's job.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";


// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const RUNTIME_DIR_NAME = ".agent-runtime";

const PERMISSION_ALLOWED = "all-allowed";
const PERMISSION_ASK = "ask-every-time";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type PermissionMode = "all-allowed" | "ask-every-time";

export interface ProjectPaths {
  readonly runtimeDir: string;
  readonly instructionsFile: string;
  readonly decisionsFile: string;
  readonly planFile: string;
  readonly progressFile: string;
  readonly permissionFile: string;
  readonly skillsDir: string;
  readonly sessionsDir: string;
  readonly currentSessionFile: string;
  readonly archiveDir: string;
  readonly archiveIndexFile: string;
}

export interface ProjectConfig {
  readonly cwd: string;
  readonly paths: ProjectPaths;
  /** null on first run — caller must ask the user, then call setPermission(). */
  readonly permission: PermissionMode | null;
  readonly isFirstRun: boolean;
}


// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function buildPaths(cwd: string): ProjectPaths {
  const runtimeDir = path.join(cwd, RUNTIME_DIR_NAME);
  const sessionsDir = path.join(runtimeDir, "sessions");
  return {
    runtimeDir,
    instructionsFile: path.join(runtimeDir, "instructions.md"),
    decisionsFile: path.join(runtimeDir, "DECISIONS.md"),
    planFile: path.join(runtimeDir, "PLAN.md"),
    progressFile: path.join(runtimeDir, "PROGRESS.md"),
    permissionFile: path.join(runtimeDir, "permission.json"),
    skillsDir: path.join(runtimeDir, "skills"),
    sessionsDir,
    currentSessionFile: path.join(sessionsDir, "current.jsonl"),
    archiveDir: path.join(sessionsDir, "archive"),
    archiveIndexFile: path.join(sessionsDir, "archive_index.json"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

const DEFAULT_INSTRUCTIONS_MD = "";
const DEFAULT_DECISIONS_MD =
  "# DECISIONS\n\n" +
  "<!-- Decisions made during this project, with reasons. Managed by agent-cli. -->\n";
const DEFAULT_PLAN_MD =
  "# PLAN\n\n" +
  "<!-- Current task breakdown. Managed by agent-cli. -->\n";
const DEFAULT_PROGRESS_MD =
  "# PROGRESS\n\n" +
  "<!-- Completed / pending tasks. Managed by agent-cli. -->\n";

async function ensureRuntimeStructure(paths: ProjectPaths): Promise<void> {
  await fs.mkdir(paths.runtimeDir, { recursive: true });
  await fs.mkdir(paths.skillsDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(paths.archiveDir, { recursive: true });

  await writeFileIfMissing(paths.instructionsFile, DEFAULT_INSTRUCTIONS_MD);
  await writeFileIfMissing(paths.decisionsFile, DEFAULT_DECISIONS_MD);
  await writeFileIfMissing(paths.planFile, DEFAULT_PLAN_MD);
  await writeFileIfMissing(paths.progressFile, DEFAULT_PROGRESS_MD);
  await writeFileIfMissing(paths.archiveIndexFile, "[]\n");
  await writeFileIfMissing(paths.currentSessionFile, "");
  // permission.json is intentionally NOT created — its absence = first run.
}


// ------------------------------------------------------------------
// Permission file I/O
// ------------------------------------------------------------------

interface PermissionFileShape {
  readonly mode: PermissionMode;
  readonly setAt: string;
}

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === PERMISSION_ALLOWED || v === PERMISSION_ASK;
}

async function readPermission(paths: ProjectPaths): Promise<PermissionMode | null> {
  if (!(await pathExists(paths.permissionFile))) return null;
  try {
    const raw = await fs.readFile(paths.permissionFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PermissionFileShape>;
    return isPermissionMode(parsed.mode) ? parsed.mode : null;
  } catch {
    // Corrupt file → treat as first run; caller will rewrite.
    return null;
  }
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load (and if needed, create) the project config for the given working directory.
 * Throws if cwd does not exist or is not a directory.
 */
export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const resolved = path.resolve(cwd);

  // Validate cwd — sync check is fine and gives a fast, clear error.
  let stat: import("fs").Stats;
  try {
    stat = fsSync.statSync(resolved);
  } catch {
    throw new Error(`ProjectConfig: working directory not found — ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`ProjectConfig: path is not a directory — ${resolved}`);
  }

  const paths = buildPaths(resolved);
  const existedBefore = await pathExists(paths.runtimeDir);

  await ensureRuntimeStructure(paths);

  const permission = await readPermission(paths);
  const isFirstRun = permission === null;

  return {
    cwd: resolved,
    paths,
    permission,
    isFirstRun,
    // Note: `existedBefore` isn't exposed — isFirstRun is defined by absence of
    // permission.json, not by absence of the runtime folder. This is intentional:
    // deleting permission.json is a supported way to re-trigger the prompt.
    ...(existedBefore ? {} : {}),
  };
}

/**
 * Persist the user's permission choice. Call this after asking on first run,
 * or whenever the user changes it via a future command.
 */
export async function setPermission(
  cwd: string,
  mode: PermissionMode
): Promise<void> {
  const resolved = path.resolve(cwd);
  const paths = buildPaths(resolved);

  await fs.mkdir(paths.runtimeDir, { recursive: true });

  const payload: PermissionFileShape = {
    mode,
    setAt: new Date().toISOString(),
  };

  // Atomic-ish write: temp file in same dir, then rename.
  const tmp = paths.permissionFile + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await fs.rename(tmp, paths.permissionFile);
}