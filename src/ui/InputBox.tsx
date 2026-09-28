/**
 * src/ui/InputBox.tsx
 * -------------------
 * Large, paste-safe multiline input box.
 *
 * Behaviour:
 *   - Enter submits. Ctrl+J inserts a newline.
 *   - Text starting with "/" (and no space yet) shows the SlashCommandMenu.
 *     Up/Down navigate; Tab completes; Enter runs the highlighted command.
 *   - Paste-safe: the visible area is capped (older lines scroll off), and the
 *     buffer is capped by max lines and by max bytes.
 *   - Bracketed-paste markers are stripped; CRLF is normalized to LF.
 *
 * This component is pure UI. Command execution is delegated via props:
 *   - onSlashCommand(name, args) for slash commands
 *   - onSubmit(text)             for plain messages
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Box, Text, useInput } from "ink";

import {
  SlashCommandMenu,
  filterCommands,
  type SlashCommand,
} from "./SlashCommandMenu";


// ------------------------------------------------------------------
// Limits
// ------------------------------------------------------------------

const MAX_BUFFER_BYTES = 512 * 1024;
const DEFAULT_MAX_VISIBLE_LINES = 10;
const DEFAULT_MAX_LINES = 5000;
const DEFAULT_PLACEHOLDER =
  "Type your message. Enter to send, Ctrl+J for a new line.";


// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface InputBoxProps {
  /** Called with the raw text when the user submits a non-slash message. */
  readonly onSubmit: (text: string) => void;
  /** Called when a slash command is picked. args is text after the name. */
  readonly onSlashCommand?: (name: string, args: string) => void;
  /** The set of slash commands to offer. If empty, no menu is shown. */
  readonly slashCommands?: readonly SlashCommand[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly maxVisibleLines?: number;
  readonly maxLines?: number;
}


// ------------------------------------------------------------------
// Input sanitizer
// ------------------------------------------------------------------

function sanitizeInput(s: string): string {
  // Strip bracketed-paste wrapper markers if the terminal emits them.
  let out = s.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
  // Normalize line endings.
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return out;
}


// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function InputBox(props: InputBoxProps): React.ReactElement {
  const {
    onSubmit,
    onSlashCommand,
    slashCommands = [],
    placeholder = DEFAULT_PLACEHOLDER,
    disabled = false,
    maxVisibleLines = DEFAULT_MAX_VISIBLE_LINES,
    maxLines = DEFAULT_MAX_LINES,
  } = props;

  const [value, setValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Slash-menu detection: value is "/" or "/letters" with no space yet.
  const slashMatch = /^\/[A-Za-z-]*$/.exec(value);
  const menuOpen = slashMatch !== null && slashCommands.length > 0;
  const query = menuOpen ? value.slice(1) : "";

  const filtered: readonly SlashCommand[] = useMemo(
    () => (menuOpen ? filterCommands(slashCommands, query) : []),
    [menuOpen, slashCommands, query]
  );

  // Keep selection inside bounds whenever the list changes.
  useEffect(() => {
    if (filtered.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(filtered.length - 1);
    }
  }, [filtered.length, selectedIndex]);

  // ------------------------------- handlers ------------------------------

  const cap = useCallback(
    (next: string): string => {
      let out = next;
      // Cap by lines.
      const lines = out.split("\n");
      if (lines.length > maxLines) {
        out = lines.slice(-maxLines).join("\n");
      }
      // Cap by bytes; trim from the front.
      if (Buffer.byteLength(out, "utf8") > MAX_BUFFER_BYTES) {
        while (
          out.length > 0 &&
          Buffer.byteLength(out, "utf8") > MAX_BUFFER_BYTES
        ) {
          const drop = Math.max(1, Math.floor(out.length / 10));
          out = out.slice(drop);
        }
      }
      return out;
    },
    [maxLines]
  );

  const submitPlain = useCallback(() => {
    if (value.trim().length === 0) return;
    const text = value;
    setValue("");
    setSelectedIndex(0);
    onSubmit(text);
  }, [value, onSubmit]);

  const submitSlash = useCallback(() => {
    if (filtered.length === 0) {
      // No matching command — submit raw as a plain message.
      submitPlain();
      return;
    }
    const picked = filtered[selectedIndex] ?? filtered[0];
    const args = value.slice(1 + picked.name.length).replace(/^\s+/, "");
    setValue("");
    setSelectedIndex(0);
    if (onSlashCommand) onSlashCommand(picked.name, args);
    else onSubmit("/" + picked.name + (args ? " " + args : ""));
  }, [filtered, selectedIndex, value, onSlashCommand, onSubmit, submitPlain]);

  useInput(
    (input, key) => {
      if (disabled) return;

      // Ctrl+J → newline.
      if (key.ctrl && (input === "j" || input === "J")) {
        setValue((v) => cap(v + "\n"));
        return;
      }

      // Enter → submit.
      if (key.return) {
        if (menuOpen) submitSlash();
        else submitPlain();
        return;
      }

      // Backspace / Delete.
      if (key.backspace || key.delete) {
        setValue((v) => (v.length === 0 ? v : v.slice(0, -1)));
        return;
      }

      // Escape — clear the current value (and thus close the menu).
      if (key.escape) {
        if (value.length > 0) setValue("");
        return;
      }

      // Menu navigation.
      if (menuOpen && key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (menuOpen && key.downArrow) {
        setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }

      // Tab — complete the highlighted slash command name.
      if (menuOpen && key.tab && filtered.length > 0) {
        const picked = filtered[selectedIndex] ?? filtered[0];
        setValue("/" + picked.name + " ");
        return;
      }

      // Regular input (including pasted chunks).
      if (input.length > 0) {
        const cleaned = sanitizeInput(input);
        if (cleaned.length > 0) {
          setValue((v) => cap(v + cleaned));
        }
      }
    },
    { isActive: !disabled }
  );

  // ------------------------------- render --------------------------------

  const lines = value.split("\n");
  const hiddenCount = Math.max(0, lines.length - maxVisibleLines);
  const visibleLines = lines.slice(hiddenCount);

  const hint = menuOpen
    ? "Up/Down navigate   Tab complete   Enter run   Esc clear"
    : "Enter send   Ctrl+J newline   Esc clear";

  return (
    <Box flexDirection="column">
      {menuOpen && (
        <SlashCommandMenu
          commands={slashCommands}
          query={query}
          selectedIndex={selectedIndex}
        />
      )}

      <Box
        borderStyle="round"
        borderColor={disabled ? "gray" : "cyan"}
        paddingX={1}
        flexDirection="column"
      >
        {hiddenCount > 0 && (
          <Text color="gray" dimColor>
            {`... ${hiddenCount} earlier line(s) hidden ...`}
          </Text>
        )}

        {value.length === 0 ? (
          <Text>
            <Text color="cyan">{"> "}</Text>
            <Text color="gray" dimColor>
              {placeholder}
            </Text>
          </Text>
        ) : (
          visibleLines.map((line, i) => (
            <Text key={i}>
              <Text color="cyan">{i === 0 ? "> " : "  "}</Text>
              {line.length === 0 ? " " : line}
            </Text>
          ))
        )}
      </Box>

      <Box paddingX={1}>
        <Text color="gray" dimColor>
          {hint}
        </Text>
      </Box>
    </Box>
  );
}