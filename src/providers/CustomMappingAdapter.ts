/**
 * src/providers/CustomMappingAdapter.ts
 * -------------------------------------
 * Adapter for endpoints that do not match OpenAI / Anthropic / Google wire
 * formats. The user supplies a JSON mapping file describing:
 *
 *   - how to build the request body
 *   - which headers to send (auth + extras)
 *   - how to read streaming frames (text, tool calls, usage, done)
 *
 * The file is referenced via AdapterConfig.extras.customMappingFile.
 *
 * Mapping file schema (version 1):
 *
 * {
 *   "version": 1,
 *   "url": "https://api.example.com/v1/chat",
 *   "method": "POST",
 *   "headers": { "X-Custom": "value" },
 *   "auth": {
 *     "header": "Authorization",
 *     "template": "Bearer {key}"
 *   },
 *
 *   "request": {
 *     "modelPath":     "model",
 *     "messagesPath":  "messages",
 *     "streamPath":    "stream",
 *     "streamValue":   true,
 *     "temperaturePath": "temperature",
 *     "maxTokensPath": "max_tokens",
 *     "toolsPath":     "tools",
 *     "systemPath":    "system",
 *     "messageShape": {
 *       "roleKey": "role",
 *       "contentKey": "content",
 *       "toolCallIdKey": "tool_call_id",
 *       "toolCallsKey": "tool_calls"
 *     }
 *   },
 *
 *   "response": {
 *     "format": "sse-json",
 *     "textPath":     "choices.0.delta.content",
 *     "toolCallsPath":"choices.0.delta.tool_calls",
 *     "toolCallShape":{
 *       "indexKey": "index",
 *       "idKey":    "id",
 *       "namePath": "function.name",
 *       "argsPath": "function.arguments"
 *     },
 *     "usagePath":    "usage",
 *     "usageShape":   { "inputKey": "prompt_tokens", "outputKey": "completion_tokens" },
 *     "doneMarker":   "[DONE]",
 *     "finishPath":   "choices.0.finish_reason",
 *     "finishMap":    { "stop": "stop", "tool_calls": "tool-calls", "length": "length" }
 *   }
 * }
 *
 * Notes:
 *   • Paths are dot-separated; numeric segments index arrays.
 *   • Missing values are treated as "no event" — never an error.
 *   • We only support SSE with JSON payloads per frame ("sse-json") in v1.
 */

import * as fs from "fs/promises";

import {
  type AdapterEvent,
  type AdapterConfig,
  type AdapterCapabilities,
  type ChatMessage,
  type ChatRequest,
  type ContentPart,
  type FinishReason,
  type ProviderAdapter,
  type ToolSchema,
} from "./AdapterBase";
import {
  classifyProviderError,
  normalizeError,
} from "./ErrorClassifier";
import { getCapabilities } from "./CapabilityRegistry";

// ------------------------------------------------------------------
// Mapping file types
// ------------------------------------------------------------------

interface AuthMapping {
  header: string;
  template: string;
}

interface MessageShape {
  roleKey: string;
  contentKey: string;
  toolCallIdKey?: string;
  toolCallsKey?: string;
}

interface RequestMapping {
  modelPath: string;
  messagesPath: string;
  streamPath?: string;
  streamValue?: boolean;
  temperaturePath?: string;
  maxTokensPath?: string;
  toolsPath?: string;
  systemPath?: string;
  messageShape: MessageShape;
}

interface ToolCallShape {
  indexKey: string;
  idKey?: string;
  namePath: string;
  argsPath: string;
}

interface UsageShape {
  inputKey: string;
  outputKey: string;
}

interface ResponseMapping {
  format: "sse-json";
  textPath: string;
  toolCallsPath?: string;
  toolCallShape?: ToolCallShape;
  usagePath?: string;
  usageShape?: UsageShape;
  doneMarker?: string;
  finishPath?: string;
  finishMap?: Record<string, FinishReason>;
}

interface MappingFile {
  version: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  auth?: AuthMapping;
  request: RequestMapping;
  response: ResponseMapping;
}

const SUPPORTED_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------
// Adapter
// ------------------------------------------------------------------

export class CustomMappingAdapter implements ProviderAdapter {
  public readonly id = "custom-mapping";
  public readonly capabilities: AdapterCapabilities;

