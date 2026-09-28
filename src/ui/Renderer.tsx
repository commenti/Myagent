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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useInput } from "ink";

import { InputBox } from "./InputBox";
import {
  ActivityStream,
  type ActivityCounters,
  type ActivityItem,
} from "./ActivityStream";
import type { SlashCommand } from "./SlashCommandMenu";
import {
  ApiForm,
  type ApiFormValues,
  type ApiFormSubmitResult,
} from "./ApiForm";

import type { HomeConfig } from "../config/HomeConfig";
import type { ProjectConfig } from "../config/ProjectConfig";
import type { ResumeState } from "../session/ResumeManager";
import { SessionLog } from "../session/SessionLog";
import { PermissionManager } from "../policy/PermissionManager";

import { saveAndActivate } from "../commands/apiCommand";
import { InstructionScopeMenu, type InstructionScope } from "./InstructionScopeMenu";
import { InstructionEditor } from "./InstructionEditor";
import {
  loadInstructions,
  setGlobalInstructions,
  setProjectInstructions,
} from "../memory/InstructionLoader";
import {
  getSessionInstructions,
  setSessionInstructions,
} from "../memory/SessionInstructions";

// Slash command handlers.
import { run as runApi } from "../commands/apiCommand";
import { run as runInstruction } from "../commands/instructionCommand";
import { run as runSkills } from "../commands/skillsCommand";
import { run as runEffort } from "../commands/effortCommand";
import { run as runPlan } from "../commands/planCommand";
import { run as runUndo } from "../commands/undoCommand";
import { run as runCost } from "../commands/costCommand";

// ------------------------------------------------------------------
// Shared command context
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
  readonly onUserMessage?: (
    text: string,
    emit: (item: ActivityItem) => void
  ) => Promise<void>;

  /** Optional exit hook. Called just before Ink unmounts. */
  readonly onExit?: () => void;
}

// ------------------------------------------------------------------
// Slash command catalogue
// ------------------------------------------------------------------

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "api",
    description: "add or switch API profile",
    usage: "/api <baseUrl> <key> <model>",
  },
  {
    name: "instruction",
    description: "edit custom instructions",
    usage: "/instruction [global|project]",
  },
  {
    name: "skills",
    description: "list or add skills",
    usage: "/skills [add <path>]",
  },
  {
    name: "effort",
    description: "set effort level",
    usage: "/effort low|medium|high",
  },
  {
    name: "plan",
    description: "show the current plan",
    usage: "/plan",
  },
  {
    name: "undo",
    description: "rollback the last checkpoint",
    usage: "/undo",
  },
  {
    name: "cost",
    description: "show token usage and cost",
    usage: "/cost",
  },
  {
    name: "verbose",
    description: "toggle verbose activity display",
    usage: "/verbose",
  },
  {
    name: "exit",
    description: "quit agent-cli",
    usage: "/exit",
  },
];

// ------------------------------------------------------------------
// Renderer
// ------------------------------------------------------------------

