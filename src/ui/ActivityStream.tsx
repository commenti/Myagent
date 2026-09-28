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
import { Box, Text } from "ink";


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

export function ActivityStream(props: ActivityStreamProps): React.ReactElement {
  const {
    items,
    busy = false,
    verbose = false,
    counters,
  } = props;

  const cfg = verbose ? VERBOSE_CONFIG : DEFAULT_CONFIG;
  const maxVisible = props.maxVisible ?? cfg.maxVisible;

  const spinner = useSpinner(busy);

  const visible = useMemo(() => {
    if (items.length <= maxVisible) return items;
    return items.slice(items.length - maxVisible);
  }, [items, maxVisible]);

  const hidden = items.length - visible.length;

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color="gray" dimColor>
          {busy ? spinner + " working" : "- idle"}
        </Text>
        {counters && (
          <Text color="gray" dimColor>
            {`   tokens: ${formatTokens(counters.inputTokens)} in / ${formatTokens(counters.outputTokens)} out   ${formatElapsed(counters.elapsedMs)}`}
          </Text>
        )}
      </Box>

      {hidden > 0 && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            {`... ${hidden} earlier item(s) hidden ...`}
          </Text>
        </Box>
      )}

      {visible.length === 0 ? (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            (no activity yet)
          </Text>
        </Box>
      ) : (
        visible.map((item, i) => (
          <Item key={i} item={item} cfg={cfg} />
        ))
      )}
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
    case "thinking":
      return (
        <Box paddingX={1}>
          <Text color="cyan">{"~ "}</Text>
          <Text color="cyan" dimColor>
            {item.label && item.label.length > 0 ? item.label : "thinking..."}
          </Text>
        </Box>
      );

    case "tool-call":
      return (
        <Box paddingX={1} flexDirection="column">
          <Text>
            <Text color="blue">{"-> "}</Text>
            <Text bold>{item.name}</Text>
            {item.args && item.args.length > 0 ? (
              <Text color="gray" dimColor>
                {"  " + clip(item.args, 160)}
              </Text>
            ) : null}
          </Text>
        </Box>
      );

    case "tool-result":
      return (
        <Box paddingX={1} flexDirection="column">
          <Text>
            <Text color={item.ok ? "green" : "red"}>
              {item.ok ? "<- ok  " : "<- fail"}
            </Text>
            <Text bold>{item.name}</Text>
            <Text color="gray" dimColor>
              {"  " + clip(item.summary, 200)}
            </Text>
          </Text>
        </Box>
      );

    case "file-read":
      return (
        <Box paddingX={1}>
          <Text color="gray">
            {"   read  "}
          </Text>
          <Text>{item.path}</Text>
          <Text color="gray" dimColor>
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
          <Text color="gray" dimColor>
            {"* " + clip(item.text, 300)}
          </Text>
        </Box>
      );

    case "error":
      return (
        <Box paddingX={1}>
          <Text color="red">{"! " + clip(item.text, 300)}</Text>
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
        <Text color="yellow">{"   edit  "}</Text>
        <Text>{item.path}</Text>
        <Text color="green">{`  +${item.added}`}</Text>
        <Text color="red">{` -${item.removed}`}</Text>
      </Box>
      {lines.map((line, i) => {
        const color = line.startsWith("+ ")
          ? "green"
          : line.startsWith("- ")
          ? "red"
          : "gray";
        const dim = color === "gray";
        return (
          <Box key={i} marginLeft={4}>
            <Text color={color} dimColor={dim}>
              {clip(line, 200)}
            </Text>
          </Box>
        );
      })}
      {item.preview.split("\n").length > cfg.maxPreviewLines && (
        <Box marginLeft={4}>
          <Text color="gray" dimColor>
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
      <Text color="gray" dimColor>
        {"   terminal"}
      </Text>
      {tail.map((line, i) => (
        <Box key={i} marginLeft={4}>
          <Text color="white">{clip(line, 300)}</Text>
        </Box>
      ))}
      {allLines.length > cfg.maxTerminalLines && (
        <Box marginLeft={4}>
          <Text color="gray" dimColor>
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