  private readonly fetchImpl: typeof fetch;

  /** Cache keyed by absolute path, so we parse the file once per path. */
  private readonly cache = new Map<string, MappingFile>();

  constructor(config?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = config?.fetchImpl ?? fetch;
    this.capabilities = getCapabilities("");
  }

  // ----------------------------------------------------------------
  // Mapping load + validation
  // ----------------------------------------------------------------

  private async loadMapping(
    config: AdapterConfig
  ): Promise<MappingFile> {
    const raw = config.extras?.customMappingFile;

    if (typeof raw !== "string" || raw.length === 0) {
      throw classifyProviderError({
        body: "customMappingFile is required for the custom protocol",
      });
    }

    const cached = this.cache.get(raw);
    if (cached) return cached;

    let text: string;

    try {
      text = await fs.readFile(raw, "utf8");
    } catch (err) {
      throw classifyProviderError({
        body:
          "cannot read mapping file " +
          raw +
          ": " +
          (err instanceof Error ? err.message : String(err)),
      });
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw classifyProviderError({
        body:
          "mapping file is not valid JSON: " +
          (err instanceof Error ? err.message : String(err)),
      });
    }

    const validated = validateMapping(parsed);
    this.cache.set(raw, validated);

    return validated;
  }

  // ----------------------------------------------------------------
  // URL + headers
  // ----------------------------------------------------------------

  private resolveUrl(
    mapping: MappingFile,
    baseUrl: string
  ): string {
    if (/^https?:\/\//i.test(mapping.url)) {
      return mapping.url;
    }

    const base = baseUrl.replace(/\/+$/, "");
    const path = mapping.url.startsWith("/")
      ? mapping.url
      : "/" + mapping.url;

    return base + path;
  }

  private buildHeaders(
    mapping: MappingFile,
    apiKey: string
  ): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    if (mapping.headers) {
      for (const [k, v] of Object.entries(mapping.headers)) {
        h[k] = v;
      }
    }

    if (mapping.auth) {
      h[mapping.auth.header] = mapping.auth.template.replace(
        "{key}",
        apiKey
      );
    }

