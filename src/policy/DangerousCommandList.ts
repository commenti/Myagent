/**
 * src/policy/DangerousCommandList.ts
 * ----------------------------------
 * Pattern-based detection of destructive shell commands.
 *
 * This is a SECOND layer of defense. The FIRST layer is the working-directory
 * jail in PathGuard. DangerousCommandList only flags commands that could harm
 * the user's system outside the project, or irreversibly destroy data.
 *
 * Nothing here is a security boundary against a malicious model — the model
 * is untrusted, but the worst it can do is already blocked by PathGuard.
 * This list exists to catch honest mistakes and to drive the ask-every-time
 * prompt for genuinely scary commands.
 *
 * No I/O. No side effects. Pure classification.
 */

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type DangerLevel = "safe" | "caution" | "dangerous";

export interface DangerVerdict {
  readonly level: DangerLevel;
  /** Short English reason, safe to show in the TUI. Empty when level is "safe". */
  readonly reason: string;
  /** Which rule matched (for logging / tests). Empty when level is "safe". */
  readonly ruleId: string;
}


// ------------------------------------------------------------------
// Internal rule shape
// ------------------------------------------------------------------

interface Rule {
  readonly id: string;
  readonly level: Exclude<DangerLevel, "safe">;
  readonly reason: string;
  /** Regex tested against the raw command string. */
  readonly pattern: RegExp;
}


// ------------------------------------------------------------------
// Rules
// ------------------------------------------------------------------
// Order matters only for the first-match-wins resolution below. Keep
// "dangerous" rules before "caution" rules so the stronger verdict wins.
// ------------------------------------------------------------------

const RULES: readonly Rule[] = [
  // --- rm variants ---------------------------------------------------
  {
    id: "rm-rf-root",
    level: "dangerous",
    reason: "recursive delete of the filesystem root",
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+(\/|\/\*|~|\$HOME)(\s|$)/,
  },
  {
    id: "rm-rf-wildcard",
    level: "dangerous",
    reason: "recursive forced delete with wildcard",
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+\*/,
  },
  {
    id: "rm-rf-any",
    level: "caution",
    reason: "recursive forced delete",
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\b/,
  },

  // --- disk / filesystem destruction ---------------------------------
  {
    id: "dd-to-device",
    level: "dangerous",
    reason: "raw write to a block device",
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|mmcblk|hd|vd|xvd)/,
  },
  {
    id: "mkfs",
    level: "dangerous",
    reason: "filesystem format",
    pattern: /\bmkfs(\.[a-zA-Z0-9]+)?\b/,
  },
  {
    id: "shred-device",
    level: "dangerous",
    reason: "shredding a block device",
    pattern: /\bshred\b[^\n]*\/dev\/(sd|nvme|mmcblk|hd|vd|xvd)/,
  },
  {
    id: "wipefs",
    level: "dangerous",
    reason: "wiping filesystem signatures",
    pattern: /\bwipefs\b/,
  },

  // --- permission / ownership mass changes ---------------------------
  {
    id: "chmod-r-root",
    level: "dangerous",
    reason: "recursive permission change from filesystem root",
    pattern: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+[0-7]{3,4}\s+\/(\s|$)/,
  },
  {
    id: "chown-r-root",
    level: "dangerous",
    reason: "recursive ownership change from filesystem root",
    pattern: /\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\s+[^\s]+\s+\/(\s|$)/,
  },

  // --- fork bombs ----------------------------------------------------
  {
    id: "fork-bomb",
    level: "dangerous",
    reason: "fork bomb",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },

  // --- redirection over devices / system files -----------------------
  {
    id: "redirect-to-device",
    level: "dangerous",
    reason: "writing directly to a block device",
    pattern: />\s*\/dev\/(sd|nvme|mmcblk|hd|vd|xvd)/,
  },

  // --- shutdown / reboot --------------------------------------------
  {
    id: "system-power",
    level: "caution",
    reason: "system power command",
    pattern: /\b(shutdown|reboot|halt|poweroff)\b/,
  },

  // --- curl | sh style remote execution ------------------------------
  {
    id: "pipe-to-shell",
    level: "caution",
    reason: "piping a remote download directly into a shell",
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|ksh)\b/,
  },

  // --- sudo ----------------------------------------------------------
  {
    id: "sudo",
    level: "caution",
    reason: "elevated privileges (sudo)",
    pattern: /(^|[\s;&|])sudo(\s|$)/,
  },

  // --- git destructive ----------------------------------------------
  {
    id: "git-hard-reset",
    level: "caution",
    reason: "discards local commits/working tree (git reset --hard)",
    pattern: /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/,
  },
  {
    id: "git-clean-force",
    level: "caution",
    reason: "deletes untracked files (git clean -f)",
    pattern: /\bgit\b[^\n]*\bclean\b[^\n]*-[a-zA-Z]*f/,
  },
  {
    id: "git-push-force",
    level: "caution",
    reason: "rewrites remote history (git push --force)",
    pattern: /\bgit\b[^\n]*\bpush\b[^\n]*(--force|-f)\b/,
  },
];


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

const SAFE: DangerVerdict = { level: "safe", reason: "", ruleId: "" };

/**
 * Classify a shell command string.
 * Never throws. Empty / whitespace-only input is "safe".
 */
export function classifyCommand(command: string): DangerVerdict {
  if (typeof command !== "string") return SAFE;
  const trimmed = command.trim();
  if (trimmed.length === 0) return SAFE;

  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return { level: rule.level, reason: rule.reason, ruleId: rule.id };
    }
  }
  return SAFE;
}

/** Convenience: only the level. */
export function classifyLevel(command: string): DangerLevel {
  return classifyCommand(command).level;
}

/** True only when the command is on the "dangerous" list (not "caution"). */
export function isDangerous(command: string): boolean {
  return classifyCommand(command).level === "dangerous";
}