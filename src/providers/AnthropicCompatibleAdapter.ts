/**
 * src/providers/AnthropicCompatibleAdapter.ts
 * -------------------------------------------
 * Adapter for the Anthropic Messages API (https://api.anthropic.com/v1/messages).
 * Also works with compatible endpoints that use the same wire format.
 *
 * Key differences from OpenAI:
 *   • The system prompt is a TOP-LEVEL `system` field, not a message.
 *   • Messages must strictly alternate user / assistant.
 *   • Content is an array of typed blocks (text, image, tool_use, tool_result).
 *   • Streaming uses named SSE events (message_start, content_block_delta, ...).
 *   • Auth header is `x-api-key`, plus `anthropic-version`.
 *
 * No SDK — uses Node's native fetch and a small SSE parser.
 */

import {
  type AdapterEvent,
  type AdapterConfig,
  type AdapterCapabilities,
  type ChatMessage,
  type ChatRequest,
  type FinishReason,
  type ProviderAdapter,
  type ToolSchema,
} from "./AdapterBase";
import { classifyProviderError, normalizeError } from "./ErrorClassifier";
import { getCapabilities } from "./CapabilityRegistry";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 4_096;

// ------------------------------------------------------------------
// Wire types (minimal subset we read)
// ------------------------------------------------------------------

interface AnthTextBlock {
  type: "text";
  text: string;
}

interface AnthImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

interface AnthToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AnthContentBlock =
  | AnthTextBlock
  | AnthImageBlock
  | AnthToolUseBlock
  | AnthToolResultBlock;

interface AnthMessage {
  role: "user" | "assistant";
  content: AnthContentBlock[];
}

interface AnthRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthMessage[];
  system?: string;
  stream?: boolean;
  tools?: unknown[];
  temperature?: number;
}

interface AnthStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ------------------------------------------------------------------
// Adapter
// ------------------------------------------------------------------

export class AnthropicCompatibleAdapter implements ProviderAdapter {
  public readonly id = "anthropic-compatible";
  public readonly capabilities: AdapterCapabilities;

  private readonly fetchImpl: typeof fetch;

  constructor(config?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = config?.fetchImpl ?? fetch;
    this.capabilities = getCapabilities("");
  }

  // ----------------------------------------------------------------
  // URL
  // ----------------------------------------------------------------

