/**
 * src/config/HomeConfig.ts
 * ------------------------
 * Reads/writes the global home folder: ~/.agent-cli/
 *
 * Owns:
 *   • profiles.json     — all API profiles (URL, key-ref, protocol, model, effort)
 *   • instructions.md   — global custom instructions (apply to every project)
 *   • keys/             — encrypted keys directory (files managed elsewhere)
 *
 * Does NOT decrypt keys — that is the caller's job using the keyRef path.
 * Does NOT validate provider handshake — that is ProtocolDetector's job.
 */

import * as fs from "fs/promises";

import * as os from "os";
import * as path from "path";


// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const HOME_DIR_NAME = ".agent-cli";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface HomePaths {
  readonly homeDir: string;
  readonly profilesFile: string;
  readonly instructionsFile: string;
  readonly keysDir: string;
}

export interface ApiProfile {
  /** Stable identifier the user chooses (e.g. "openai", "gemini-fast"). */
  readonly id: string;
  readonly baseUrl: string;
  /** Filename inside keysDir (NOT the key itself). */
  readonly keyRef: string;
  /** Optional: pin a protocol instead of auto-detecting. */
  readonly protocol?: "openai" | "anthropic" | "google" | "custom";
  readonly model: string;
  /** low | medium | high — user preference, used by effortCommand. */
  readonly effort?: "low" | "medium" | "high";
  /** Optional: cheaper/faster model used only for Summarizer calls. */
  readonly summaryModel?: string;
  /** Optional: custom field mapping file (used when protocol === "custom"). */
  readonly customMappingFile?: string;
}

export interface ProfilesFileShape {
  readonly activeProfileId: string | null;
  readonly profiles: readonly ApiProfile[];
}

export interface HomeConfig {
  readonly paths: HomePaths;
  readonly profiles: ProfilesFileShape;
  readonly instructions: string;
}


// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function buildPaths(): HomePaths {
  const homeDir = path.join(os.homedir(), HOME_DIR_NAME);
  return {
    homeDir,
    profilesFile: path.join(homeDir, "profiles.json"),
    instructionsFile: path.join(homeDir, "instructions.md"),
    keysDir: path.join(homeDir, "keys"),
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

const DEFAULT_PROFILES: ProfilesFileShape = {
  activeProfileId: null,
  profiles: [],
};

const DEFAULT_INSTRUCTIONS_MD = "";


// ------------------------------------------------------------------
// Parsing / validation
// ------------------------------------------------------------------

function isApiProfile(v: unknown): v is ApiProfile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  if (typeof o.baseUrl !== "string" || o.baseUrl.length === 0) return false;
  if (typeof o.keyRef !== "string" || o.keyRef.length === 0) return false;
  if (typeof o.model !== "string" || o.model.length === 0) return false;
  if (o.protocol !== undefined) {
    const p = o.protocol;
    if (p !== "openai" && p !== "anthropic" && p !== "google" && p !== "custom") {
      return false;
    }
  }
  if (o.effort !== undefined) {
    const e = o.effort;
    if (e !== "low" && e !== "medium" && e !== "high") return false;
  }
  if (o.summaryModel !== undefined && typeof o.summaryModel !== "string") return false;
  if (o.customMappingFile !== undefined && typeof o.customMappingFile !== "string") return false;
  return true;
}

function parseProfilesFile(raw: string): ProfilesFileShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HomeConfig: profiles.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("HomeConfig: profiles.json must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  const activeProfileId =
    o.activeProfileId === null || typeof o.activeProfileId === "string"
      ? (o.activeProfileId as string | null)
      : null;

  const profilesRaw = Array.isArray(o.profiles) ? o.profiles : [];
  const profiles: ApiProfile[] = [];
  for (const entry of profilesRaw) {
    if (!isApiProfile(entry)) {
      throw new Error("HomeConfig: profiles.json contains an invalid profile entry");
    }
    profiles.push(entry);
  }

  return { activeProfileId, profiles };
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load the global home config. Creates ~/.agent-cli/ and its default files
 * on first use. Throws only if the folder cannot be created / read.
 */
export async function loadHomeConfig(): Promise<HomeConfig> {
  const paths = buildPaths();

  await fs.mkdir(paths.homeDir, { recursive: true });
  await fs.mkdir(paths.keysDir, { recursive: true });

  // Seed defaults only when the file is missing.
  await writeFileIfMissing(
    paths.profilesFile,
    JSON.stringify(DEFAULT_PROFILES, null, 2) + "\n"
  );
  await writeFileIfMissing(paths.instructionsFile, DEFAULT_INSTRUCTIONS_MD);

  const profilesRaw = await fs.readFile(paths.profilesFile, "utf8");
  const profiles = parseProfilesFile(profilesRaw);

  const instructions = await fs.readFile(paths.instructionsFile, "utf8");

  return { paths, profiles, instructions };
}


/**
 * Save the full profiles file. Overwrites — caller should pass the merged shape.
 * Uses temp-file + rename for a safe write.
 */
export async function saveProfiles(
  paths: HomePaths,
  profiles: ProfilesFileShape
): Promise<void> {
  await fs.mkdir(paths.homeDir, { recursive: true });
  const tmp = paths.profilesFile + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(profiles, null, 2) + "\n", "utf8");
  await fs.rename(tmp, paths.profilesFile);
}


/**
 * Replace the global custom instructions file.
 */
export async function saveInstructions(
  paths: HomePaths,
  content: string
): Promise<void> {
  await fs.mkdir(paths.homeDir, { recursive: true });
  const tmp = paths.instructionsFile + ".tmp";
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, paths.instructionsFile);
}


/**
 * Return the currently active profile, or null if none is set / id is stale.
 */
export function getActiveProfile(config: HomeConfig): ApiProfile | null {
  const { activeProfileId, profiles } = config.profiles;
  if (!activeProfileId) return null;
  return profiles.find((p) => p.id === activeProfileId) ?? null;
}


/**
 * Sync existence check for keysDir — used by /api before writing a new key file.
 * Returns the absolute path to the key file for a given keyRef.
 */
export function keyFilePath(paths: HomePaths, keyRef: string): string {
  // keyRef must be a plain filename; reject any path separators to prevent escape.
  if (keyRef.includes("/") || keyRef.includes("\\") || keyRef === "." || keyRef === "..") {
    throw new Error(`HomeConfig: invalid keyRef — ${keyRef}`);
  }
  return path.join(paths.keysDir, keyRef);
}