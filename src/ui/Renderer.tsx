/**
 * src/ui/Renderer.tsx
 * -------------------
 * Root TUI component. Wires the three UI pieces together and owns all of
 * the session-lifetime state that the UI needs:
 *
 *   • the activity list + counters
 *   • the slash-command list
 *   • the current turn (busy or idle)
 *   • the session log handle (for /plan, /undo, and turn bookkeeping)
 *
 * Responsibilities:
 *   • Draw ActivityStream + InputBox (+ an optional resume banner).
 *   • Dispatch slash commands to the modules in src/commands/*.
 *   • Handle plain user messages: log them, and hand them to the turn
 *     runner (passed via props.onUserMessage) — or, when that prop is not
 *     supplied, show a clear "not yet wired" note instead of pretending.
 *   • Handle Ctrl+C cleanly (Ink already handles it; we just log).
 *
 * Everything the user sees is English only.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { InputBox } from "./InputBox";
import {
  ActivityStream,
  type ActivityCounters,
  type ActivityItem,
} from "./ActivityStream";
import type { SlashCommand } from "./SlashCommandMenu";

import type { HomeConfig } from "../config/HomeConfig";
import type { ProjectConfig } from "../config/ProjectConfig";
import type { ResumeState } from "../session/ResumeManager";
import { SessionLog } from "../session/SessionLog";
import { PermissionManager } from "../policy/PermissionManager";

// Slash command handlers. These modules will exist with exactly this export
// shape once their files are written; the paths and names follow MEMORY.md.
import { run as runApi } from "../commands/apiCommand";
import { run as runInstruction } from "../commands/instructionCommand";
import { run as runSkills } from "../commands/skillsCommand";
import { run as runEffort } from "../commands/effortCommand";
import { run as runPlan } from "../commands/planCommand";
import { run as runUndo } from "../commands/undoCommand";
import { run as runCost } from "../commands/costCommand";


// ------------------------------------------------------------------
// Shared command context (imported by each commands/* module as a type)
// ------------------------------------------------------------------

export interface CommandContext {
  readonly cwd: string;
  readonly homeConfig: HomeConfig;
  readonly projectConfig: ProjectConfig;
  readonly verbose: boolean;
  /** Emit an activity item (always safe; never throws). */
  readonly emit: (item: ActivityItem) => void;
  /** English one-line status for the banner. */
  readonly setStatus: (line: string) => void;
}


// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface RendererProps {
  readonly homeConfig: HomeConfig;
  readonly projectConfig: ProjectConfig;
  readonly cwd: string;
  readonly resumeState: ResumeState | null;
  readonly verbose: boolean;
  /**
   * Optional turn runner. When provided, plain user messages are passed to
   * it. When omitted, Renderer logs the message and shows a clear note
   * (no silent failure).
   */
  readonly onUserMessage?: (text: string, emit: (item: ActivityItem) => void) => Promise<void>;
  /** Optional exit hook. Called just before Ink unmounts. */
  readonly onExit?: () => void;
}


// ------------------------------------------------------------------
// Slash command catalogue
// ------------------------------------------------------------------

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "api",         description: "add or switch API profile",       usage: "/api <baseUrl> <key> <model>" },
  { name: "instruction", description: "edit custom instructions",        usage: "/instruction [global|project]" },
  { name: "skills",      description: "list or add skills",              usage: "/skills [add <path>]" },
  { name: "effort",      description: "set effort level",                usage: "/effort low|medium|high" },
  { name: "plan",        description: "show the current plan",           usage: "/plan" },
  { name: "undo",        description: "rollback the last checkpoint",    usage: "/undo" },
  { name: "cost",        description: "show token usage and cost",       usage: "/cost" },
  { name: "verbose",     description: "toggle verbose activity display", usage: "/verbose" },
  { name: "exit",        description: "quit agent-cli",                  usage: "/exit" },
];