  private messagesUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (trimmed.endsWith("/messages")) return trimmed;
    if (trimmed.endsWith("/v1")) return trimmed + "/messages";
    return trimmed + "/v1/messages";
  }

  // ----------------------------------------------------------------
  // Message mapping (neutral → Anthropic)
  // ----------------------------------------------------------------

  private splitSystem(messages: readonly ChatMessage[]): {
    system: string;
    rest: readonly ChatMessage[];
  } {
    const systems: string[] = [];
    const rest: ChatMessage[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        const text = m.parts
          .map((p) => (p.kind === "text" ? p.text : ""))
          .join("\n");

        if (text.length > 0) systems.push(text);
      } else {
        rest.push(m);
      }
    }

    return {
      system: systems.join("\n\n"),
      rest,
    };
  }

  private toAnthBlock(msg: ChatMessage): AnthContentBlock[] {
    const blocks: AnthContentBlock[] = [];

    // Tool result turns become a user message with tool_result blocks.
    if (msg.role === "tool") {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");

      blocks.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: text,
      });

      return blocks;
    }

    // Text + image parts.
    for (const part of msg.parts) {
      if (part.kind === "text") {
        if (part.text.length > 0) {
          blocks.push({
            type: "text",
            text: part.text,
          });
        }
      } else if (part.kind === "image") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mimeType,
            data: part.base64,
          },
        });
      }
    }

    // Assistant tool calls become tool_use blocks.
    if (
      msg.role === "assistant" &&
      msg.toolCalls &&
      msg.toolCalls.length > 0
    ) {
      for (const tc of msg.toolCalls) {
        let parsed: unknown = {};

        try {
          parsed = JSON.parse(tc.argumentsJson || "{}");
        } catch {
          parsed = {};
        }

        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: parsed,
        });
      }
    }

    // Anthropic requires at least one content block per message.
    if (blocks.length === 0) {
      blocks.push({
        type: "text",
        text: "",
      });
    }

    return blocks;
  }

  /**
   * Anthropic requires strict alternation and no empty consecutive turns.
   * We coalesce consecutive same-role messages into one.
   */
  private toAnthMessages(
    messages: readonly ChatMessage[]
  ): AnthMessage[] {
    const out: AnthMessage[] = [];

    for (const m of messages) {
      // "tool" role is delivered on the user side.
      const role: "user" | "assistant" =
        m.role === "assistant" ? "assistant" : "user";

      const blocks = this.toAnthBlock(m);

      const last = out[out.length - 1];

      if (last && last.role === role) {
        last.content.push(...blocks);
      } else {
        out.push({
          role,
          content: blocks,
        });
      }
    }

    // Anthropic requires the first message to be user.
    if (out.length > 0 && out[0].role === "assistant") {
      out.unshift({
        role: "user",
        content: [
          {
            type: "text",
            text: "",
          },
        ],
      });
    }

    return out;
  }

  // ----------------------------------------------------------------
  // Tools
  // ----------------------------------------------------------------

  private toAnthTool(t: ToolSchema): unknown {
    return {
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    };
  }

  // ----------------------------------------------------------------
  // Request builder
  // ----------------------------------------------------------------

  private buildBody(
    request: ChatRequest,
    stream: boolean
  ): AnthRequestBody {
    const { system, rest } = this.splitSystem(request.messages);
    const messages = this.toAnthMessages(rest);

    const body: AnthRequestBody = {
      model: request.model,
      max_tokens:
        request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      messages,
      stream,
    };

    if (system.length > 0) {
      body.system = system;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => this.toAnthTool(t));
    }

    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }

    return body;
  }

  // ----------------------------------------------------------------
  // Headers
  // ----------------------------------------------------------------

  private headers(
    apiKey: string,
    stream: boolean
  ): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };

    if (stream) {
      h["Accept"] = "text/event-stream";
    }

    return h;
  }

  // ----------------------------------------------------------------
  // Handshake
  // ----------------------------------------------------------------

  public async handshake(config: AdapterConfig): Promise<void> {
    const url = this.messagesUrl(config.baseUrl);
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      HANDSHAKE_TIMEOUT_MS
    );

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(config.apiKey, false),
        body: JSON.stringify({
          model: config.model,
          max_tokens: 16,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "hi",
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await safeJson(res);
        throw classifyProviderError({
          status: res.status,
          body,
        });
      }

      await res.text();
    } catch (err) {
      throw normalizeError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  // ----------------------------------------------------------------
  // Streaming
  // ----------------------------------------------------------------

  public async *streamChat(
    config: AdapterConfig,
    request: ChatRequest
  ): AsyncIterable<AdapterEvent> {
    const url = this.messagesUrl(config.baseUrl);
    const body = this.buildBody(request, true);

    const controller = new AbortController();
    const onAbort = () => controller.abort();

    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        request.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      }
    }

    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_TIMEOUT_MS
    );

    let res: Response;

    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(config.apiKey, true),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);

      if (request.signal) {
        request.signal.removeEventListener("abort", onAbort);
      }

      throw normalizeError(err);
    }

    if (!res.ok) {
      const errBody = await safeJson(res);

      clearTimeout(timer);

      if (request.signal) {
        request.signal.removeEventListener("abort", onAbort);
      }

      throw classifyProviderError({
        status: res.status,
        body: errBody,
      });
    }

    if (!res.body) {
      clearTimeout(timer);

      if (request.signal) {
        request.signal.removeEventListener("abort", onAbort);
      }

      throw classifyProviderError({
        status: res.status,
        body: "no response body",
      });
    }

    // Track tool_use blocks by index.
    const toolIds = new Map<number, string>();
    const toolNames = new Map<number, string>();
    let stopReason: FinishReason = "stop";

    try {
      for await (const raw of parseSse(res.body)) {
        let ev: AnthStreamEvent;

        try {
          ev = JSON.parse(raw) as AnthStreamEvent;
        } catch {
          continue;
        }

        const t = ev.type ?? "";

        if (t === "ping") continue;

        if (t === "message_start" && ev.message?.usage) {
          const u = ev.message.usage;

          yield {
            type: "usage",
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
          };

          continue;
        }

        if (t === "content_block_start" && ev.content_block) {
          const idx = ev.index ?? 0;
          const cb = ev.content_block;

          if (
            cb.type === "tool_use" &&
            cb.id &&
            cb.name
          ) {
            toolIds.set(idx, cb.id);
            toolNames.set(idx, cb.name);

            yield {
              type: "tool-call-start",
              id: cb.id,
              name: cb.name,
            };
          }

          continue;
        }

        if (t === "content_block_delta" && ev.delta) {
          const idx = ev.index ?? 0;
          const d = ev.delta;

          if (
            d.type === "text_delta" &&
            typeof d.text === "string" &&
            d.text.length > 0
          ) {
            yield {
              type: "text-delta",
              text: d.text,
            };
          } else if (
            d.type === "input_json_delta" &&
            typeof d.partial_json === "string"
          ) {
            const id = toolIds.get(idx);

            if (id) {
              yield {
                type: "tool-call-delta",
                id,
                argumentsDelta: d.partial_json,
              };
            }
          }

          continue;
        }

        if (t === "content_block_stop") {
          const idx = ev.index ?? 0;
          const id = toolIds.get(idx);

          if (id) {
            yield {
              type: "tool-call-end",
              id,
            };
          }

          continue;
        }

        if (t === "message_delta") {
          if (ev.usage) {
            yield {
              type: "usage",
              inputTokens: ev.usage.input_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? 0,
            };
          }

          if (ev.delta?.stop_reason) {
            stopReason = mapStopReason(
              ev.delta.stop_reason,
              toolIds.size > 0
            );
          }

          continue;
        }

        if (t === "message_stop") break;

        if (t === "error") {
          throw classifyProviderError({
            body: ev,
          });
        }
      }

      yield {
        type: "done",
        finishReason: stopReason,
      };
    } catch (err) {
      if (isAbort(err)) {
        yield {
          type: "done",
          finishReason: "aborted",
        };
        return;
      }

      throw normalizeError(err);
    } finally {
      clearTimeout(timer);

      if (request.signal) {
        request.signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function mapStopReason(
  raw: string,
  sawToolCalls: boolean
): FinishReason {
  switch (raw) {
    case "end_turn":
      return sawToolCalls ? "tool-calls" : "stop";

    case "stop_sequence":
      return "stop";

    case "max_tokens":
      return "length";

    case "tool_use":
      return "tool-calls";

    default:
      return sawToolCalls ? "tool-calls" : "stop";
  }
}

function isAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const e = err as {
    name?: string;
    code?: string;
  };

  return (
    e.name === "AbortError" ||
    e.code === "ABORT_ERR"
  );
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------------
// SSE parser (shared shape with OpenAI adapter; kept local to avoid a
// shared util file until a third consumer appears)
// ------------------------------------------------------------------

async function* parseSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true,
      });

      let f: { end: number; len: number } | null;

      while ((f = findFrameEnd(buffer)) !== null) {
        const frame = buffer.slice(0, f.end);
        buffer = buffer.slice(f.end + f.len);

        const data = extractData(frame);

        if (data !== null) {
          yield data;
        }
      }
    }

    const data = extractData(buffer);

    if (data !== null) {
      yield data;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function findFrameEnd(
  s: string
): { end: number; len: number } | null {
  const lf = s.indexOf("\n\n");
  const crlf = s.indexOf("\r\n\r\n");

  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { end: crlf, len: 4 };
  if (crlf === -1) return { end: lf, len: 2 };

  return lf < crlf
    ? { end: lf, len: 2 }
    : { end: crlf, len: 4 };
}

function extractData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;

    const payload = line.slice(5).replace(/^ /, "");
    dataLines.push(payload);
  }

  if (dataLines.length === 0) return null;

  return dataLines.join("\n");
  }
