/**
 * src/providers/OpenAICompatibleAdapter.ts
 * ----------------------------------------
 * Adapter for any endpoint that speaks the OpenAI Chat Completions API.
 * Works with: OpenAI, DeepSeek, Groq, Together, Fireworks, OpenRouter,
 * Ollama, LM Studio, vLLM, and most self-hosted proxies.
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
// OpenAI wire types (minimal subset we actually read)
// ------------------------------------------------------------------

interface OaiToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OaiDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OaiToolCallDelta[];
}

interface OaiChoice {
  index: number;
  delta?: OaiDelta;
  finish_reason?: string | null;
}

interface OaiStreamChunk {
  id?: string;
  choices?: OaiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OaiRequestBody {
  model: string;
  messages: unknown[];
  stream: boolean;
  tools?: unknown[];
  temperature?: number;
  max_tokens?: number;
}


// ------------------------------------------------------------------
// Adapter
// ------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;


export class OpenAICompatibleAdapter implements ProviderAdapter {
  public readonly id = "openai-compatible";
  public readonly capabilities: AdapterCapabilities;

  private readonly fetchImpl: typeof fetch;

  constructor(config?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = config?.fetchImpl ?? fetch;
    // Capabilities depend on the model — resolved lazily in handshake/streamChat.
    // For a static default, use conservative values; callers should prefer
    // CapabilityRegistry.getCapabilities(model) directly when needed.
    this.capabilities = getCapabilities("");
  }


  // ----------------------------------------------------------------
  // URL helpers
  // ----------------------------------------------------------------

  private chatUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (trimmed.endsWith("/chat/completions")) return trimmed;
    if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
    return `${trimmed}/v1/chat/completions`;
  }


  // ----------------------------------------------------------------
  // Message mapping (neutral → OpenAI)
  // ----------------------------------------------------------------

  private toOpenAiMessage(msg: ChatMessage): unknown {
    // Tool result message
    if (msg.role === "tool") {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      return {
        role: "tool",
        tool_call_id: msg.toolCallId ?? "",
        content: text,
      };
    }

    // Assistant message with possible tool calls
    if (msg.role === "assistant") {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      const out: Record<string, unknown> = { role: "assistant" };
      if (text.length > 0) out.content = text;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        out.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argumentsJson },
        }));
      }
      return out;
    }

    // system / user — may include images
    const hasImage = msg.parts.some((p) => p.kind === "image");
    if (!hasImage) {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      return { role: msg.role, content: text };
    }

    // Multimodal content array
    const content = msg.parts.map((p) => {
      if (p.kind === "text") return { type: "text", text: p.text };
      return {
        type: "image_url",
        image_url: { url: `data:${p.mimeType};base64,${p.base64}` },
      };
    });
    return { role: msg.role, content };
  }


  // ----------------------------------------------------------------
  // Tool mapping
  // ----------------------------------------------------------------

  private toOpenAiTool(t: ToolSchema): unknown {
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    };
  }


  // ----------------------------------------------------------------
  // Request body builder
  // ----------------------------------------------------------------

  private buildBody(request: ChatRequest, stream: boolean): OaiRequestBody {
    const body: OaiRequestBody = {
      model: request.model,
      messages: request.messages.map((m) => this.toOpenAiMessage(m)),
      stream,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => this.toOpenAiTool(t));
    }
    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }
    if (typeof request.maxOutputTokens === "number") {
      body.max_tokens = request.maxOutputTokens;
    }
    return body;
  }


  // ----------------------------------------------------------------
  // Handshake
  // ----------------------------------------------------------------

  public async handshake(config: AdapterConfig): Promise<void> {
    const url = this.chatUrl(config.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await safeJson(res);
        throw classifyProviderError({ status: res.status, body });
      }
      // Success — drain and discard.
      await res.text();
    } catch (err) {
      throw normalizeError(err);
    } finally {
      clearTimeout(timer);
    }
  }


  // ----------------------------------------------------------------
  // Streaming chat
  // ----------------------------------------------------------------

  public async *streamChat(
    config: AdapterConfig,
    request: ChatRequest
  ): AsyncIterable<AdapterEvent> {
    const url = this.chatUrl(config.baseUrl);
    const body = this.buildBody(request, true);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener("abort", onAbort);
      throw normalizeError(err);
    }

    if (!res.ok) {
      const errBody = await safeJson(res);
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener("abort", onAbort);
      throw classifyProviderError({ status: res.status, body: errBody });
    }

    if (!res.body) {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener("abort", onAbort);
      throw classifyProviderError({ status: res.status, body: "no response body" });
    }

    // Track tool calls by index → id.
    const toolIds = new Map<number, string>();
    let finishReason: FinishReason = "stop";

    try {
      for await (const data of parseSse(res.body)) {
        if (data === "[DONE]") break;

        let chunk: OaiStreamChunk;
        try {
          chunk = JSON.parse(data) as OaiStreamChunk;
        } catch {
          continue; // ignore malformed SSE frames
        }

        // Usage (some providers send on the final chunk)
        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text-delta", text: delta.content };
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;

              if (tc.id && !toolIds.has(idx)) {
                const name = tc.function?.name ?? "";
                toolIds.set(idx, tc.id);
                yield { type: "tool-call-start", id: tc.id, name };
              }

              const id = toolIds.get(idx);
              if (id && tc.function?.arguments) {
                yield {
                  type: "tool-call-delta",
                  id,
                  argumentsDelta: tc.function.arguments,
                };
              }
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason, toolIds.size > 0);
        }
      }

      // Close any open tool calls cleanly.
      for (const id of toolIds.values()) {
        yield { type: "tool-call-end", id };
      }

      yield { type: "done", finishReason };
    } catch (err) {
      if (isAbort(err)) {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      throw normalizeError(err);
    } finally {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener("abort", onAbort);
    }
  }
}


// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function mapFinishReason(raw: string, sawToolCalls: boolean): FinishReason {
  switch (raw) {
    case "stop":
      return sawToolCalls ? "tool-calls" : "stop";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "length":
      return "length";
    case "content_filter":
      return "stop";
    default:
      return "stop";
  }
}

function isAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
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
// Minimal SSE parser over a ReadableStream<Uint8Array>
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
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line (\n\n or \r\n\r\n).
      let idx: number;
      while ((idx = findFrameEnd(buffer)) !== -1) {
        const frame = buffer.slice(0, idx.end);
        buffer = buffer.slice(idx.end + idx.len);
        const data = extractData(frame);
        if (data !== null) yield data;
      }
    }
    // Flush any trailing frame without a final blank line.
    const data = extractData(buffer);
    if (data !== null) yield data;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function findFrameEnd(s: string): { end: number; len: number } | null {
  const lf = s.indexOf("\n\n");
  const crlf = s.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { end: crlf, len: 4 };
  if (crlf === -1) return { end: lf, len: 2 };
  return lf < crlf ? { end: lf, len: 2 } : { end: crlf, len: 4 };
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