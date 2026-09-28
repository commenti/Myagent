/**
 * src/ui/ApiForm.tsx
 * ------------------
 * Interactive form for adding an API profile. Three single-line fields
 * (Base URL / API Key / Model). Enter advances to the next field; Enter on
 * the last field submits. Esc cancels.
 *
 * Paste-safe: newlines and tabs are stripped from any input, so pasting a
 * multi-line blob never breaks the field. Values are trimmed on advance/submit.
 *
 * The actual handshake + save is delegated via props.onSubmit, so this file
 * stays pure UI.
 */

import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface ApiFormValues {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export type ApiFormSubmitResult =
  | { readonly ok: true; readonly summary: string }
  | { readonly ok: false; readonly error: string };

export interface ApiFormProps {
  /** Called on the final Enter. Return ok:true (with a summary) or ok:false
   * (with an error message). The form stays open on ok:false. */
  readonly onSubmit: (values: ApiFormValues) => Promise<ApiFormSubmitResult>;
  /** Called on Esc. */
  readonly onCancel: () => void;
  /** Called after a successful submit, with the summary line. */
  readonly onSaved: (summary: string) => void;
}


// ------------------------------------------------------------------
// Field layout
// ------------------------------------------------------------------

type FieldName = "baseUrl" | "apiKey" | "model";

const FIELD_ORDER: readonly FieldName[] = ["baseUrl", "apiKey", "model"];

const FIELD_LABELS: Record<FieldName, string> = {
  baseUrl: "Base URL",
  apiKey: "API Key ",
  model: "Model   ",
};

const FIELD_HINTS: Record<FieldName, string> = {
  baseUrl: "e.g. https://api.groq.com/openai",
  apiKey: "paste is safe — masked on screen",
  model: "e.g. gpt-oss-120b",
};





// ------------------------------------------------------------------
// Input sanitizer (single-line fields)
// ------------------------------------------------------------------

function stripToSingleLine(s: string): string {
  // Remove newlines, tabs, and control bytes — a single-line field never
  // legitimately contains them, and pastes often do.
  let out = s.replace(/\r\n/g, "");
  out = out.replace(/[\r\n\t]/g, "");
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return out;
}


// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function ApiForm(props: ApiFormProps): React.ReactElement {
  const { onSubmit, onCancel, onSaved } = props;

  const [values, setValues] = useState<ApiFormValues>({
    baseUrl: "",
    apiKey: "",
    model: "",
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeField = FIELD_ORDER[activeIndex];
  const isLast = activeIndex === FIELD_ORDER.length - 1;

  const appendToActive = useCallback(
    (chunk: string) => {
      const cleaned = stripToSingleLine(chunk);
      if (cleaned.length === 0) return;
      setValues((v) => ({
        ...v,
        [activeField]: v[activeField] + cleaned,
      }));
    },
    [activeField]
  );

  const backspaceActive = useCallback(() => {
    setValues((v) => ({
      ...v,
      [activeField]: v[activeField].slice(0, -1),
    }));
  }, [activeField]);

  const advance = useCallback(() => {
    // Trim the field we're leaving before moving on.
    setValues((v) => ({ ...v, [activeField]: v[activeField].trim() }));
    setActiveIndex((i) => Math.min(FIELD_ORDER.length - 1, i + 1));
  }, [activeField]);

  const submit = useCallback(async () => {
    const trimmed: ApiFormValues = {
      baseUrl: values.baseUrl.trim(),
      apiKey: values.apiKey.trim(),
      model: values.model.trim(),
    };
    setValues(trimmed);

    if (!trimmed.baseUrl || !trimmed.apiKey || !trimmed.model) {
      setError("All three fields are required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    let result: ApiFormSubmitResult;
    try {
      result = await onSubmit(trimmed);
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    setSubmitting(false);

    if (result.ok) {
      onSaved(result.summary);
    } else {
      setError(result.error);
    }
  }, [values, onSubmit, onSaved]);

  useInput(
    (input, key) => {
      if (submitting) return;

      if (key.escape) {
        onCancel();
        return;
      }

      if (key.return) {
        if (isLast) {
          void submit();
        } else {
          advance();
        }
        return;
      }

      if (key.backspace || key.delete) {
        backspaceActive();
        return;
      }

      if (input.length > 0) {
        appendToActive(input);
      }
    },
    { isActive: !submitting }
  );

  // ------------------------------ render ------------------------------

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text bold color="cyan">{"Add API profile"}</Text>
        </Box>

        {FIELD_ORDER.map((field, i) => {
          const isActive = i === activeIndex;
          const value = values[field];
          const display =
            field === "apiKey" ? "*".repeat(value.length) : value;

          return (
            <Box key={field} flexDirection="column" marginTop={0}>
              <Box>
                <Text color={isActive ? "cyan" : "gray"}>
                  {isActive ? "> " : "  "}
                </Text>
                <Text color={isActive ? "cyan" : "gray"} bold={isActive}>
                  {FIELD_LABELS[field] + ": "}
                </Text>
                <Text>
                  {display.length > 0 ? display : ""}
                </Text>
                {isActive && <Text color="cyan">{"_"}</Text>}
              </Box>
              {isActive && (
                <Box marginLeft={2}>
                  <Text color="gray" dimColor>
                    {FIELD_HINTS[field]}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {error && (
        <Box paddingX={1}>
          <Text color="red">{"! " + error}</Text>
        </Box>
      )}

      <Box paddingX={1}>
        <Text color="gray" dimColor>
          {submitting
            ? "Testing connection... (please wait)"
            : "Enter: next / save    Esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
}