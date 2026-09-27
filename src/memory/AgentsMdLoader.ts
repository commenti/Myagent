/**
 * src/memory/AgentsMdLoader.ts
 * ----------------------------
 * Loads the project's AGENTS.md.
 *
 * Per ARCHITECTURE.md:
 *   §5  — AGENTS.md lives in the PROJECT ROOT (not .agent-runtime/).
 *   §7  — AGENTS.md is ALWAYS loaded, and its content is sent VERBATIM.
 *         Never summarized, never truncated.
 *
 * Behaviour:
 *   • If <cwd>/AGENTS.md exists → return it as-is.
 *   • If missing → copy templates/AGENTS.default.md into place, then return it.
 *   • If the template is also missing → return a minimal built-in fallback.
 *
 * No AI calls. No summarization. Pure file I/O.
 */

import * as fs from "fs/promises";
import * as path from "path";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface AgentsMdResult {
  /** Absolute path to the AGENTS.md that was loaded. */
  readonly absPath: string;
  /** Path relative to cwd (for display). */
  readonly relPath: string;
  /** Verbatim content — never compacted. */
  readonly content: string;
  /** True if the file was just created from the template this call. */
  readonly created: boolean;
  /** True if the built-in fallback was used (template missing). */
  readonly usedFallback: boolean;
  /** File mtime as ISO string. */
  readonly mtimeIso: string;
}


export class AgentsMdLoaderError extends Error {
  public readonly code: "io_error" | "blocked";
  constructor(code: AgentsMdLoaderError["code"], message: string) {
    super(message);
    this.name = "AgentsMdLoaderError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Fallback content (English only)
// ------------------------------------------------------------------

const FALLBACK_AGENTS_MD = `# AGENTS.md

<!-- This file was auto-created by agent-cli because no template was found. -->
<!-- Edit freely — it is loaded verbatim on every run. -->

## Project identity

Describe what this project is, in a few lines.

## Rules

- Follow the existing code style.
- Never rewrite a whole file; use patch edits.
- Always run the project's checks after a change.
- Ask before destructive commands.
`;


// ------------------------------------------------------------------
// Template location
// ------------------------------------------------------------------

/**
 * Find templates/AGENTS.default.md.
 * Looks next to the running package (dist/../templates) first, then
 * walks up a couple of levels so dev mode (src/…​) also works.
 */
async function findTemplate(cwd: string): Promise<string | null> {
  const candidates = [
    // When running from dist/:   <pkg>/dist/../templates/…
    path.resolve(__dirname, "..", "templates", "AGENTS.default.md"),
    // When running via tsx from src/:  <pkg>/src/memory/../../templates/…
    path.resolve(__dirname, "..", "..", "templates", "AGENTS.default.md"),
    // Sibling to cwd (rare, but harmless).
    path.join(cwd, "templates", "AGENTS.default.md"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load the project's AGENTS.md.
 * Never throws for a missing file — falls back to the template or a built-in.
 * Throws AgentsMdLoaderError only on an unexpected I/O problem.
 */
export async function loadAgentsMd(cwd: string): Promise<AgentsMdResult> {
  const root = path.resolve(cwd);
  const absPath = path.join(root, "AGENTS.md");
  const relPath = "AGENTS.md";

  // 1. Read if it already exists.
  let existing: string | null = null;
  try {
    existing = await fs.readFile(absPath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AgentsMdLoaderError("io_error", `read AGENTS.md failed: ${msg}`);
    }
  }

  if (existing !== null) {
    const stat = await fs.stat(absPath);
    return {
      absPath,
      relPath,
      content: existing,
      created: false,
      usedFallback: false,
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
    };
  }

  // 2. Missing → try the template.
  const templatePath = await findTemplate(root);
  let body: string;
  let usedFallback = false;

  if (templatePath) {
    try {
      body = await fs.readFile(templatePath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AgentsMdLoaderError(
        "io_error",
        `read template failed (${templatePath}): ${msg}`
      );
    }
  } else {
    body = FALLBACK_AGENTS_MD;
    usedFallback = true;
  }

  // 3. Write it into place (atomic).
  try {
    await fs.mkdir(root, { recursive: true });
    const tmp = absPath + ".tmp";
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AgentsMdLoaderError("io_error", `create AGENTS.md failed: ${msg}`);
  }

  const stat = await fs.stat(absPath);
  return {
    absPath,
    relPath,
    content: body,
    created: true,
    usedFallback,
    mtimeIso: new Date(stat.mtimeMs).toISOString(),
  };
}