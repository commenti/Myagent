/**
 * src/commands/apiCommand.ts
 * --------------------------
 * The `/api` slash command.
 *
 * Usage forms:
 *   /api                                show current profile + usage
 *   /api list                           list all profiles
 *   /api use <id>                       switch active profile (runs handshake)
 *   /api remove <id>                    delete a profile + its key file
 *   /api <baseUrl> <key> <model>        add or update a profile (runs handshake)
 *
 * Optional flags on add/update:
 *   --id=<name>            profile id (default: hostname of baseUrl)
 *   --protocol=openai|anthropic|google|custom
 *   --effort=low|medium|high
 *   --summary-model=<name> cheaper model for Summarizer calls
 *   --custom-mapping=<path> JSON field-mapping file (custom protocol only)
 *   --no-handshake         save without testing (offline / known endpoint)
 *
 * Key storage:
 *   Keys are written to <homeDir>/keys/<id>.key, encrypted with AES-256-GCM.
 *   The 32-byte master secret lives in <homeDir>/.keyring (chmod 600),
 *   created on first use. If you lose .keyring, saved keys cannot be read.
 *
 * Everything user-facing is English.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";

import type { CommandContext } from "../ui/Renderer";
import {
  loadHomeConfig,
  saveProfiles,
  getActiveProfile,
  keyFilePath,
  type ApiProfile,
  type HomePaths,
  type ProfilesFileShape,
} from "../config/HomeConfig";
import { detectProtocol } from "../providers/ProtocolDetector";
import { ProviderError } from "../providers/ErrorClassifier";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const KEYRING_FILE = ".keyring";
const KEYRING_BYTES = 32;
const IV_BYTES = 12;
const KEY_FILE_VERSION = 1;

const VALID_PROTOCOLS = ["openai", "anthropic", "google", "custom"] as const;
type Protocol = (typeof VALID_PROTOCOLS)[number];

const VALID_EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof VALID_EFFORTS)[number];

// ------------------------------------------------------------------
// Encrypted key file format
// ------------------------------------------------------------------

interface EncryptedKeyFile {
  readonly v: number;
  readonly iv: string;   // base64
  readonly tag: string;  // base64
  readonly ct: string;   // base64
}

// ------------------------------------------------------------------
// Public entry — what Renderer calls
// ------------------------------------------------------------------

export async function run(ctx: CommandContext, args: string): Promise<string> {
  const trimmed = args.trim();

  // No args → status.
  if (trimmed.length === 0) {
    return showStatus(ctx);
  }

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];

  if (head === "list") return listProfiles(ctx);
  if (head === "use") return useProfile(ctx, tokens.slice(1));
  if (head === "remove" || head === "rm") {
    return removeProfile(ctx, tokens.slice(1));
  }

  return addOrUpdate(ctx, tokens);
}

// ------------------------------------------------------------------
// Sub-commands
// ------------------------------------------------------------------

async function showStatus(ctx: CommandContext): Promise<string> {
  const home = await loadHomeConfig();
  const active = getActiveProfile(home);

  if (!active) {
    if (home.profiles.profiles.length === 0) {
      return "no API profile configured. usage: /api <baseUrl> <key> <model>";
    }

    return "no active profile. use /api list then /api use <id>";
  }

  const summary =
    `${active.id} (${active.protocol ?? "auto"}) — ` +
    `${active.model} @ ${active.baseUrl}`;

  ctx.emit({
    type: "note",
    text: `active profile: ${summary}`,
  });

  return summary;
}

async function listProfiles(ctx: CommandContext): Promise<string> {
  const home = await loadHomeConfig();
  const list = home.profiles.profiles;

  if (list.length === 0) {
    return "no profiles configured.";
  }

  ctx.emit({
    type: "note",
    text: `profiles (${list.length}):`,
  });

  for (const p of list) {
    const mark =
      p.id === home.profiles.activeProfileId ? "*" : " ";

    ctx.emit({
      type: "note",
      text: `${mark} ${p.id} — ${p.model} @ ${p.baseUrl}`,
    });
  }

  return `${list.length} profile(s)`;
}

async function useProfile(
  ctx: CommandContext,
  rest: string[]
): Promise<string> {
  const id = rest[0];

  if (!id) {
    return "usage: /api use <id>";
  }

  const home = await loadHomeConfig();

  const target = home.profiles.profiles.find(
    (p) => p.id === id,
  );

  if (!target) {
    return `no such profile: ${id} (try /api list)`;
  }

  // Handshake with the target profile's stored key.
  let key: string;

  try {
    key = await loadApiKey(home.paths, target.keyRef);
  } catch (err) {
    return (
      `cannot read key for ${id}: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }

  const ok = await runHandshake(ctx, target, key);

  if (!ok.ok) {
    return `handshake failed for ${id}: ${ok.reason}`;
  }

  const next: ProfilesFileShape = {
    activeProfileId: target.id,
    profiles: home.profiles.profiles,
  };

  await saveProfiles(home.paths, next);

  const line =
    `active profile set to ${target.id} ` +
    `(${ok.protocol}, ${target.model})`;

  ctx.emit({
    type: "note",
    text: line,
  });

  return line;
}

async function removeProfile(
  ctx: CommandContext,
  rest: string[]
): Promise<string> {
  const id = rest[0];

  if (!id) {
    return "usage: /api remove <id>";
  }

  const home = await loadHomeConfig();

  const target = home.profiles.profiles.find(
    (p) => p.id === id,
  );

  if (!target) {
    return `no such profile: ${id}`;
  }

  const remaining = home.profiles.profiles.filter(
    (p) => p.id !== id,
  );

  const nextActive =
    home.profiles.activeProfileId === id
      ? (remaining[0]?.id ?? null)
      : home.profiles.activeProfileId;

  const next: ProfilesFileShape = {
    activeProfileId: nextActive,
    profiles: remaining,
  };

  await saveProfiles(home.paths, next);

  // Best-effort delete of the key file.
  try {
    const abs = keyFilePath(home.paths, target.keyRef);
    await fs.unlink(abs);
  } catch {
    // ignore — the profile is already gone from profiles.json
  }

  ctx.emit({
    type: "note",
    text: `removed profile: ${id}`,
  });

  return `removed ${id}`;
}

// ------------------------------------------------------------------
// Add / update
// ------------------------------------------------------------------

interface ParsedAdd {
  readonly baseUrl: string;
  readonly key: string;
  readonly model: string;
  readonly id: string;
  readonly protocol?: Protocol;
  readonly effort?: Effort;
  readonly summaryModel?: string;
  readonly customMappingFile?: string;
  readonly skipHandshake: boolean;
}

async function addOrUpdate(
  ctx: CommandContext,
  tokens: string[],
): Promise<string> {
  const parsed = parseAddTokens(tokens);

  if (typeof parsed === "string") {
    return parsed;
  }

  const home = await loadHomeConfig();

  // Validate the URL.
  let host: string;

  try {
    const u = new URL(parsed.baseUrl);
    host = u.hostname;
  } catch {
    return `invalid baseUrl: ${parsed.baseUrl}`;
  }

  const id = parsed.id || sanitizeId(host);
  const keyRef = `${id}.key`;

  // Custom protocol requires a mapping file.
  if (parsed.protocol === "custom" && !parsed.customMappingFile) {
    return "protocol=custom requires --custom-mapping=<path>";
  }

  // Build the profile that will be saved
  // (whether or not handshake runs first).
  const profile: ApiProfile = {
    id,
    baseUrl: parsed.baseUrl,
    keyRef,
    model: parsed.model,
    ...(parsed.protocol ? { protocol: parsed.protocol } : {}),
    ...(parsed.effort ? { effort: parsed.effort } : {}),
    ...(parsed.summaryModel
      ? { summaryModel: parsed.summaryModel }
      : {}),
    ...(parsed.customMappingFile
      ? { customMappingFile: parsed.customMappingFile }
      : {}),
  };

  // Handshake BEFORE saving, so a bad profile never becomes active.
  if (!parsed.skipHandshake) {
    ctx.emit({
      type: "tool-call",
      name: "handshake",
      args: `${parsed.baseUrl} ${parsed.model}`,
    });

    const hs = await runHandshake(
      ctx,
      profile,
      parsed.key,
    );

    if (!hs.ok) {
      return `handshake failed: ${hs.reason}`;
    }

    ctx.emit({
      type: "tool-result",
      name: "handshake",
      ok: true,
      summary: `protocol=${hs.protocol}`,
    });
  }

  // Encrypt the key, write it.
  try {
    await saveApiKey(
      home.paths,
      keyRef,
      parsed.key,
    );
  } catch (err) {
    return (
      `failed to store key: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Upsert the profile.
  // First profile added becomes active automatically.
  const existing = home.profiles.profiles;

  const idx = existing.findIndex(
    (p) => p.id === id,
  );

  const merged =
    idx >= 0
      ? [
          ...existing.slice(0, idx),
          profile,
          ...existing.slice(idx + 1),
        ]
      : [...existing, profile];

  const nextActive =
    home.profiles.activeProfileId ?? profile.id;

  const next: ProfilesFileShape = {
    activeProfileId: nextActive,
    profiles: merged,
  };

  try {
    await saveProfiles(home.paths, next);
  } catch (err) {
    return (
      `failed to save profile: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }

  const verb = idx >= 0 ? "updated" : "added";

  const line =
    `${verb} profile "${id}" ` +
    `(model=${profile.model})`;

  ctx.emit({
    type: "note",
    text: line,
  });

  return line;
}

// ------------------------------------------------------------------
// Token parsing for add/update
// ------------------------------------------------------------------

function parseAddTokens(
  tokens: string[],
): ParsedAdd | string {
  // Separate positional tokens from --flags.
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (const t of tokens) {
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");

      if (eq === -1) {
        flags.set(t.slice(2), true);
      } else {
        flags.set(
          t.slice(2, eq),
          t.slice(eq + 1),
        );
      }
    } else {
      positional.push(t);
    }
  }

  if (positional.length < 3) {
    return (
      "usage: /api <baseUrl> <key> <model> " +
      "[--id=] [--protocol=] [--effort=] " +
      "[--summary-model=] [--custom-mapping=] " +
      "[--no-handshake]"
    );
  }

  const baseUrl = positional[0];
  const key = positional[1];
  const model = positional[2];

  let protocol: Protocol | undefined;

  const pFlag = flags.get("protocol");

  if (typeof pFlag === "string") {
    if (!isProtocol(pFlag)) {
      return `invalid protocol: ${pFlag}`;
    }

    protocol = pFlag;
  }

  let effort: Effort | undefined;

  const eFlag = flags.get("effort");

  if (typeof eFlag === "string") {
    if (!isEffort(eFlag)) {
      return `invalid effort: ${eFlag}`;
    }

    effort = eFlag;
  }

  const idFlag = flags.get("id");
  const id =
    typeof idFlag === "string"
      ? idFlag
      : "";

  const smFlag = flags.get("summary-model");

  const summaryModel =
    typeof smFlag === "string"
      ? smFlag
      : undefined;

  const cmFlag = flags.get("custom-mapping");

  const customMappingFile =
    typeof cmFlag === "string"
      ? cmFlag
      : undefined;

  const skipHandshake =
    flags.get("no-handshake") === true;

  return {
    baseUrl,
    key,
    model,
    id,
    ...(protocol ? { protocol } : {}),
    ...(effort ? { effort } : {}),
    ...(summaryModel
      ? { summaryModel }
      : {}),
    ...(customMappingFile
      ? { customMappingFile }
      : {}),
    skipHandshake,
  };
}

function isProtocol(
  s: string,
): s is Protocol {
  return (
    VALID_PROTOCOLS as readonly string[]
  ).indexOf(s) >= 0;
}

function isEffort(
  s: string,
): s is Effort {
  return (
    VALID_EFFORTS as readonly string[]
  ).indexOf(s) >= 0;
}

// ------------------------------------------------------------------
// Handshake
// ------------------------------------------------------------------

interface HandshakeResult {
  readonly ok: boolean;
  readonly protocol: string;
  readonly reason: string;
}

async function runHandshake(
  ctx: CommandContext,
  profile: ApiProfile,
  key: string,
): Promise<HandshakeResult> {
  try {
    const result = await detectProtocol({
      baseUrl: profile.baseUrl,
      apiKey: key,
      model: profile.model,
      ...(profile.protocol
        ? { protocol: profile.protocol }
        : {}),
      ...(profile.customMappingFile
        ? {
            customMappingFile:
              profile.customMappingFile,
          }
        : {}),
    });

    for (const a of result.attempts) {
      if (!a.ok) {
        ctx.emit({
          type: "note",
          text:
            `tried ${a.protocol}: ` +
            `${a.errorType ?? "error"} — ` +
            `${a.errorMessage ?? ""}`,
        });
      }
    }

    return {
      ok: true,
      protocol: result.protocol,
      reason: "",
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return {
        ok: false,
        protocol: "",
        reason:
          `${err.type} — ${err.message}`,
      };
    }

    return {
      ok: false,
      protocol: "",
      reason:
        err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

// ------------------------------------------------------------------
// Encrypted key storage
// ------------------------------------------------------------------

async function ensureKeyring(
  paths: HomePaths,
): Promise<Buffer> {
  const abs = path.join(
    paths.homeDir,
    KEYRING_FILE,
  );

  if (fsSync.existsSync(abs)) {
    const raw = await fs.readFile(abs);

    if (raw.length !== KEYRING_BYTES) {
      throw new Error(
        `${KEYRING_FILE} is corrupt ` +
        `(expected ${KEYRING_BYTES} bytes)`,
      );
    }

    return raw;
  }

  await fs.mkdir(paths.homeDir, {
    recursive: true,
  });

  const secret =
    crypto.randomBytes(KEYRING_BYTES);

  await fs.writeFile(
    abs,
    secret,
    { mode: 0o600 },
  );

  return secret;
}

async function saveApiKey(
  paths: HomePaths,
  keyRef: string,
  plaintext: string,
): Promise<void> {
  const secret =
    await ensureKeyring(paths);

  const abs =
    keyFilePath(paths, keyRef);

  const iv =
    crypto.randomBytes(IV_BYTES);

  const cipher =
    crypto.createCipheriv(
      "aes-256-gcm",
      secret,
      iv,
    );

  const ct = Buffer.concat([
    cipher.update(
      plaintext,
      "utf8",
    ),
    cipher.final(),
  ]);

  const tag =
    cipher.getAuthTag();

  const payload: EncryptedKeyFile = {
    v: KEY_FILE_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };

  await fs.mkdir(
    paths.keysDir,
    { recursive: true },
  );

  const tmp = abs + ".tmp";

  await fs.writeFile(
    tmp,
    JSON.stringify(payload) + "\n",
    { mode: 0o600 },
  );

  await fs.rename(
    tmp,
    abs,
  );
}

/**
 * Decrypt a stored key. Exported so other modules
 * (e.g. the future turn runner) can read the active
 * profile's key without duplicating crypto.
 */
