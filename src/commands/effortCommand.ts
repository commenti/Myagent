/**
 * src/commands/effortCommand.ts
 * -----------------------------
 * The `/effort` slash command.
 *
 * Usage:
 *   /effort                show the current effort level
 *   /effort low|medium|high
 *                          set the active profile's effort level
 *   /effort list           list valid values
 *
 * Notes:
 *   - Effort is stored per-profile in ~/.agent-cli/profiles.json
 *     (ApiProfile.effort). It is a user preference, not a protocol field.
 *   - Adapters that understand effort (thinking budgets, reasoning tokens)
 *     read it from the active profile. Adapters that don't simply ignore it.
 *
 * All user-facing text is English.
 */

import type { CommandContext } from "../ui/Renderer";
import {
  loadHomeConfig,
  saveProfiles,
  getActiveProfile,
  type ProfilesFileShape,
} from "../config/HomeConfig";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const LEVELS = ["low", "medium", "high"] as const;
type Effort = (typeof LEVELS)[number];

const DEFAULT_LEVEL: Effort = "medium";


// ------------------------------------------------------------------
// Entry
// ------------------------------------------------------------------

export async function run(ctx: CommandContext, args: string): Promise<string> {
  const trimmed = args.trim().toLowerCase();

  if (trimmed.length === 0) return showCurrent(ctx);
  if (trimmed === "list") return listLevels(ctx);

  if (!isEffort(trimmed)) {
    return `invalid effort "${trimmed}". use: low | medium | high`;
  }

  return setEffort(ctx, trimmed);
}


// ------------------------------------------------------------------
// Read
// ------------------------------------------------------------------

async function showCurrent(ctx: CommandContext): Promise<string> {
  const home = await loadHomeConfig();
  const active = getActiveProfile(home);

  if (!active) {
    return "no active profile. use /api to add one first.";
  }

  const level: Effort = active.effort ?? DEFAULT_LEVEL;
  const line = `effort: ${level} (profile: ${active.id})`;
  ctx.emit({ type: "note", text: line });
  return line;
}

async function listLevels(ctx: CommandContext): Promise<string> {
  ctx.emit({ type: "note", text: `valid levels: ${LEVELS.join(" | ")}` });
  ctx.emit({
    type: "note",
    text: "low = fastest, smallest thinking budget",
  });
  ctx.emit({
    type: "note",
    text: "medium = balanced (default)",
  });
  ctx.emit({
    type: "note",
    text: "high = largest thinking budget, slowest",
  });
  return `levels: ${LEVELS.join(", ")}`;
}


// ------------------------------------------------------------------
// Write
// ------------------------------------------------------------------

async function setEffort(ctx: CommandContext, level: Effort): Promise<string> {
  const home = await loadHomeConfig();
  const active = getActiveProfile(home);

  if (!active) {
    return "no active profile. use /api to add one first.";
  }

  const updated = home.profiles.profiles.map((p) =>
    p.id === active.id ? { ...p, effort: level } : p
  );

  const next: ProfilesFileShape = {
    activeProfileId: home.profiles.activeProfileId,
    profiles: updated,
  };

  try {
    await saveProfiles(home.paths, next);
  } catch (err) {
    return `failed to save effort: ${err instanceof Error ? err.message : String(err)}`;
  }

  const line = `effort set to ${level} (profile: ${active.id})`;
  ctx.emit({ type: "note", text: line });
  return line;
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isEffort(s: string): s is Effort {
  return (LEVELS as readonly string[]).indexOf(s) >= 0;
}