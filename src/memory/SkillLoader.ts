/**
 * src/memory/SkillLoader.ts
 * -------------------------
 * Loads and manages skills.
 *
 * Sources:
 *   • built-in: templates/SKILL.default.md — a single file with one skill
 *     per `## <name>` section.
 *   • user:     <cwd>/.agent-runtime/skills/<name>.md — one file per skill.
 *
 * Rules (ARCHITECTURE.md §7):
 *   • Skills are loaded ON DEMAND. They are never sent verbatim on every call.
 *   • Built-in skills cannot be removed by the user.
 *   • User skill names are sanitized: no path separators, no "..", no leading dot.
 *
 * No AI calls. Pure file I/O.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { ProjectConfig } from "../config/ProjectConfig";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type SkillSource = "builtin" | "user";

export interface Skill {
  readonly name: string;
  readonly content: string;
  readonly source: SkillSource;
  /** Absolute path to the .md file this skill came from. */
  readonly path: string;
}

export interface SkillBundle {
  /** Built-ins first, then user skills. */
  readonly skills: readonly Skill[];
  /** <cwd>/.agent-runtime/skills (created on first write). */
  readonly userSkillsDir: string;
  /** templates/SKILL.default.md, or "" if not found. */
  readonly builtinPath: string;
}

export class SkillLoaderError extends Error {
  public readonly code: "io_error" | "bad_name";
  constructor(code: SkillLoaderError["code"], message: string) {
    super(message);
    this.name = "SkillLoaderError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Name sanitizing (used for user skills)
// ------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw new SkillLoaderError(
      "bad_name",
      "invalid skill name: use letters, digits, dot, dash, underscore (start with letter/digit)"
    );
  }
  if (trimmed === "." || trimmed === "..") {
    throw new SkillLoaderError("bad_name", "invalid skill name: " + trimmed);
  }
  return trimmed;
}


// ------------------------------------------------------------------
// Built-in discovery
// ------------------------------------------------------------------

/**
 * Find templates/SKILL.default.md. Looks next to the package (dist/../templates)
 * first, then in dev mode (src/memory/../../templates), then as a sibling of cwd.
 */
async function findBuiltinFile(cwd: string): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "..", "templates", "SKILL.default.md"),
    path.resolve(__dirname, "..", "..", "templates", "SKILL.default.md"),
    path.join(cwd, "templates", "SKILL.default.md"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return "";
}


/**
 * Parse a single built-in file into zero or more skills.
 * Format: each skill starts with "## <name>" and runs until the next "##".
 * If no "## " heading exists, the whole file becomes one skill named "default".
 */
function parseBuiltinFile(raw: string, filePath: string): Skill[] {
  const lines = raw.split("\n");

  // Find every top-level "## " heading.
  const indices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) indices.push(i);
  }

  if (indices.length === 0) {
    return [{
      name: "default",
      content: raw,
      source: "builtin",
      path: filePath,
    }];
  }

  const out: Skill[] = [];
  for (let k = 0; k < indices.length; k++) {
    const start = indices[k];
    const end = k + 1 < indices.length ? indices[k + 1] : lines.length;

    const headingLine = lines[start].replace(/^##\s+/, "").trim();
    // Name is the first token of the heading; rest is a description.
    const name = headingLine.split(/\s+/)[0];
    if (!name) continue;

    const body = lines.slice(start + 1, end).join("\n").replace(/\s+$/, "");
    out.push({
      name,
      content: body,
      source: "builtin",
      path: filePath,
    });
  }
  return out;
}


// ------------------------------------------------------------------
// User-skill discovery
// ------------------------------------------------------------------

async function readUserSkills(dir: string): Promise<Skill[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw new SkillLoaderError(
      "io_error",
      "cannot read skills dir: " + (err instanceof Error ? err.message : String(err))
    );
  }

  const out: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.isSymbolicLink()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;

    const abs = path.join(dir, entry.name);
    const name = entry.name.replace(/\.md$/i, "");
    if (!NAME_RE.test(name)) continue;

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    out.push({
      name,
      content,
      source: "user",
      path: abs,
    });
  }

  // Deterministic order.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load all skills: built-ins first, then user skills.
 * Duplicate names: user skill overrides built-in (a common way to patch one).
 */
export async function loadSkills(projectConfig: ProjectConfig): Promise<SkillBundle> {
  const userSkillsDir = projectConfig.paths.skillsDir;

  // Ensure the user skills dir exists so `addUserSkill` writes succeed later.
  try {
    await fs.mkdir(userSkillsDir, { recursive: true });
  } catch {
    // Non-fatal — reads still work, writes will surface the error.
  }

  const builtinPath = await findBuiltinFile(projectConfig.cwd);
  const builtinSkills: Skill[] = [];
  if (builtinPath.length > 0) {
    try {
      const raw = await fs.readFile(builtinPath, "utf8");
      builtinSkills.push(...parseBuiltinFile(raw, builtinPath));
    } catch {
      /* unreadable built-in file — ignore */
    }
  }

  const userSkills = await readUserSkills(userSkillsDir);

  // Merge: user overrides built-in by name.
  const byName = new Map<string, Skill>();
  for (const s of builtinSkills) byName.set(s.name, s);
  for (const s of userSkills) byName.set(s.name, s);

  // Deterministic order: built-in order first, then user-only names sorted.
  const skills: Skill[] = [];
  for (const s of builtinSkills) {
    const merged = byName.get(s.name);
    if (merged) {
      skills.push(merged);
      byName.delete(s.name);
    }
  }
  const remainingUser = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  skills.push(...remainingUser);

  return {
    skills,
    userSkillsDir,
    builtinPath,
  };
}


/**
 * Look up one skill by name. Case-insensitive.
 * Returns null when nothing matches.
 */
export function readSkill(bundle: SkillBundle, name: string): Skill | null {
  const q = name.trim().toLowerCase();
  if (q.length === 0) return null;
  for (const s of bundle.skills) {
    if (s.name.toLowerCase() === q) return s;
  }
  return null;
}


/**
 * Write a user skill (overwrites if it already exists).
 * Name is sanitized; the file is written atomically.
 */
export async function addUserSkill(
  projectConfig: ProjectConfig,
  name: string,
  content: string
): Promise<Skill> {
  const safe = sanitizeName(name);
  const dir = projectConfig.paths.skillsDir;

  await fs.mkdir(dir, { recursive: true });

  const abs = path.join(dir, safe + ".md");

  // Defensive: confirm the resolved path is still inside skillsDir.
  const resolved = path.resolve(abs);
  const dirResolved = path.resolve(dir);
  if (resolved !== dirResolved && !resolved.startsWith(dirResolved + path.sep)) {
    throw new SkillLoaderError("bad_name", "skill path escapes skills dir");
  }

  const tmp = abs + ".tmp";
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw new SkillLoaderError(
      "io_error",
      "write skill failed: " + (err instanceof Error ? err.message : String(err))
    );
  }

  return {
    name: safe,
    content,
    source: "user",
    path: abs,
  };
}


/**
 * Delete a user skill. Returns true if a file was removed.
 * Never touches built-ins.
 */
export async function removeUserSkill(
  projectConfig: ProjectConfig,
  name: string
): Promise<boolean> {
  let safe: string;
  try {
    safe = sanitizeName(name);
  } catch {
    return false;
  }

  const abs = path.join(projectConfig.paths.skillsDir, safe + ".md");

  try {
    await fs.unlink(abs);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw new SkillLoaderError(
      "io_error",
      "remove skill failed: " + (err instanceof Error ? err.message : String(err))
    );
  }
}