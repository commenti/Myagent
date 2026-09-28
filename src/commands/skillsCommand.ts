/**
 * src/commands/skillsCommand.ts
 * -----------------------------
 * The `/skills` slash command.
 *
 * Usage:
 *   /skills                          list all skills (built-in + user)
 *   /skills path                     show the skills folder path
 *   /skills show <name>              print one skill's content
 *
 *   /skills add <name> <text>        add a user skill (inline body)
 *   /skills add-from-file <path> <name>
 *                                    add a user skill from a file
 *   /skills remove <name>            remove a user skill
 *
 * Notes (ARCHITECTURE.md §7):
 *   - Built-in default skills live in templates/SKILL.default.md.
 *   - User skills live in <cwd>/.agent-runtime/skills/<name>.md.
 *   - Skills are loaded ON DEMAND; they are never sent verbatim on every call.
 *   - User skill names are sanitized: no path separators, no "..".
 *
 * All user-facing text is English.
 */

import * as fs from "fs/promises";

import type { CommandContext } from "../ui/Renderer";
import {
  loadSkills,
  readSkill,
  addUserSkill,
  removeUserSkill,
  type Skill,
  type SkillBundle,
} from "../memory/SkillLoader";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const PREVIEW_CHARS = 300;


// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

export async function run(ctx: CommandContext, args: string): Promise<string> {
  const trimmed = args.trim();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];

  if (tokens.length === 0) return listSkills(ctx);

  const head = tokens[0].toLowerCase();

  if (head === "path" || head === "paths") return showPaths(ctx);
  if (head === "show") return showSkill(ctx, tokens.slice(1));
  if (head === "add") return addInline(ctx, tokens.slice(1));
  if (head === "add-from-file") return addFromFile(ctx, tokens.slice(1));
  if (head === "remove" || head === "rm") return removeSkill(ctx, tokens.slice(1));

  return `unknown action "${head}". usage: /skills [show|add|add-from-file|remove|path] [...]`;
}


// ------------------------------------------------------------------
// Read sub-commands
// ------------------------------------------------------------------

async function listSkills(ctx: CommandContext): Promise<string> {
  const bundle = await loadSkills(ctx.projectConfig);

  if (bundle.skills.length === 0) {
    return "no skills available.";
  }

  const builtin = bundle.skills.filter((s) => s.source === "builtin");
  const user = bundle.skills.filter((s) => s.source === "user");

  ctx.emit({ type: "note", text: `skills (${bundle.skills.length}):` });

  if (builtin.length > 0) {
    ctx.emit({ type: "note", text: "  built-in:" });
    for (const s of builtin) {
      ctx.emit({ type: "note", text: `    ${s.name} — ${firstLine(s.content)}` });
    }
  }
  if (user.length > 0) {
    ctx.emit({ type: "note", text: "  user:" });
    for (const s of user) {
      ctx.emit({ type: "note", text: `    ${s.name} — ${firstLine(s.content)}` });
    }
  }

  return `${bundle.skills.length} skill(s) (${builtin.length} built-in, ${user.length} user)`;
}

async function showPaths(ctx: CommandContext): Promise<string> {
  const bundle = await loadSkills(ctx.projectConfig);
  ctx.emit({ type: "note", text: `user dir: ${bundle.userSkillsDir}` });
  ctx.emit({ type: "note", text: `built-in: ${bundle.builtinPath || "(missing)"}` });
  return "paths shown";
}

async function showSkill(ctx: CommandContext, rest: string[]): Promise<string> {
  const name = rest[0];
  if (!name) return "usage: /skills show <name>";

  const bundle = await loadSkills(ctx.projectConfig);
  const skill = readSkill(bundle, name);
  if (!skill) return `no such skill: ${name}`;

  ctx.emit({ type: "note", text: `skill "${skill.name}" (${skill.source}) — ${skill.path}` });
  const body = skill.content.length > 0 ? skill.content : "(empty)";
  ctx.emit({ type: "note", text: body });

  const lines = skill.content.split("\n").length;
  return `${skill.name}: ${lines} line(s), ${skill.content.length} char(s)`;
}


// ------------------------------------------------------------------
// Write sub-commands
// ------------------------------------------------------------------

async function addInline(ctx: CommandContext, rest: string[]): Promise<string> {
  const name = rest[0];
  if (!name) return "usage: /skills add <name> <text>";

  const body = rest.slice(1).join(" ").trim();
  if (body.length === 0) return "usage: /skills add <name> <text>";

  const content = `# ${name}\n\n${body}\n`;

  try {
    const skill = await addUserSkill(ctx.projectConfig, name, content);
    ctx.emit({ type: "note", text: `added skill: ${skill.name} (${skill.path})` });
    return `added skill "${skill.name}"`;
  } catch (err) {
    return `failed to add skill: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function addFromFile(ctx: CommandContext, rest: string[]): Promise<string> {
  const filePath = rest[0];
  const name = rest[1];
  if (!filePath || !name) {
    return "usage: /skills add-from-file <path> <name>";
  }

  let body: string;
  try {
    body = await fs.readFile(filePath, "utf8");
  } catch (err) {
    return `cannot read file: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (body.trim().length === 0) {
    return `file is empty: ${filePath}`;
  }

  try {
    const skill = await addUserSkill(ctx.projectConfig, name, body);
    ctx.emit({ type: "note", text: `added skill: ${skill.name} (${skill.path})` });
    return `added skill "${skill.name}" from ${filePath}`;
  } catch (err) {
    return `failed to add skill: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function removeSkill(ctx: CommandContext, rest: string[]): Promise<string> {
  const name = rest[0];
  if (!name) return "usage: /skills remove <name>";

  try {
    const removed = await removeUserSkill(ctx.projectConfig, name);
    if (!removed) {
      // Could be a built-in (cannot remove) or simply not found.
      const bundle = await loadSkills(ctx.projectConfig);
      const existing = readSkill(bundle, name);
      if (existing && existing.source === "builtin") {
        return `cannot remove built-in skill: ${name}`;
      }
      return `no user skill named: ${name}`;
    }
    ctx.emit({ type: "note", text: `removed skill: ${name}` });
    return `removed "${name}"`;
  } catch (err) {
    return `failed to remove skill: ${err instanceof Error ? err.message : String(err)}`;
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function firstLine(s: string): string {
  const raw = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  const one = raw.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  return preview(one);
}

function preview(s: string): string {
  if (s.length <= PREVIEW_CHARS) return s;
  return s.slice(0, PREVIEW_CHARS - 1) + "...";
}

// Keep the imported types referenced even if a build tree-shakes them away.
export type { Skill, SkillBundle };