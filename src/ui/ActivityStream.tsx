/**
 * src/ui/ActivityStream.tsx
 * -------------------------
 * The live activity panel (ARCHITECTURE.md §12).
 *
 * Purely presentational: the Renderer owns the list of items and pushes
 * new ones in. This component decides how to draw each item and how many
 * to show.
 *
 * What it can render:
 *   - thinking          (spinner + optional label)
 *   - tool-call         (name + short args)
 *   - tool-result       (ok/fail + summary)
 *   - file-read         (path + line count)
 *   - file-edit         (path + diff preview lines)
 *   - terminal          (streamed chunk, last N lines)
 *   - note              (dim English line)
 *   - error             (red line)
 *   - counters          (tokens + elapsed time)
 *
 * No Hindi. No animations beyond a simple frame spinner.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text } from "ink";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type ActivityItem =
  | { readonly type: "thinking"; readonly label?: string }
  | { readonly type: "tool-call"; readonly name: string; readonly args?: string }
  | { readonly type: "tool-result"; readonly name: string; readonly ok: boolean; readonly summary: string }
  | { readonly type: "file-read"; readonly path: string; readonly lines: number }
  | { readonly type: "file-edit"; readonly path: string; readonly preview: string; readonly added: number; readonly removed: number }
  | { readonly type: "terminal"; readonly chunk: string }
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "user-message"; readonly text: string }
  | { readonly type: "assistant-message"; readonly text: string }
  | { readonly type: "error"; readonly text: string };

export interface ActivityCounters {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly elapsedMs: number;
}

export interface ActivityStreamProps {
  readonly items: readonly ActivityItem[];
  readonly busy?: boolean;
  readonly verbose?: boolean;
  /** Max visible items (default 12, verbose raises to 30). */
  readonly maxVisible?: number;
  readonly counters?: ActivityCounters;
  /**
   * Text currently being streamed by the model (not yet committed). Shown in
   * the live area, last few lines only. When streaming finishes, the caller
   * should push a committed `assistant-message` item to `items` and clear
   * this prop — the full text then lands in <Static> and stays in scrollback.
   */
  readonly liveText?: string;
}

interface Config {
  readonly maxVisible: number;
  readonly maxTerminalLines: number;
  readonly maxPreviewLines: number;
}

const DEFAULT_CONFIG: Config = {
  maxVisible: 12,
  maxTerminalLines: 6,
  maxPreviewLines: 6,
};

const VERBOSE_CONFIG: Config = {
  maxVisible: 30,
  maxTerminalLines: 20,
  maxPreviewLines: 14,
};


// ------------------------------------------------------------------
// Spinner
// ------------------------------------------------------------------

const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;

// ------------------------------------------------------------------
// Color policy
// ------------------------------------------------------------------
// Respect NO_COLOR (https://no-color.org). All color props go through col().
// Bright variants everywhere so text is readable on a black terminal.
// Dark blue / dark red are never used.
// ------------------------------------------------------------------

const NO_COLOR: boolean =
  typeof process.env.NO_COLOR === "string" && process.env.NO_COLOR.length > 0;

function col(name: string): string | undefined {
  return NO_COLOR ? undefined : name;
}

function dim(d = true): boolean {
  return NO_COLOR ? false : d;
}


function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 120);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[frame];
}


// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

const LIVE_MAX_LINES = 8;

export function ActivityStream(props: ActivityStreamProps): React.ReactElement {
  const { items, busy = false, verbose = false, counters, liveText } = props;

  const cfg = verbose ? VERBOSE_CONFIG : DEFAULT_CONFIG;
  const spinner = useSpinner(busy);

  // Committed items → <Static>. Each is printed once and stays in the
  // terminal's scrollback.
  const committed = useMemo(() => [...items], [items]);

  // Live streaming text — last few lines only.
  const liveLines = useMemo(
    () => (liveText ? liveText.split("\n") : []),
    [liveText]
  );
  const liveShown = liveLines.slice(-LIVE_MAX_LINES);
  const liveHidden = Math.max(0, liveLines.length - liveShown.length);

  return (
    <Box flexDirection="column">
      {/* Completed items: printed once, persist in scrollback. */}
      <Static items={committed}>
        {(item, key) => <Item key={key} item={item} cfg={cfg} />}
      </Static>

      {/* Live streaming response (last few lines). */}
      {liveShown.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {liveHidden > 0 && (
            <Text color={col("gray")} dimColor={dim()}>
              {"... " + liveHidden + " earlier line(s) streaming ..."}
            </Text>
          )}
          {liveShown.map((line, i) => (
            <Text key={i} color={col("whiteBright")}>
              {line.length === 0 ? " " : line}
            </Text>
          ))}
        </Box>
      )}

      {/* Live status line: spinner + counters. Never grows. */}
      <Box paddingX={1}>
        <Text color={col("gray")} dimColor={dim()}>
          {busy ? spinner + " working" : "- idle"}
        </Text>
        {counters && (
          <Text color={col("gray")} dimColor={dim()}>
            {`   tokens: ${formatTokens(counters.inputTokens)} in / ${formatTokens(counters.outputTokens)} out   ${formatElapsed(counters.elapsedMs)}`}
          </Text>
        )}
      </Box>
    </Box>
  );
}


// ------------------------------------------------------------------
// Item renderer
// ------------------------------------------------------------------

interface ItemProps {
  readonly item: ActivityItem;
  readonly cfg: Config;
}