    return h;
  }

  // ----------------------------------------------------------------
  // Request building
  // ----------------------------------------------------------------

  private setPath(
    root: Record<string, unknown>,
    dotted: string,
    value: unknown
  ): void {
    const parts = dotted
      .split(".")
      .filter((p) => p.length > 0);

    if (parts.length === 0) return;

    let cursor: Record<string, unknown> = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const next = cursor[key];

      if (typeof next !== "object" || next === null) {
        cursor[key] = {};
      }

      cursor = cursor[key] as Record<string, unknown>;
    }

    cursor[parts[parts.length - 1]] = value;
  }

  private shapeMessage(
    msg: ChatMessage,
    shape: MessageShape
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    out[shape.roleKey] = msg.role;

    // Tool result message.
    if (msg.role === "tool") {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");

      out[shape.contentKey] = text;

      if (shape.toolCallIdKey) {
        out[shape.toolCallIdKey] = msg.toolCallId ?? "";
      }

      return out;
    }

    // Assistant with tool calls.
    if (
      msg.role === "assistant" &&
      msg.toolCalls &&
      msg.toolCalls.length > 0 &&
      shape.toolCallsKey
    ) {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");

      if (text.length > 0) {
        out[shape.contentKey] = text;
      }

      out[shape.toolCallsKey] = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.argumentsJson,
        },
      }));

      return out;
    }

    // Regular message — text only or multimodal array.
    const hasImage = msg.parts.some(
      (p) => p.kind === "image"
    );

    if (!hasImage) {
      const text = msg.parts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");

      out[shape.contentKey] = text;
    } else {
      out[shape.contentKey] = msg.parts.map((p) =>
        shapePart(p)
      );
    }

    return out;
  }

  private buildBody(
    mapping: MappingFile,
    request: ChatRequest
  ): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    const req = mapping.request;

    this.setPath(root, req.modelPath, request.model);

    const shaped: Record<string, unknown>[] = [];
    const systems: string[] = [];

    for (const m of request.messages) {
      if (m.role === "system" && req.systemPath) {
        const text = m.parts
          .map((p) => (p.kind === "text" ? p.text : ""))
          .join("\n");

        if (text.length > 0) {
          systems.push(text);
        }

        continue;
      }

      shaped.push(
        this.shapeMessage(m, req.messageShape)
      );
    }

    this.setPath(root, req.messagesPath, shaped);

    if (req.systemPath && systems.length > 0) {
      this.setPath(
        root,
        req.systemPath,
        systems.join("\n\n")
      );
    }

    if (req.streamPath) {
      this.setPath(
        root,
        req.streamPath,
        req.streamValue ?? true
      );
    }

    if (
      req.temperaturePath &&
      typeof request.temperature === "number"
    ) {
      this.setPath(
        root,
        req.temperaturePath,
        request.temperature
      );
    }

    if (
      req.maxTokensPath &&
      typeof request.maxOutputTokens === "number"
    ) {
      this.setPath(
        root,
        req.maxTokensPath,
        request.maxOutputTokens
      );
    }

    if (
      req.toolsPath &&
      request.tools &&
      request.tools.length > 0
    ) {
      this.setPath(
        root,
        req.toolsPath,
        request.tools.map((t) => this.shapeTool(t))
      );
    }

    return root;
  }

  private shapeTool(t: ToolSchema): unknown {
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
  // Handshake
  // ----------------------------------------------------------------

  public async handshake(
    config: AdapterConfig
  ): Promise<void> {
    const mapping = await this.loadMapping(config);
    const url = this.resolveUrl(
      mapping,
      config.baseUrl
    );

    const body = this.buildBody(mapping, {
      model: config.model,
      messages: [
        {
          role: "user",
          parts: [{ kind: "text", text: "hi" }],
        },
      ],
      maxOutputTokens: 1,
    });

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      HANDSHAKE_TIMEOUT_MS
    );

    try {
      const res = await this.fetchImpl(url, {
        method: mapping.method ?? "POST",
        headers: {
          ...this.buildHeaders(mapping, config.apiKey),
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await safeJson(res);

        throw classifyProviderError({
          status: res.status,
          body: errBody,
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
    const mapping = await this.loadMapping(config);
    const url = this.resolveUrl(
      mapping,
      config.baseUrl
    );

    const body = this.buildBody(mapping, request);

    const controller = new AbortController();
    const onAbort = () => controller.abort();

    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        request.signal.addEventListener(
          "abort",
          onAbort,
          { once: true }
        );
      }
    }

    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_TIMEOUT_MS
    );

    let res: Response;

    try {
      res = await this.fetchImpl(url, {
        method: mapping.method ?? "POST",
        headers: this.buildHeaders(
          mapping,
          config.apiKey
        ),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);

      if (request.signal) {
        request.signal.removeEventListener(
          "abort",
          onAbort
        );
      }

      throw normalizeError(err);
    }

    if (!res.ok) {
      const errBody = await safeJson(res);

      clearTimeout(timer);

      if (request.signal) {
        request.signal.removeEventListener(
          "abort",
          onAbort
        );
      }

      throw classifyProviderError({
        status: res.status,
        body: errBody,
      });
    }

    if (!res.body) {
      clearTimeout(timer);

      if (request.signal) {
        request.signal.removeEventListener(
          "abort",
          onAbort
        );
      }

      throw classifyProviderError({
        status: res.status,
        body: "no response body",
      });
    }

    const resp = mapping.response;

    // Map tool-call index → id, so deltas can be attached to the right call.
    const toolIds = new Map<number, string>();
    const toolNames = new Map<number, string>();

    let finishReason: FinishReason = "stop";
    let sawToolCalls = false;

    try {
      for await (const data of parseSse(res.body)) {
        if (
          resp.doneMarker &&
          data === resp.doneMarker
        ) {
          break;
        }

        let frame: unknown;

        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }

        // --- Text delta ---
        const text = readPath(
          frame,
          resp.textPath
        );

        if (
          typeof text === "string" &&
          text.length > 0
        ) {
          yield {
            type: "text-delta",
            text,
          };
        }

        // --- Tool calls ---
        if (
          resp.toolCallsPath &&
          resp.toolCallShape
        ) {
          const calls = readPath(
            frame,
            resp.toolCallsPath
          );

          if (Array.isArray(calls)) {
            for (const raw of calls) {
              const shaped = this.readToolCall(
                raw,
                resp.toolCallShape,
                toolIds,
                toolNames
              );

              if (shaped) {
                sawToolCalls = true;
                yield shaped.event;
              }
            }
          }
        }

        // --- Usage ---
        if (
          resp.usagePath &&
          resp.usageShape
        ) {
          const u = readPath(
            frame,
            resp.usagePath
          );

          if (u && typeof u === "object") {
            const o = u as Record<string, unknown>;

            const input =
              o[resp.usageShape.inputKey];

            const output =
              o[resp.usageShape.outputKey];

            if (
              typeof input === "number" ||
              typeof output === "number"
            ) {
              yield {
                type: "usage",
                inputTokens:
                  typeof input === "number"
                    ? input
                    : 0,
                outputTokens:
                  typeof output === "number"
                    ? output
                    : 0,
              };
            }
          }
        }

        // --- Finish reason ---
        if (resp.finishPath) {
          const fr = readPath(
            frame,
            resp.finishPath
          );

          if (typeof fr === "string") {
            finishReason = this.mapFinish(
              fr,
              resp.finishMap,
              sawToolCalls
            );
          }
        }
      }

      // Close any tool calls still open.
      for (const id of toolIds.values()) {
        yield {
          type: "tool-call-end",
          id,
        };
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

  private readToolCall(
    raw: unknown,
    shape: ToolCallShape,
    toolIds: Map<number, string>,
    toolNames: Map<number, string>
  ): { event: AdapterEvent } | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const o = raw as Record<string, unknown>;

    const indexRaw = o[shape.indexKey];
    const index =
      typeof indexRaw === "number"
        ? indexRaw
        : 0;

    // Start: an id + name appear.
    const idRaw = shape.idKey
      ? o[shape.idKey]
      : undefined;

    const id =
      typeof idRaw === "string"
        ? idRaw
        : undefined;

    const nameRaw = readPath(
      raw,
      shape.namePath
    );

    const name =
      typeof nameRaw === "string"
        ? nameRaw
        : undefined;

    if (
      id &&
      name &&
      !toolIds.has(index)
    ) {
      toolIds.set(index, id);
      toolNames.set(index, name);

      return {
        event: {
          type: "tool-call-start",
          id,
          name,
        },
      };
    }

    // Delta: arguments chunk.
    const argsRaw = readPath(
      raw,
      shape.argsPath
    );

    if (typeof argsRaw === "string") {
      const knownId =
        id ?? toolIds.get(index);

      if (knownId) {
        return {
          event: {
            type: "tool-call-delta",
            id: knownId,
            argumentsDelta: argsRaw,
          },
        };
      }
    }

    return null;
  }

  private mapFinish(
    raw: string,
    map: Record<string, FinishReason> | undefined,
    sawToolCalls: boolean
  ): FinishReason {
    if (
      map &&
      Object.prototype.hasOwnProperty.call(map, raw)
    ) {
      return map[raw];
    }

    switch (raw) {
      case "stop":
      case "end_turn":
        return sawToolCalls
          ? "tool-calls"
          : "stop";

      case "tool_calls":
      case "tool_use":
      case "function_call":
        return "tool-calls";

      case "length":
      case "max_tokens":
        return "length";

      default:
        return sawToolCalls
          ? "tool-calls"
          : "stop";
    }
  }
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

function validateMapping(
  input: unknown
): MappingFile {
  if (!input || typeof input !== "object") {
    throw classifyProviderError({
      body: "mapping file must be a JSON object",
    });
  }

  const o = input as Record<string, unknown>;

  if (o.version !== SUPPORTED_VERSION) {
    throw classifyProviderError({
      body:
        "unsupported mapping version: " +
        String(o.version),
    });
  }

  if (
    typeof o.url !== "string" ||
    o.url.length === 0
  ) {
    throw classifyProviderError({
      body: "mapping.url is required",
    });
  }

  if (
    o.method !== undefined &&
    typeof o.method !== "string"
  ) {
    throw classifyProviderError({
      body: "mapping.method must be a string",
    });
  }

  if (
    o.headers !== undefined &&
    (typeof o.headers !== "object" ||
      o.headers === null)
  ) {
    throw classifyProviderError({
      body: "mapping.headers must be an object",
    });
  }

  let auth: AuthMapping | undefined;

  if (o.auth !== undefined) {
    const a = o.auth as Record<string, unknown>;

    if (
      typeof a.header !== "string" ||
      typeof a.template !== "string"
    ) {
      throw classifyProviderError({
        body:
          "mapping.auth requires {header, template}",
      });
    }

    if (!a.template.includes("{key}")) {
      throw classifyProviderError({
        body:
          "mapping.auth.template must contain {key}",
      });
    }

    auth = {
      header: a.header,
      template: a.template,
    };
  }

  const req = o.request as
    | Record<string, unknown>
    | undefined;

  if (!req || typeof req !== "object") {
    throw classifyProviderError({
      body: "mapping.request is required",
    });
  }

  if (
    typeof req.modelPath !== "string" ||
    typeof req.messagesPath !== "string"
  ) {
    throw classifyProviderError({
      body:
        "mapping.request.{modelPath, messagesPath} are required",
    });
  }

  const ms = req.messageShape as
    | Record<string, unknown>
    | undefined;

  if (
    !ms ||
    typeof ms.roleKey !== "string" ||
    typeof ms.contentKey !== "string"
  ) {
    throw classifyProviderError({
      body:
        "mapping.request.messageShape.{roleKey, contentKey} are required",
    });
  }

  const request: RequestMapping = {
    modelPath: req.modelPath,
    messagesPath: req.messagesPath,

    messageShape: {
      roleKey: ms.roleKey,
      contentKey: ms.contentKey,

      ...(typeof ms.toolCallIdKey === "string"
        ? {
            toolCallIdKey: ms.toolCallIdKey,
          }
        : {}),

      ...(typeof ms.toolCallsKey === "string"
        ? {
            toolCallsKey: ms.toolCallsKey,
          }
        : {}),
    },

    ...(typeof req.streamPath === "string"
      ? { streamPath: req.streamPath }
      : {}),

    ...(typeof req.streamValue === "boolean"
      ? { streamValue: req.streamValue }
      : {}),

    ...(typeof req.temperaturePath === "string"
      ? { temperaturePath: req.temperaturePath }
      : {}),

    ...(typeof req.maxTokensPath === "string"
      ? { maxTokensPath: req.maxTokensPath }
      : {}),

    ...(typeof req.toolsPath === "string"
      ? { toolsPath: req.toolsPath }
      : {}),

    ...(typeof req.systemPath === "string"
      ? { systemPath: req.systemPath }
      : {}),
  };

  const respRaw = o.response as
    | Record<string, unknown>
    | undefined;

  if (
    !respRaw ||
    typeof respRaw !== "object"
  ) {
    throw classifyProviderError({
      body: "mapping.response is required",
    });
  }

  if (respRaw.format !== "sse-json") {
    throw classifyProviderError({
      body:
        'mapping.response.format must be "sse-json" (only supported format)',
    });
  }

  if (typeof respRaw.textPath !== "string") {
    throw classifyProviderError({
      body:
        "mapping.response.textPath is required",
    });
  }

  let toolCallShape:
    | ToolCallShape
    | undefined;

  if (respRaw.toolCallShape !== undefined) {
    const ts =
      respRaw.toolCallShape as Record<
        string,
        unknown
      >;

    if (
      typeof ts.indexKey !== "string" ||
      typeof ts.namePath !== "string" ||
      typeof ts.argsPath !== "string"
    ) {
      throw classifyProviderError({
        body:
          "mapping.response.toolCallShape requires {indexKey, namePath, argsPath}",
      });
    }

    toolCallShape = {
      indexKey: ts.indexKey,
      namePath: ts.namePath,
      argsPath: ts.argsPath,

      ...(typeof ts.idKey === "string"
        ? { idKey: ts.idKey }
        : {}),
    };
  }

  let usageShape:
    | UsageShape
    | undefined;

  if (respRaw.usageShape !== undefined) {
    const us =
      respRaw.usageShape as Record<
        string,
        unknown
      >;

    if (
      typeof us.inputKey !== "string" ||
      typeof us.outputKey !== "string"
    ) {
      throw classifyProviderError({
        body:
          "mapping.response.usageShape requires {inputKey, outputKey}",
      });
    }

    usageShape = {
      inputKey: us.inputKey,
      outputKey: us.outputKey,
    };
  }

  let finishMap:
    | Record<string, FinishReason>
    | undefined;

  if (respRaw.finishMap !== undefined) {
    if (
      typeof respRaw.finishMap !== "object" ||
      respRaw.finishMap === null
    ) {
      throw classifyProviderError({
        body:
          "mapping.response.finishMap must be an object",
      });
    }

    const out: Record<
      string,
      FinishReason
    > = {};

    for (const [k, v] of Object.entries(
      respRaw.finishMap as Record<
        string,
        unknown
      >
    )) {
      if (
        v === "stop" ||
        v === "tool-calls" ||
        v === "length" ||
        v === "error" ||
        v === "aborted"
      ) {
        out[k] = v;
      }
    }

    finishMap = out;
  }

  const response: ResponseMapping = {
    format: "sse-json",
    textPath: respRaw.textPath,

    ...(typeof respRaw.toolCallsPath === "string"
      ? {
          toolCallsPath:
            respRaw.toolCallsPath,
        }
      : {}),

    ...(toolCallShape
      ? { toolCallShape }
      : {}),

    ...(typeof respRaw.usagePath === "string"
      ? {
          usagePath:
            respRaw.usagePath,
        }
      : {}),

    ...(usageShape
      ? { usageShape }
      : {}),

    ...(typeof respRaw.doneMarker === "string"
      ? {
          doneMarker:
            respRaw.doneMarker,
        }
      : {}),

    ...(typeof respRaw.finishPath === "string"
      ? {
          finishPath:
            respRaw.finishPath,
        }
      : {}),

    ...(finishMap
      ? { finishMap }
      : {}),
  };

  return {
    version: SUPPORTED_VERSION,
    url: o.url,

    ...(typeof o.method === "string"
      ? { method: o.method }
      : {}),

    ...(o.headers
      ? {
          headers:
            o.headers as Record<
              string,
              string
            >,
        }
      : {}),

    ...(auth ? { auth } : {}),
    request,
    response,
  };
}

// ------------------------------------------------------------------
// Dotted-path reader
// ------------------------------------------------------------------

/**
 * Read a dotted path from a JSON value. Numeric segments index arrays.
 * Returns undefined for any missing branch — never throws.
 */
function readPath(
  root: unknown,
  dotted: string
): unknown {
  if (!dotted || dotted.length === 0) {
    return undefined;
  }

  const parts = dotted
    .split(".")
    .filter((p) => p.length > 0);

  let cursor: unknown = root;

  for (const p of parts) {
    if (
      cursor === null ||
      cursor === undefined
    ) {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      const idx = Number(p);

      if (
        !Number.isInteger(idx) ||
        idx < 0 ||
        idx >= cursor.length
      ) {
        return undefined;
      }

      cursor = cursor[idx];
    } else if (
      typeof cursor === "object"
    ) {
      cursor = (
        cursor as Record<string, unknown>
      )[p];
    } else {
      return undefined;
    }
  }

  return cursor;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function shapePart(
  p: ContentPart
): unknown {
  if (p.kind === "text") {
    return {
      type: "text",
      text: p.text,
    };
  }

  return {
    type: "image_url",
    image_url: {
      url:
        "data:" +
        p.mimeType +
        ";base64," +
        p.base64,
    },
  };
}

function isAbort(
  err: unknown
): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const e = err as {
    name?: string;
    code?: string;
  };

  return (
    e.name === "AbortError" ||
    e.code === "ABORT_ERR"
  );
}

async function safeJson(
  res: Response
): Promise<unknown> {
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
// SSE parser
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

      let f: {
        end: number;
        len: number;
      } | null;

      while (
        (f = findFrameEnd(buffer)) !== null
      ) {
        const frame = buffer.slice(
          0,
          f.end
        );

        buffer = buffer.slice(
          f.end + f.len
        );

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

  if (lf === -1 && crlf === -1) {
    return null;
  }

  if (lf === -1) {
    return {
      end: crlf,
      len: 4,
    };
  }

  if (crlf === -1) {
    return {
      end: lf,
      len: 2,
    };
  }

  return lf < crlf
    ? {
        end: lf,
        len: 2,
      }
    : {
        end: crlf,
        len: 4,
      };
}

function extractData(
  frame: string
): string | null {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line
      .slice(5)
      .replace(/^ /, "");

    dataLines.push(payload);
  }

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join("\n");
}