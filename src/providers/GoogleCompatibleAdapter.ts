/**
 * src/providers/GoogleCompatibleAdapter.ts
 * ----------------------------------------
 * Adapter for the Google Gemini API (generativelanguage.googleapis.com).
 * Also works with compatible endpoints that use the same wire format.
 *
 * Key differences from OpenAI:
 *   • Messages are called "contents" with role "user" | "model".
 *   • Each message has a `parts` array (text / inlineData / functionCall /
 *     functionResponse).
 *   • The system prompt is a top-level `systemInstruction` field.
 *   • Auth is `x-goog-api-key` (or `?key=` query param).
 *   • Streaming URL uses `:streamGenerateContent?alt=sse`.
 *   • Function calls arrive WHOLE in a single chunk (no argument deltas).
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

const API_VERSION = "v1beta";
const DEFAULT_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT = 4_096;

// ------------------------------------------------------------------
// Wire types (minimal subset we read)
// ------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response?: unknown };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: unknown[];
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

// ------------------------------------------------------------------
// Adapter
// ------------------------------------------------------------------

export class GoogleCompatibleAdapter implements ProviderAdapter {
  public readonly id = "google-compatible";
  public readonly capabilities: AdapterCapabilities;

  private readonly fetchImpl: typeof fetch;

  constructor(config?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = config?.fetchImpl ?? fetch;
    this.capabilities = getCapabilities("");
  }

  // ----------------------------------------------------------------
  // URL
  // ----------------------------------------------------------------

  private endpoint(
    baseUrl: string,
    model: string,
    stream: boolean
  ): string {
    const base = baseUrl.replace(/\/+$/, "");
    // If the user pasted a full base (…/v1beta), use it; else append /v1beta.
    const root = /\/v\d+[a-z]*$/i.test(base)
      ? base
      : base + "/" + API_VERSION;
    const method = stream
      ? "streamGenerateContent"
      : "generateContent";
    const tail = stream ? "?alt=sse" : "";

    return (
      root +
      "/models/" +
      encodeURIComponent(model) +
      ":" +
      method +
      tail
    );
  }

  // ----------------------------------------------------------------
  // Message mapping (neutral → Gemini)
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

  private toParts(msg: ChatMessage): GeminiPart[] {
    const parts: GeminiPart[] = [];

    // Tool result turn.
    if (msg.role === "tool") {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");

      parts.push({
        functionResponse: {
          name: msg.toolCallId ?? "",
          response: { content: text },
        },
      });

      return parts;
    }

    // Text + image parts.
    for (const part of msg.parts) {
      if (part.kind === "text") {
        if (part.text.length > 0) {
          parts.push({ text: part.text });
        }
      } else if (part.kind === "image") {
        parts.push({
          inlineData: {
            mimeType: part.mimeType,
            data: part.base64,
          },
        });
      }
    }

    // Assistant tool calls.
    if (
      msg.role === "assistant" &&
      msg.toolCalls &&
      msg.toolCalls.length > 0
    ) {
      for (const tc of msg.toolCalls) {
        let parsedArgs: unknown = {};

        try {
          parsedArgs = JSON.parse(tc.argumentsJson || "{}");
        } catch {
          parsedArgs = {};
        }

        parts.push({
          functionCall: {
            name: tc.name,
            args: parsedArgs,
          },
        });
      }
    }

    if (parts.length === 0) {
      parts.push({ text: "" });
    }

    return parts;
  }

  /**
   * Gemini roles are "user" | "model". Consecutive same-role messages are
   * coalesced so the API doesn't reject the payload.
   */
  private toContents(
    messages: readonly ChatMessage[]
  ): GeminiContent[] {
    const out: GeminiContent[] = [];

    for (const m of messages) {
      const role: "user" | "model" =
        m.role === "assistant" ? "model" : "user";

      const parts = this.toParts(m);
      const last = out[out.length - 1];

      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        out.push({
          role,
          parts,
        });
      }
    }

    // Gemini requires the first content to be role "user".
    if (out.length > 0 && out[0].role === "model") {
      out.unshift({
        role: "user",
        parts: [{ text: "" }],
      });
    }

    return out;
  }

  // ----------------------------------------------------------------
  // Tools
  // ----------------------------------------------------------------

  private toGeminiTool(t: ToolSchema): unknown {
    // Gemini has no per-tool "name" at the wrapper level; it uses a single
    // `tools` array with `functionDeclarations`.
    return {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    };
  }

  private toGeminiTools(
    tools: readonly ToolSchema[]
  ): unknown[] {
    return [
      {
        functionDeclarations: tools.map((t) =>
          this.toGeminiTool(t)
        ),
      },
    ];
  }

  // ----------------------------------------------------------------
  // Request builder
  // ----------------------------------------------------------------

  private buildBody(
    request: ChatRequest,
    _stream: boolean
  ): GeminiRequestBody {
    const { system, rest } = this.splitSystem(request.messages);
    const contents = this.toContents(rest);

    const body: GeminiRequestBody = {
      contents,
    };

    if (system.length > 0) {
      body.systemInstruction = {
        parts: [{ text: system }],
      };
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = this.toGeminiTools(request.tools);
    }

    const gen: GeminiRequestBody["generationConfig"] = {};

    if (typeof request.maxOutputTokens === "number") {
      gen.maxOutputTokens = request.maxOutputTokens;
    }

    if (typeof request.temperature === "number") {
      gen.temperature = request.temperature;
    }

    if (Object.keys(gen).length > 0) {
      body.generationConfig = gen;
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
      "x-goog-api-key": apiKey,
    };

    if (stream) {
      h["Accept"] = "text/event-stream";
    }

    return h;
  }

  // ----------------------------------------------------------------
  // Handshake
  // ----------------------------------------------------------------

  public async handshake(
    config: AdapterConfig
  ): Promise<void> {
    const url = this.endpoint(
      config.baseUrl,
      config.model,
      false
    );

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
          contents: [
            {
              role: "user",
              parts: [{ text: "hi" }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 1,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await safeJson(res);

        throw classifyProviderError({
          status: res.status,
          body: errBody,
        });
      }

      // Drain the body (some deployments warn if the body isn't consumed).
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
    const url = this.endpoint(
      config.baseUrl,
      request.model,
      true
    );

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

    // Gemini function calls arrive whole; we emit start → delta → end so the
    // downstream (AdapterBase consumers) sees one consistent shape.
    let finishReason: FinishReason = "stop";
    let sawToolCalls = false;
    let toolSeq = 0;

    try {
      for await (const data of parseSse(res.body)) {
        if (data === "[DONE]") break;

        let chunk: GeminiStreamChunk;

        try {
          chunk = JSON.parse(data) as GeminiStreamChunk;
        } catch {
          continue;
        }

        // Usage.
        if (chunk.usageMetadata) {
          const u = chunk.usageMetadata;

          yield {
            type: "usage",
            inputTokens: u.promptTokenCount ?? 0,
            outputTokens: u.candidatesTokenCount ?? 0,
          };
        }

        const cand = chunk.candidates?.[0];
        if (!cand) continue;

        const parts = cand.content?.parts ?? [];

        for (const p of parts) {
          if (
            typeof p.text === "string" &&
            p.text.length > 0
          ) {
            yield {
              type: "text-delta",
              text: p.text,
            };
          }

          if (p.functionCall) {
            sawToolCalls = true;
            toolSeq++;

            const id = "call_" + toolSeq;

            yield {
              type: "tool-call-start",
              id,
              name: p.functionCall.name,
            };

            const argsJson = safeStringify(
              p.functionCall.args ?? {}
            );

            if (argsJson.length > 0) {
              yield {
                type: "tool-call-delta",
                id,
                argumentsDelta: argsJson,
              };
            }

            yield {
              type: "tool-call-end",
              id,
            };
          }
        }

        if (cand.finishReason) {
          finishReason = mapFinish(
            cand.finishReason,
            sawToolCalls
          );
        }
      }

      yield {
        type: "done",
        finishReason: sawToolCalls
          ? "tool-calls"
          : finishReason,
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
        request.signal.removeEventListener(
          "abort",
          onAbort
        );
      }
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function mapFinish(
  raw: string,
  sawToolCalls: boolean
): FinishReason {
  switch (raw) {
    case "STOP":
      return sawToolCalls ? "tool-calls" : "stop";

    case "MAX_TOKENS":
      return "length";

    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "stop";

    case "TOOL_CALLS":
      return "tool-calls";

    default:
      return sawToolCalls ? "tool-calls" : "stop";
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
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
// SSE parser (same shape as the other adapters; local for self-containment)
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