// ------------------------------------------------------------------
// Renderer
// ------------------------------------------------------------------

export function Renderer(props: RendererProps): React.ReactElement {
  const {
    homeConfig,
    projectConfig,
    cwd,
    resumeState,
    verbose: verboseProp,
    onUserMessage,
    onExit,
  } = props;

  const { exit } = useApp();

  const [verbose, setVerbose] = useState<boolean>(verboseProp);
  const [busy, setBusy] = useState<boolean>(false);
  const [statusLine, setStatusLine] = useState<string>(
    resumeState ? resumeState.summary : "ready"
  );
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [counters, setCounters] = useState<ActivityCounters>({
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
  });

  const startedAtRef = useRef<number>(Date.now());
  const sessionLogRef = useRef<SessionLog | null>(null);
  const permissionRef = useRef<PermissionManager | null>(null);

  // ----------------------------------------------------------------
  // Init: SessionLog + PermissionManager
  // ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const log = new SessionLog(projectConfig.paths);
        await log.init();
        if (cancelled) return;
        sessionLogRef.current = log;
      } catch (err) {
        pushItem({
          type: "error",
          text: `session log init failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Permission manager — for now, mode comes from ProjectConfig.
      // If it's null (first run), we defer to "ask-every-time" and let
      // an interactive prompt land in a future command. This keeps Renderer
      // honest: it never silently allows writes.
      try {
        const mode = projectConfig.permission ?? "ask-every-time";
        permissionRef.current = new PermissionManager({
          mode,
          prompt: async (req) => {
            // A real prompt requires an overlay input; for now, deny and
            // surface the reason so the user can switch mode explicitly.
            pushItem({
              type: "note",
              text: `permission requested (${req.summary}) — current mode is "${mode}"`,
            });
            return mode === "all-allowed";
          },
        });
      } catch (err) {
        pushItem({
          type: "error",
          text: `permission manager init failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------------------------------------------------------------
  // Counters ticker (elapsed time)
  // ----------------------------------------------------------------

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      setCounters((c) => ({ ...c, elapsedMs: Date.now() - startedAtRef.current }));
    }, 500);
    return () => clearInterval(id);
  }, [busy]);

  // ----------------------------------------------------------------
  // Activity helpers
  // ----------------------------------------------------------------

  const pushItem = useCallback((item: ActivityItem) => {
    setItems((prev) => {
      const next = [...prev, item];
      // Bound memory; the ActivityStream hides old ones anyway.
      if (next.length > 200) return next.slice(next.length - 200);
      return next;
    });
  }, []);

  // ----------------------------------------------------------------
  // Resume banner (dismiss on first input)
  // ----------------------------------------------------------------

  const [resumeShown, setResumeShown] = useState<boolean>(resumeState !== null);

  // ----------------------------------------------------------------
  // Slash command dispatch
  // ----------------------------------------------------------------

  const makeContext = useCallback((): CommandContext => ({
    cwd,
    homeConfig,
    projectConfig,
    verbose,
    emit: pushItem,
    setStatus: setStatusLine,
  }), [cwd, homeConfig, projectConfig, verbose, pushItem]);

  const dispatchSlash = useCallback(
    async (name: string, args: string): Promise<void> => {
      // Built-in commands handled directly.
      if (name === "exit") {
        if (onExit) onExit();
        exit();
        return;
      }
      if (name === "verbose") {
        setVerbose((v) => !v);
        pushItem({ type: "note", text: `verbose ${verbose ? "off" : "on"}` });
        return;
      }

      setBusy(true);
      startedAtRef.current = Date.now();
      pushItem({ type: "tool-call", name: "/" + name, args });

      try {
        const ctx = makeContext();
        let result: string;
        switch (name) {
          case "api":         result = await runApi(ctx, args); break;
          case "instruction": result = await runInstruction(ctx, args); break;
          case "skills":      result = await runSkills(ctx, args); break;
          case "effort":      result = await runEffort(ctx, args); break;
          case "plan":        result = await runPlan(ctx, args); break;
          case "undo":        result = await runUndo(ctx, args); break;
          case "cost":        result = await runCost(ctx, args); break;
          default:
            result = `unknown command: /${name}`;
        }
        pushItem({ type: "tool-result", name: "/" + name, ok: true, summary: result });
        setStatusLine(result);
      } catch (err) {
        pushItem({
          type: "error",
          text: `/${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setBusy(false);
      }
    },
    [makeContext, pushItem, verbose, exit, onExit]
  );

  // ----------------------------------------------------------------
  // Plain message dispatch
  // ----------------------------------------------------------------

  const dispatchMessage = useCallback(
    async (text: string): Promise<void> => {
      if (resumeShown) setResumeShown(false);

      setBusy(true);
      startedAtRef.current = Date.now();

      pushItem({ type: "tool-call", name: "user", args: text.slice(0, 160) });

      // Best-effort: log the user message into the session.
      try {
        const log = sessionLogRef.current;
        if (log) await log.append({ kind: "user", text });
      } catch { /* non-fatal */ }

      try {
        if (onUserMessage) {
          await onUserMessage(text, pushItem);
        } else {
          pushItem({
            type: "note",
            text:
              "agent loop is not yet wired in this build — " +
              "the message was logged to the session, but no model call was made.",
          });
        }
        setStatusLine("ready");
      } catch (err) {
        pushItem({
          type: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusy(false);
      }
    },
    [onUserMessage, pushItem, resumeShown]
  );

  // ----------------------------------------------------------------
  // Slash command from InputBox
  // ----------------------------------------------------------------

  const handleSlashCommand = useCallback(
    (name: string, args: string) => {
      void dispatchSlash(name, args);
    },
    [dispatchSlash]
  );

  const handleSubmit = useCallback(
    (text: string) => {
      void dispatchMessage(text);
    },
    [dispatchMessage]
  );

  // ----------------------------------------------------------------
  // Ctrl+C — Ink handles exit; we just log
  // ----------------------------------------------------------------

  useInput(
    (input, key) => {
      if (key.ctrl && (input === "c" || input === "C")) {
        if (onExit) onExit();
        exit();
      }
    },
    { isActive: true }
  );

  // ----------------------------------------------------------------
  // Layout
  // ----------------------------------------------------------------

  const slashCommands = useMemo(() => SLASH_COMMANDS, []);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Header line */}
      <Box>
        <Text color="cyan" bold>{"agent-cli"}</Text>
        <Text color="gray" dimColor>
          {"  cwd: "}
        </Text>
        <Text color="gray" dimColor>{cwd}</Text>
      </Box>
      <Box>
        <Text color="gray" dimColor>
          {"status: "}
        </Text>
        <Text color={busy ? "cyan" : "green"}>{busy ? "busy" : statusLine}</Text>
      </Box>

      {/* Resume banner */}
      {resumeShown && resumeState && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="yellow" bold>{"resume available"}</Text>
          </Box>
          <Box>
            <Text color="yellow">{resumeState.summary}</Text>
          </Box>
          <Box>
            <Text color="gray" dimColor>
              {"(type anything to continue, or press Esc to dismiss)"}
            </Text>
          </Box>
        </Box>
      )}

      {/* Activity stream */}
      <Box flexDirection="column" marginTop={1}>
        <ActivityStream
          items={items}
          busy={busy}
          verbose={verbose}
          counters={counters}
        />
      </Box>

      {/* Input box */}
      <Box flexDirection="column" marginTop={1}>
        <InputBox
          onSubmit={handleSubmit}
          onSlashCommand={handleSlashCommand}
          slashCommands={slashCommands}
          disabled={busy}
          placeholder={
            busy
              ? "working — input is paused"
              : "Type a message. \"/\" for commands. Enter to send."
          }
        />
      </Box>
    </Box>
  );
}