export function Renderer(
  props: RendererProps
): React.ReactElement {
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

  const [verbose, setVerbose] =
    useState<boolean>(verboseProp);

  const [busy, setBusy] =
    useState<boolean>(false);

  const [statusLine, setStatusLine] =
    useState<string>(
      resumeState
        ? resumeState.summary
        : "ready"
    );

  const [items, setItems] =
    useState<ActivityItem[]>([]);

  const [counters, setCounters] =
    useState<ActivityCounters>({
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 0,
    });

  // Interactive /api form state.
  const [showApiForm, setShowApiForm] =
    useState<boolean>(false);

  type InstructionPhase = "none" | "scope" | "editor";
  const [instrPhase, setInstrPhase] = useState<InstructionPhase>("none");
  const [instrScope, setInstrScope] = useState<InstructionScope | null>(null);
  const [instrInitial, setInstrInitial] = useState<string>("");

  const startedAtRef =
    useRef<number>(Date.now());

  const sessionLogRef =
    useRef<SessionLog | null>(null);

  const permissionRef =
    useRef<PermissionManager | null>(null);

  // ----------------------------------------------------------------
  // Activity helpers
  // ----------------------------------------------------------------

  const pushItem = useCallback(
    (item: ActivityItem) => {
      setItems((prev) => {
        const next = [...prev, item];

        // Bound memory; the ActivityStream hides old ones anyway.
        if (next.length > 200) {
          return next.slice(next.length - 200);
        }

        return next;
      });
    },
    []
  );

  // ----------------------------------------------------------------
  // Init: SessionLog + PermissionManager
  // ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const log =
          new SessionLog(
            projectConfig.paths
          );

        await log.init();

        if (cancelled) return;

        sessionLogRef.current = log;
      } catch (err) {
        pushItem({
          type: "error",
          text:
            `session log init failed: ` +
            `${
              err instanceof Error
                ? err.message
                : String(err)
            }`,
        });
      }

      // Permission manager — for now, mode comes from ProjectConfig.
      // If it's null (first run), we defer to "ask-every-time".
      try {
        const mode =
          projectConfig.permission ??
          "ask-every-time";

        permissionRef.current =
          new PermissionManager({
            mode,
            prompt: async (req) => {
              // A real prompt requires an overlay input; for now, deny
              // and surface the reason so the user can switch mode explicitly.
              pushItem({
                type: "note",
                text:
                  `permission requested (${req.summary}) ` +
                  `— current mode is "${mode}"`,
              });

              return mode === "all-allowed";
            },
          });
      } catch (err) {
        pushItem({
          type: "error",
          text:
            `permission manager init failed: ` +
            `${
              err instanceof Error
                ? err.message
                : String(err)
            }`,
        });
      }
    })();

    return () => {
      cancelled = true;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------------------------------------------------------------
  // Counters ticker (elapsed time)
  // ----------------------------------------------------------------

  useEffect(() => {
    if (!busy) return;

    const id = setInterval(() => {
      setCounters((c) => ({
        ...c,
        elapsedMs:
          Date.now() -
          startedAtRef.current,
      }));
    }, 500);

    return () => clearInterval(id);
  }, [busy]);

  // ----------------------------------------------------------------
  // Resume banner (dismiss on first input)
  // ----------------------------------------------------------------

  const [resumeShown, setResumeShown] =
    useState<boolean>(
      resumeState !== null
    );

  // ----------------------------------------------------------------
  // Shared command context
  // ----------------------------------------------------------------

  const makeContext =
    useCallback(
      (): CommandContext => ({
        cwd,
        homeConfig,
        projectConfig,
        verbose,
        emit: pushItem,
        setStatus: setStatusLine,
      }),
      [
        cwd,
        homeConfig,
        projectConfig,
        verbose,
        pushItem,
      ]
    );

  // ----------------------------------------------------------------
  // Slash command dispatch
  // ----------------------------------------------------------------

  const dispatchSlash =
    useCallback(
      async (
        name: string,
        args: string
      ): Promise<void> => {
        // Built-in command: /exit
        if (name === "exit") {
          if (onExit) {
            onExit();
          }

          exit();
          return;
        }

        // Built-in command: /verbose
        if (name === "verbose") {
          setVerbose((v) => !v);

          pushItem({
            type: "note",
            text:
              `verbose ${
                verbose ? "off" : "on"
              }`,
          });

          return;
        }

        // /instruction with no args → scope menu + editor.
        if (name === "instruction" && args.trim() === "") {
          setInstrPhase("scope");
          return;
        }

        // ----------------------------------------------------------
        // Interactive /api form
        // ----------------------------------------------------------
        // /api with no args opens the interactive form.
        // /api with arguments continues to use the normal command parser.
        if (
          name === "api" &&
          args.trim() === ""
        ) {
          setShowApiForm(true);
          return;
        }

        setBusy(true);
        startedAtRef.current =
          Date.now();

        pushItem({
          type: "tool-call",
          name: "/" + name,
          args,
        });

        try {
          const ctx =
            makeContext();

          let result: string;

          switch (name) {
            case "api":
              result =
                await runApi(
                  ctx,
                  args
                );
              break;

            case "instruction":
              result =
                await runInstruction(
                  ctx,
                  args
                );
              break;

            case "skills":
              result =
                await runSkills(
                  ctx,
                  args
                );
              break;

            case "effort":
              result =
                await runEffort(
                  ctx,
                  args
                );
              break;

            case "plan":
              result =
                await runPlan(
                  ctx,
                  args
                );
              break;

            case "undo":
              result =
                await runUndo(
                  ctx,
                  args
                );
              break;

            case "cost":
              result =
                await runCost(
                  ctx,
                  args
                );
              break;

            default:
              result =
                `unknown command: /${name}`;
          }

          pushItem({
            type: "tool-result",
            name: "/" + name,
            ok: true,
            summary: result,
          });

          setStatusLine(result);
        } catch (err) {
          pushItem({
            type: "error",
            text:
              `/${name} failed: ` +
              `${
                err instanceof Error
                  ? err.message
                  : String(err)
              }`,
          });
        } finally {
          setBusy(false);
        }
      },
      [
        makeContext,
        pushItem,
        verbose,
        exit,
        onExit,
      ]
    );

  // ----------------------------------------------------------------
  // Plain message dispatch
  // ----------------------------------------------------------------

  const dispatchMessage =
    useCallback(
      async (
        text: string
      ): Promise<void> => {
        if (resumeShown) {
          setResumeShown(false);
        }

        setBusy(true);
        startedAtRef.current =
          Date.now();

        pushItem({
          type: "tool-call",
          name: "user",
          args: text.slice(0, 160),
        });

        // Best-effort: log the user message into the session.
        try {
          const log =
            sessionLogRef.current;

          if (log) {
            await log.append({
              kind: "user",
              text,
            });
          }
        } catch {
          // non-fatal
        }

        try {
          if (onUserMessage) {
            await onUserMessage(
              text,
              pushItem
            );
          } else {
            pushItem({
              type: "note",
              text:
                "agent loop is not yet wired in this build — " +
                "the message was logged to the session, " +
                "but no model call was made.",
            });
          }

          setStatusLine("ready");
        } catch (err) {
          pushItem({
            type: "error",
            text:
              err instanceof Error
                ? err.message
                : String(err),
          });
        } finally {
          setBusy(false);
        }
      },
      [
        onUserMessage,
        pushItem,
        resumeShown,
      ]
    );

  // ----------------------------------------------------------------
  // Slash command from InputBox
  // ----------------------------------------------------------------

  const handleSlashCommand =
    useCallback(
      (
        name: string,
        args: string
      ) => {
        void dispatchSlash(
          name,
          args
        );
      },
      [dispatchSlash]
    );

  // ----------------------------------------------------------------
  // Plain input submit
  // ----------------------------------------------------------------

  const handleSubmit =
    useCallback(
      (text: string) => {
        void dispatchMessage(text);
      },
      [dispatchMessage]
    );

  // ----------------------------------------------------------------
  // Interactive /api form submit
  // ----------------------------------------------------------------

  const handleApiFormSubmit =
    useCallback(
      async (
        values: ApiFormValues
      ): Promise<ApiFormSubmitResult> => {
        const ctx =
          makeContext();

        const result =
          await saveAndActivate(
            ctx,
            values.baseUrl,
            values.apiKey,
            values.model
          );

        if (result.ok) {
          return {
            ok: true,
            summary:
              "connected: " +
              result.profileId +
              " (" +
              result.protocol +
              ")",
          };
        }

        return {
          ok: false,
          error: result.error,
        };
      },
      [makeContext]
    );

  const handleInstructionScopePick = useCallback(
    async (scope: InstructionScope) => {
      setInstrScope(scope);
      try {
        if (scope === "session") {
          setInstrInitial(getSessionInstructions());
        } else {
          const bundle = await loadInstructions(homeConfig, projectConfig);
          setInstrInitial(scope === "global" ? bundle.global : bundle.project);
        }
      } catch (err) {
        pushItem({
          type: "error",
          text:
            "failed to load instructions: " +
            (err instanceof Error ? err.message : String(err)),
        });
        setInstrInitial("");
      }
      setInstrPhase("editor");
    },
    [homeConfig, projectConfig, pushItem]
  );

  const handleInstructionSave = useCallback(
    async (text: string) => {
      const scope = instrScope;
      if (!scope) return;
      try {
        if (scope === "session") {
          setSessionInstructions(text);
        } else if (scope === "project") {
          await setProjectInstructions(projectConfig, text);
        } else {
          await setGlobalInstructions(homeConfig, text);
        }
        pushItem({
          type: "tool-result",
          name: "/instruction",
          ok: true,
          summary:
            "saved " + scope + " instructions (" + text.length + " chars)",
        });
        setStatusLine("instructions saved (" + scope + ")");
      } catch (err) {
        pushItem({
          type: "error",
          text:
            "failed to save instructions: " +
            (err instanceof Error ? err.message : String(err)),
        });
        return;
      }
      setInstrPhase("none");
      setInstrScope(null);
      setInstrInitial("");
    },
    [instrScope, homeConfig, projectConfig, pushItem]
  );

  const handleInstructionCancel = useCallback(() => {
    setInstrPhase("none");
    setInstrScope(null);
    setInstrInitial("");
    pushItem({ type: "note", text: "instruction editor closed without saving" });
  }, [pushItem]);

  // ----------------------------------------------------------------
  // Ctrl+C — Ink handles exit; we just log
  // ----------------------------------------------------------------

  useInput(
    (input, key) => {
      if (
        key.ctrl &&
        (input === "c" ||
          input === "C")
      ) {
        if (onExit) {
          onExit();
        }

        exit();
      }
    },
    {
      isActive: true,
    }
  );

  // ----------------------------------------------------------------
  // Layout
  // ----------------------------------------------------------------

  const slashCommands =
    useMemo(
      () => SLASH_COMMANDS,
      []
    );

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={0}
    >
      {/* Header line */}
      <Box>
        <Text color="cyan" bold>
          {"agent-cli"}
        </Text>

        <Text
          color="gray"
          dimColor
        >
          {"  cwd: "}
        </Text>

        <Text
          color="gray"
          dimColor
        >
          {cwd}
        </Text>
      </Box>

      <Box>
        <Text
          color="gray"
          dimColor
        >
          {"status: "}
        </Text>

        <Text
          color={
            busy
              ? "cyan"
              : "green"
          }
        >
          {busy
            ? "busy"
            : statusLine}
        </Text>
      </Box>

      {/* Resume banner */}
      {resumeShown &&
        resumeState && (
          <Box
            flexDirection="column"
            marginTop={1}
          >
            <Box>
              <Text
                color="yellow"
                bold
              >
                {"resume available"}
              </Text>
            </Box>

            <Box>
              <Text color="yellow">
                {resumeState.summary}
              </Text>
            </Box>

            <Box>
              <Text
                color="gray"
                dimColor
              >
                {
                  "(type anything to continue, or press Esc to dismiss)"
                }
              </Text>
            </Box>
          </Box>
        )}

      {/* Activity stream */}
      <Box
        flexDirection="column"
        marginTop={1}
      >
        <ActivityStream
          items={items}
          busy={busy}
          verbose={verbose}
          counters={counters}
        />
      </Box>

      {/* Input box or interactive /api form */}
      <Box
        flexDirection="column"
        marginTop={1}
      >
        {instrPhase === "scope" ? (
          <InstructionScopeMenu
            onPick={(scope) => { void handleInstructionScopePick(scope); }}
            onCancel={handleInstructionCancel}
          />
        ) : instrPhase === "editor" && instrScope ? (
          <InstructionEditor
            title={"Edit " + instrScope + " instructions"}
            initialText={instrInitial}
            onSave={(text) => { void handleInstructionSave(text); }}
            onCancel={handleInstructionCancel}
          />
        ) : showApiForm ? (
          <ApiForm
            onSubmit={
              handleApiFormSubmit
            }
            onCancel={() => {
              setShowApiForm(false);

              pushItem({
                type: "note",
                text:
                  "api form cancelled",
              });
            }}
            onSaved={(summary) => {
              setShowApiForm(false);

              pushItem({
                type: "tool-result",
                name: "/api",
                ok: true,
                summary,
              });

              setStatusLine(
                summary
              );
            }}
          />
        ) : (
          <InputBox
            onSubmit={handleSubmit}
            onSlashCommand={
              handleSlashCommand
            }
            slashCommands={
              slashCommands
            }
            disabled={busy}
            placeholder={
              busy
                ? "working — input is paused"
                : 'Type a message. "/" for commands. Enter to send.'
            }
          />
        )}
      </Box>
    </Box>
  );
}