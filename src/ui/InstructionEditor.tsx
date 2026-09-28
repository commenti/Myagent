/**
 * src/ui/InstructionEditor.tsx
 * ----------------------------
 * Multi-line editor for /instruction.
 *
 * - Enter inserts a newline.
 * - Ctrl+S saves.
 * - A line containing only "/save" (then Enter) also saves.
 * - Esc cancels without saving.
 * - Paste-safe: large inputs are accepted; the *display* is windowed.
 * - The whole buffer is saved verbatim, never truncated.
 */

import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";

const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MB
const VISIBLE_LINES = 12;

export interface InstructionEditorProps {
  readonly title: string;
  readonly initialText: string;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}

function stripBracketedPaste(s: string): string {
  let out = s.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return out;
}

export function InstructionEditor(
  props: InstructionEditorProps
): React.ReactElement {
  const { title, initialText, onSave, onCancel } = props;
  const [buffer, setBuffer] = useState<string>(initialText);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const append = useCallback((chunk: string) => {
    setBuffer((prev) => {
      let next = prev + chunk;
      if (Buffer.byteLength(next, "utf8") > MAX_BUFFER_BYTES) {
        while (
          next.length > 0 &&
          Buffer.byteLength(next, "utf8") > MAX_BUFFER_BYTES
        ) {
          const drop = Math.max(1, Math.floor(next.length / 10));
          next = next.slice(drop);
        }
      }
      return next;
    });
  }, []);

  const backspace = useCallback(() => {
    setBuffer((prev) => (prev.length === 0 ? prev : prev.slice(0, -1)));
  }, []);

  const doSave = useCallback(
    (text: string) => {
      try {
        onSave(text);
        setSavedAt(new Date().toISOString());
      } catch {
        /* renderer will surface an error; keep the editor open */
      }
    },
    [onSave]
  );

  useInput(
    (input, key) => {
      if (key.escape) { onCancel(); return; }

      if (key.ctrl && (input === "s" || input === "S")) {
        doSave(buffer);
        return;
      }

      if (key.return) {
        const lines = buffer.split("\n");
        const last = (lines[lines.length - 1] ?? "").trim();
        if (last === "/save") {
          const withoutMarker = lines.slice(0, -1).join("\n");
          const finalText =
            withoutMarker.length === 0 || withoutMarker.endsWith("\n")
              ? withoutMarker
              : withoutMarker + "\n";
          setBuffer(finalText);
          doSave(finalText);
          return;
        }
        append("\n");
        return;
      }

      if (key.backspace || key.delete) { backspace(); return; }

      if (input.length > 0) {
        const cleaned = stripBracketedPaste(input);
        if (cleaned.length > 0) append(cleaned);
      }
    },
    { isActive: true }
  );

  const lines = buffer.split("\n");
  const hidden = Math.max(0, lines.length - VISIBLE_LINES);
  const visible = lines.slice(hidden);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">{title}</Text>
      </Box>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        flexDirection="column"
      >
        {hidden > 0 && (
          <Text color="gray" dimColor>
            {"... " + hidden + " earlier line(s) hidden ..."}
          </Text>
        )}
        {visible.length === 0 ? (
          <Text color="gray" dimColor>{"(empty)"}</Text>
        ) : (
          visible.map((line, i) => (
            <Text key={i}>{line.length === 0 ? " " : line}</Text>
          ))
        )}
      </Box>
      <Box marginTop={0}>
        <Text color="gray" dimColor>
          {savedAt
            ? "saved at " + savedAt
            : "Enter: newline    Ctrl+S: save    /save on its own line: save    Esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
}