function Item(props: ItemProps): React.ReactElement {
  const { item, cfg } = props;

  switch (item.type) {
    case "user-message":
      return (
        <Box paddingX={1} flexDirection="column">
          <Text>
            <Text color={col("greenBright")} bold>{"> "}</Text>
            <Text color={col("greenBright")}>{clip(item.text, 4000)}</Text>
          </Text>
        </Box>
      );

    case "assistant-message":
      return (
        <Box paddingX={1} flexDirection="column">
          <Text>
            <Text color={col("cyan")} bold>{"< "}</Text>
            <Text color={col("whiteBright")}>{clip(item.text, 8000)}</Text>
          </Text>
        </Box>
      );

    case "thinking":
      return (
        <Box paddingX={1}>
          <Text color={col("cyan")}>{"~ "}</Text>
          <Text color={col("cyan")} dimColor={dim()}>
            {item.label && item.label.length > 0 ? item.label : "thinking..."}
          </Text>
        </Box>
      );

    case "tool-call":
      // Legacy: Renderer sometimes emits the user message as
      // { type: "tool-call", name: "user", args: text }. Route it.
      if (item.name === "user") {
        return (
          <Box paddingX={1} flexDirection="column">
            <Text>
              <Text color={col("greenBright")} bold>{"> "}</Text>
              <Text color={col("greenBright")}>{clip(item.args ?? "", 4000)}</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box paddingX={1} flexDirection="column">
          <Text>
            <Text color={col("cyan")} bold>{"-> "}</Text>
            <Text color={col("cyan")} bold>{item.name}</Text>
            {item.args && item.args.length > 0 ? (
              <Text color={col("gray")} dimColor={dim()}>
                {"  " + clip(item.args, 200)}
              </Text>
            ) : null}
          </Text>
        </Box>
      );

    case "tool-result":
      return (
        <Box paddingX={1} flexDirection="column">
          <Text>
            <Text color={col(item.ok ? "greenBright" : "redBright")}>
              {item.ok ? "<- ok  " : "<- fail"}
            </Text>
            <Text color={col("cyan")} bold>{item.name}</Text>
            <Text color={col("gray")} dimColor={dim()}>
              {"  " + clip(item.summary, 300)}
            </Text>
          </Text>
        </Box>
      );

    case "file-read":
      return (
        <Box paddingX={1}>
          <Text color={col("cyan")}>{"   read  "}</Text>
          <Text color={col("whiteBright")}>{item.path}</Text>
          <Text color={col("gray")} dimColor={dim()}>
            {`  (${item.lines} line${item.lines === 1 ? "" : "s"})`}
          </Text>
        </Box>
      );

    case "file-edit":
      return <FileEdit item={item} cfg={cfg} />;

    case "terminal":
      return <TerminalBlock chunk={item.chunk} cfg={cfg} />;

    case "note":
      return (
        <Box paddingX={1}>
          <Text color={col("gray")} dimColor={dim()}>
            {"* " + clip(item.text, 400)}
          </Text>
        </Box>
      );

    case "error":
      return (
        <Box paddingX={1}>
          <Text color={col("redBright")} bold>
            {"! " + clip(item.text, 400)}
          </Text>
        </Box>
      );
  }
}


// ------------------------------------------------------------------
// Sub-renderers
// ------------------------------------------------------------------

function FileEdit(props: {
  readonly item: Extract<ActivityItem, { type: "file-edit" }>;
  readonly cfg: Config;
}): React.ReactElement {
  const { item, cfg } = props;
  const lines = item.preview.split("\n").slice(0, cfg.maxPreviewLines);

  return (
    <Box paddingX={1} flexDirection="column">
      <Box>
        <Text color={col("cyan")}>{"   edit  "}</Text>
        <Text color={col("whiteBright")}>{item.path}</Text>
        <Text color={col("greenBright")}>{`  +${item.added}`}</Text>
        <Text color={col("redBright")}>{` -${item.removed}`}</Text>
      </Box>
      {lines.map((line, i) => {
        const base = line.startsWith("+ ")
          ? "greenBright"
          : line.startsWith("- ")
          ? "redBright"
          : "gray";
        const color = col(base);
        const isDim = base === "gray";
        return (
          <Box key={i} marginLeft={4}>
            <Text color={color} dimColor={isDim ? dim() : false}>
              {clip(line, 200)}
            </Text>
          </Box>
        );
      })}
      {item.preview.split("\n").length > cfg.maxPreviewLines && (
        <Box marginLeft={4}>
          <Text color={col("gray")} dimColor={dim()}>
            ... (preview truncated)
          </Text>
        </Box>
      )}
    </Box>
  );
}

function TerminalBlock(props: {
  readonly chunk: string;
  readonly cfg: Config;
}): React.ReactElement {
  const { chunk, cfg } = props;
  const allLines = chunk.replace(/\r\n/g, "\n").split("\n");
  const tail = allLines.slice(-cfg.maxTerminalLines);

  return (
    <Box paddingX={1} flexDirection="column">
      <Text color={col("cyan")} dimColor={dim()}>
        {"   terminal"}
      </Text>
      {tail.map((line, i) => (
        <Box key={i} marginLeft={4}>
          <Text color={col("whiteBright")}>{clip(line, 300)}</Text>
        </Box>
      ))}
      {allLines.length > cfg.maxTerminalLines && (
        <Box marginLeft={4}>
          <Text color={col("gray")} dimColor={dim()}>
            {`... ${allLines.length - cfg.maxTerminalLines} earlier line(s) hidden`}
          </Text>
        </Box>
      )}
    </Box>
  );
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  return one.slice(0, n - 1) + "...";
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(2).replace(/\.00$/, "") + "M";
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}