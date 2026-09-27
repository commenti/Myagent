/**
 * src/policy/PermissionManager.ts
 * -------------------------------
 * Decides whether a proposed action is allowed, denied, or must be confirmed
 * by the user.
 *
 * Modes (from ProjectConfig):
 *   • all-allowed     — file ops pass silently; terminal commands pass unless
 *                       they are on the "dangerous" list (those still prompt).
 *   • ask-every-time  — every file op and every terminal command prompts.
 *
 * The user prompt itself is injected as a callback so this module stays
 * free of Ink / TUI code and is easy to test.
 *
 * No direct I/O. State (mode) is read from ProjectConfig.
 */

import type { PermissionMode } from "../config/ProjectConfig";
import {
  classifyCommand,
  type DangerLevel,
  type DangerVerdict,
} from "./DangerousCommandList";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type FileOp = "create" | "edit" | "delete";

export type Decision = "allow" | "deny";

export interface PermissionRequest {
  readonly kind: "file" | "terminal";
  /** For file requests: which operation, and which path. */
  readonly fileOp?: FileOp;
  readonly filePath?: string;
  /** For terminal requests: the exact command string. */
  readonly command?: string;
  /** Present for terminal requests. */
  readonly danger?: DangerVerdict;
  /** Short English line describing the request (shown to the user). */
  readonly summary: string;
}

/**
 * The user-facing prompt. Returns true = allow, false = deny.
 * Must never throw (callers treat a throw as deny).
 */
export type PromptFn = (req: PermissionRequest) => Promise<boolean>;

export interface PermissionManagerOptions {
  readonly mode: PermissionMode;
  /** Required when mode === "ask-every-time", or for dangerous commands. */
  readonly prompt: PromptFn;
  /** Optional logger for audit trail (English, one line per decision). */
  readonly onDecision?: (req: PermissionRequest, decision: Decision) => void;
}


// ------------------------------------------------------------------
// PermissionManager
// ------------------------------------------------------------------

export class PermissionManager {
  private mode: PermissionMode;
  private readonly prompt: PromptFn;
  private readonly onDecision: (req: PermissionRequest, decision: Decision) => void;

  constructor(opts: PermissionManagerOptions) {
    this.mode = opts.mode;
    this.prompt = opts.prompt;
    this.onDecision =
      opts.onDecision ??
      (() => {
        /* no-op by default */
      });
  }

  /** The current mode. */
  public getMode(): PermissionMode {
    return this.mode;
  }

  /** Change mode at runtime (e.g. user toggles via a future command). */
  public setMode(mode: PermissionMode): void {
    this.mode = mode;
  }


  // ----------------------------------------------------------------
  // File operations
  // ----------------------------------------------------------------

  public async checkFileOp(op: FileOp, filePath: string): Promise<Decision> {
    const summary = `file ${op}: ${filePath}`;

    if (this.mode === "all-allowed") {
      return this.finish({ kind: "file", fileOp: op, filePath, summary }, "allow");
    }

    // ask-every-time
    const allow = await this.safePrompt({
      kind: "file",
      fileOp: op,
      filePath,
      summary,
    });
    return this.finish(
      { kind: "file", fileOp: op, filePath, summary },
      allow ? "allow" : "deny"
    );
  }


  // ----------------------------------------------------------------
  // Terminal commands
  // ----------------------------------------------------------------

  public async checkTerminal(command: string): Promise<Decision> {
    const danger = classifyCommand(command);
    const summary = `terminal: ${command}`;
    const req: PermissionRequest = { kind: "terminal", command, danger, summary };

    // Dangerous commands ALWAYS prompt, regardless of mode.
    if (danger.level === "dangerous") {
      const allow = await this.safePrompt(req);
      return this.finish(req, allow ? "allow" : "deny");
    }

    if (this.mode === "all-allowed") {
      return this.finish(req, "allow");
    }

    // ask-every-time (for caution/safe commands too)
    const allow = await this.safePrompt(req);
    return this.finish(req, allow ? "allow" : "deny");
  }


  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private async safePrompt(req: PermissionRequest): Promise<boolean> {
    try {
      const answer = await this.prompt(req);
      return answer === true;
    } catch {
      // A failing prompt is a deny — fail closed, never open.
      return false;
    }
  }

  private finish(req: PermissionRequest, decision: Decision): Decision {
    try {
      this.onDecision(req, decision);
    } catch {
      /* logging must never break the decision path */
    }
    return decision;
  }
}


// ------------------------------------------------------------------
// Convenience helpers
// ------------------------------------------------------------------

/** Danger level for a command, in one call. */
export function commandDangerLevel(command: string): DangerLevel {
  return classifyCommand(command).level;
}

/** True if this command would always prompt (even in all-allowed mode). */
export function alwaysPrompts(command: string): boolean {
  return classifyCommand(command).level === "dangerous";
}