export async function loadApiKey(
  paths: HomePaths,
  keyRef: string,
): Promise<string> {
  const abs =
    keyFilePath(paths, keyRef);

  const raw =
    await fs.readFile(
      abs,
      "utf8",
    );

  let parsed:
    Partial<EncryptedKeyFile>;

  try {
    parsed =
      JSON.parse(raw) as Partial<EncryptedKeyFile>;
  } catch {
    throw new Error(
      `key file is not valid JSON: ${keyRef}`,
    );
  }

  if (
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ct !== "string"
  ) {
    throw new Error(
      `key file is malformed: ${keyRef}`,
    );
  }

  const secret =
    await ensureKeyring(paths);

  const iv =
    Buffer.from(
      parsed.iv,
      "base64",
    );

  const tag =
    Buffer.from(
      parsed.tag,
      "base64",
    );

  const ct =
    Buffer.from(
      parsed.ct,
      "base64",
    );

  const decipher =
    crypto.createDecipheriv(
      "aes-256-gcm",
      secret,
      iv,
    );

  decipher.setAuthTag(tag);

  const pt = Buffer.concat([
    decipher.update(ct),
    decipher.final(),
  ]);

  return pt.toString("utf8");
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function sanitizeId(
  s: string,
): string {
  const out = s
    .toLowerCase()
    .replace(
      /[^a-z0-9._-]+/g,
      "-",
    )
    .replace(
      /^-+|-+$/g,
      "",
    );

  return out.length > 0
    ? out
    : "profile";
}

// ------------------------------------------------------------------
// Programmatic save + activate — used by the interactive /api form
// ------------------------------------------------------------------

/**
 * Save a new profile from three field values and activate it.
 * Runs the handshake BEFORE writing anything (a bad key never becomes active).
 * Returns a structured result so the TUI can show errors inline and keep the
 * form open on failure.
 */
export async function saveAndActivate(
  ctx: CommandContext,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<
  | {
      ok: true;
      profileId: string;
      protocol: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  let host: string;

  try {
    const u = new URL(baseUrl);
    host = u.hostname;
  } catch {
    return {
      ok: false,
      error:
        "Invalid Base URL: " +
        baseUrl,
    };
  }

  const home =
    await loadHomeConfig();

  const id =
    sanitizeId(host);

  const keyRef =
    id + ".key";

  const profile: ApiProfile = {
    id,
    baseUrl,
    keyRef,
    model,
  };

  ctx.emit({
    type: "tool-call",
    name: "handshake",
    args:
      baseUrl + " " + model,
  });

  const hs =
    await runHandshake(
      ctx,
      profile,
      apiKey,
    );

  if (!hs.ok) {
    ctx.emit({
      type: "tool-result",
      name: "handshake",
      ok: false,
      summary: hs.reason,
    });

    return {
      ok: false,
      error: hs.reason,
    };
  }

  ctx.emit({
    type: "tool-result",
    name: "handshake",
    ok: true,
    summary:
      "protocol=" + hs.protocol,
  });

  try {
    await saveApiKey(
      home.paths,
      keyRef,
      apiKey,
    );
  } catch (err) {
    return {
      ok: false,
      error:
        "Failed to store key: " +
        (
          err instanceof Error
            ? err.message
            : String(err)
        ),
    };
  }

  const existing =
    home.profiles.profiles;

  const idx =
    existing.findIndex(
      (p) => p.id === id,
    );

  const merged =
    idx >= 0
      ? [
          ...existing.slice(
            0,
            idx,
          ),
          profile,
          ...existing.slice(
            idx + 1,
          ),
        ]
      : [
          ...existing,
          profile,
        ];

  const next: ProfilesFileShape = {
    activeProfileId:
      profile.id,
    profiles: merged,
  };

  try {
    await saveProfiles(
      home.paths,
      next,
    );
  } catch (err) {
    return {
      ok: false,
      error:
        "Failed to save profile: " +
        (
          err instanceof Error
            ? err.message
            : String(err)
        ),
    };
  }

  return {
    ok: true,
    profileId: id,
    protocol: hs.protocol,
  };
}