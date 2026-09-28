/**
 * src/ui/SlashCommandMenu.tsx
 * ---------------------------
 * The dropdown shown above the InputBox when the user types "/".
 *
 * Pure presentation + one helper (filterCommands). No state, no side effects.
 * The parent (InputBox) owns the query and the selected index.
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";


// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface SlashCommand {
  /** Command name WITHOUT the leading slash, e.g. "api". */
  readonly name: string;
  /** One-line English description shown next to the name. */
  readonly description: string;
  /** Optional usage hint, e.g. "/api <url> <key> <model>". */
  readonly usage?: string;
}

export interface SlashCommandMenuProps {
  /** All available commands. */
  readonly commands: readonly SlashCommand[];
  /** Text after "/" (may be ""). Case-insensitive match. */
  readonly query: string;
  /** Currently highlighted index (already clamped by the parent). */
  readonly selectedIndex: number;
}


// ------------------------------------------------------------------
// Filtering
// ------------------------------------------------------------------

/**
 * Filter commands by a prefix query. Empty query returns all commands.
 * Match is case-insensitive on the command name only.
 * Order is preserved as given by the caller.
 */
export function filterCommands(
  commands: readonly SlashCommand[],
  query: string
): readonly SlashCommand[] {
  if (!query || query.length === 0) return commands;
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}


// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function SlashCommandMenu(
  props: SlashCommandMenuProps
): React.ReactElement | null {
  const { commands, query, selectedIndex } = props;

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  if (filtered.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="yellow" dimColor>
          {`no command matches "/${query}"`}
        </Text>
      </Box>
    );
  }

  // Show up to MAX_VISIBLE rows; scroll a window around the selection.
  const MAX_VISIBLE = 8;
  const total = filtered.length;
  const clamped = Math.max(0, Math.min(total - 1, selectedIndex));

  let start = 0;
  if (total > MAX_VISIBLE) {
    const half = Math.floor(MAX_VISIBLE / 2);
    start = Math.max(0, Math.min(total - MAX_VISIBLE, clamped - half));
  }
  const end = Math.min(total, start + MAX_VISIBLE);
  const visible = filtered.slice(start, end);

  const hiddenAbove = start;
  const hiddenBelow = total - end;

  // Width for the name column so descriptions line up.
  let nameWidth = 0;
  for (const c of visible) {
    if (c.name.length > nameWidth) nameWidth = c.name.length;
  }
  nameWidth = Math.min(nameWidth, 20);

  const selected = visible[clamped - start];
  const usageLine = selected?.usage ? selected.usage : null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="gray" dimColor>
          {`commands (${total})`}
        </Text>
      </Box>

      {hiddenAbove > 0 && (
        <Box>
          <Text color="gray" dimColor>
            {`  ... ${hiddenAbove} more above ...`}
          </Text>
        </Box>
      )}

      {visible.map((cmd, i) => {
        const absoluteIndex = start + i;
        const isSelected = absoluteIndex === clamped;
        const namePadded = padRight(cmd.name, nameWidth);

        return (
          <Box key={cmd.name}>
            <Text color={isSelected ? "cyan" : "white"}>
              {isSelected ? "> " : "  "}
            </Text>
            <Text color={isSelected ? "cyan" : "white"} bold={isSelected}>
              {"/" + namePadded}
            </Text>
            <Text color={isSelected ? "white" : "gray"} dimColor={!isSelected}>
              {"  " + cmd.description}
            </Text>
          </Box>
        );
      })}

      {hiddenBelow > 0 && (
        <Box>
          <Text color="gray" dimColor>
            {`  ... ${hiddenBelow} more below ...`}
          </Text>
        </Box>
      )}

      {usageLine && (
        <Box marginTop={0}>
          <Text color="gray" dimColor>
            {`  usage: ${usageLine}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  let out = s;
  while (out.length < width) out += " ";
  return out;
}