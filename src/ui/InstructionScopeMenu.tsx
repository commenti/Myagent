/**
 * src/ui/InstructionScopeMenu.tsx
 * -------------------------------
 * Small scope picker for /instruction: session / project / global.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export type InstructionScope = "session" | "project" | "global";

export interface InstructionScopeMenuProps {
  readonly onPick: (scope: InstructionScope) => void;
  readonly onCancel: () => void;
}

interface ScopeItem {
  readonly scope: InstructionScope;
  readonly label: string;
  readonly hint: string;
}

const ITEMS: readonly ScopeItem[] = [
  { scope: "session", label: "This session only", hint: "kept in memory, not saved to disk" },
  { scope: "project", label: "This project",      hint: ".agent-runtime/instructions.md" },
  { scope: "global",  label: "All projects",      hint: "~/.agent-cli/instructions.md" },
];

export function InstructionScopeMenu(
  props: InstructionScopeMenuProps
): React.ReactElement {
  const { onPick, onCancel } = props;
  const [index, setIndex] = useState(0);

  useInput(
    (input, key) => {
      if (key.escape) { onCancel(); return; }
      if (key.upArrow)   { setIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setIndex((i) => Math.min(ITEMS.length - 1, i + 1)); return; }
      if (key.return)    { onPick(ITEMS[index].scope); return; }
      if (input === "1") { onPick("session"); return; }
      if (input === "2") { onPick("project"); return; }
      if (input === "3") { onPick("global");  return; }
    },
    { isActive: true }
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">{"Where should this instruction apply?"}</Text>
      </Box>
      {ITEMS.map((it, i) => {
        const sel = i === index;
        return (
          <Box key={it.scope}>
            <Text color={sel ? "cyan" : "white"}>{sel ? "> " : "  "}</Text>
            <Text color={sel ? "cyan" : "white"} bold={sel}>{it.label}</Text>
            <Text color="gray" dimColor>{"  (" + it.hint + ")"}</Text>
          </Box>
        );
      })}
      <Box marginTop={0}>
        <Text color="gray" dimColor>
          {"Up/Down or 1/2/3    Enter: choose    Esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
}