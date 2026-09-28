/**
 * src/memory/InstructionLoader.ts
 * -------------------------------
 * Loads and writes the two custom-instruction files:
 *
 *   global:  ~/.agent-cli/instructions.md
 *   project: <cwd>/.agent-runtime/instructions.md
 *
 * Rules (ARCHITECTURE.md §7):
 *   • Both files are sent VERBATIM on every model call.
 *   • They are NEVER summarized, truncated, or compacted.
 *   • If a file is missing, it is created empty on first read.
 *
 * No AI calls. Pure file I/O.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { HomeConfig } from "../config/HomeConfig";
import type { ProjectConfig } from "../config/ProjectConfig";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface InstructionBundle {
  /** Global instructions content (may be empty). */
  readonly global: string;
  /** Project instructions content (may be empty). */
  readonly project: string;
  /** Absolute path to ~/.agent-cli/instructions.md */
  readonly globalPath: string;
  /** Absolute path to <cwd>/.agent-runtime/instructions.md */
  readonly projectPath: string;
  /** Global file mtime as ISO string (empty when missing). */
  readonly globalMtimeIso: string;
  /** Project file mtime as ISO string (empty when missing). */
  readonly projectMtimeIso: string;
}

export class InstructionLoaderError extends Error {
  public readonly code: "io_error";
  constructor(message: string) {
    super(message);
    this.name = "InstructionLoaderError";
    this.code = "io_error";
  }
}


// ------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------

function globalPath(homeConfig: HomeConfig): string {
  return homeConfig.paths.instructionsFile;
}

function projectPath(projectConfig: ProjectConfig): string {
  return projectConfig.paths.instructionsFile;
}


// ------------------------------------------------------------------
// Read
// ------------------------------------------------------------------

async function readOrSeed(absPath: string): Promise<{ content: string; mtimeIso: string }> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    const st = await fs.stat(absPath);
    return { content: raw, mtimeIso: new Date(st.mtimeMs).toISOString() };
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw new InstructionLoaderError(
        "read failed for " + absPath + ": " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // Missing — create empty so future reads are cheap.
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "", "utf8");
    const st = await fs.stat(absPath);
    return { content: "", mtimeIso: new Date(st.mtimeMs).toISOString() };
  } catch (err) {
    throw new InstructionLoaderError(
      "create failed for " + absPath + ": " +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

/**
 * Load both instruction files at once. Never throws for a missing file —
 * a missing file is created empty and returned as "".
 */
export async function loadInstructions(
  homeConfig: HomeConfig,
  projectConfig: ProjectConfig
): Promise<InstructionBundle> {
  const gPath = globalPath(homeConfig);
  const pPath = projectPath(projectConfig);

  const [g, p] = await Promise.all([
    readOrSeed(gPath),
    readOrSeed(pPath),
  ]);

  return {
    global: g.content,
    project: p.content,
    globalPath: gPath,
    projectPath: pPath,
    globalMtimeIso: g.mtimeIso,
    projectMtimeIso: p.mtimeIso,
  };
}

/**
 * Convenience: only the two contents, no paths or mtimes.
 * This is what the instruction assembler uses when building the prompt.
 */
export async function loadInstructionTexts(
  homeConfig: HomeConfig,
  projectConfig: ProjectConfig
): Promise<{ global: string; project: string }> {
  const b = await loadInstructions(homeConfig, projectConfig);
  return { global: b.global, project: b.project };
}


// ------------------------------------------------------------------
// Write
// ------------------------------------------------------------------

async function writeAtomic(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = absPath + ".tmp";
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, absPath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw new InstructionLoaderError(
      "write failed for " + absPath + ": " +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

/** Replace the global instructions file. */
export async function setGlobalInstructions(
  homeConfig: HomeConfig,
  content: string
): Promise<void> {
  await writeAtomic(globalPath(homeConfig), content);
}

/** Replace the project instructions file. */
export async function setProjectInstructions(
  projectConfig: ProjectConfig,
  content: string
): Promise<void> {
  await writeAtomic(projectPath(projectConfig), content);
}


// ------------------------------------------------------------------
// Assembly helper (used by the instruction assembler)
// ------------------------------------------------------------------

/**
 * Concatenate global + project instructions into a single block for the
 * system prompt. Both sections are verbatim. Empty sections are omitted.
 * The heading is included only when that section has content — so a user
 * with no instructions gets an empty string, not a hollow header.
 */
export function assembleInstructionBlock(
  bundle: Pick<InstructionBundle, "global" | "project">
): string {
  const parts: string[] = [];

  const g = bundle.global.trim();
  if (g.length > 0) {
    parts.push("--- GLOBAL CUSTOM INSTRUCTIONS (verbatim) ---");
    parts.push(g);
    parts.push("");
  }

  const p = bundle.project.trim();
  if (p.length > 0) {
    parts.push("--- PROJECT CUSTOM INSTRUCTIONS (verbatim) ---");
    parts.push(p);
    parts.push("");
  }

  return parts.join("\n").trimEnd();
}