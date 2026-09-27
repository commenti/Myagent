/**
 * src/providers/AdapterBase.ts
 * ----------------------------
 * The contract every provider adapter implements, plus the shared types
 * that flow through the whole provider layer.
 *
 * No I/O. No network. This file is pure types + one abstract class.
 *
 * Conventions:
 *   • Messages use a provider-neutral shape (see ChatMessage).
 *   • Streaming is exposed as an async iterable of AdapterEvent.
 *   • Errors are ALWAYS thrown as ProviderError (see ErrorClassifier).
 */

import type { ProviderErrorType } from "./ErrorClassifier";


// ------------------------------------------------------------------
// Messages (provider-neutral)
// ------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  readonly kind: "text";
  readonly text: string;
}

export interface ImagePart {
  readonly kind: "image";
  /** Base64 payload (no data: prefix). */
  readonly base64: string;
  /** e.g. "image/png". */
  readonly mimeType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON arguments as a string (parsed by the tool layer, not here). */
  readonly argumentsJson: string;
}

export interface ChatMessage {
  readonly role: Role;
  /** For "tool" role: the id of the tool call this message answers. */
  readonly toolCallId?: string;
  /** For "assistant" role: any tool calls the model requested. */
  readonly toolCalls?: readonly ToolCall[];
  /** Text and/or images. A message may have both. */
  readonly parts: readonly ContentPart[];
}

export function textMessage(role: Role, text: string): ChatMessage {
  return { role, parts: [{ kind: "text", text }] };
}


// ------------------------------------------------------------------
// Tool schema (what we advertise to the model)
// ------------------------------------------------------------------

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object describing the tool's arguments. */
  readonly parameters: Record<string, unknown>;
}


// ------------------------------------------------------------------
// Request / response options
// ------------------------------------------------------------------

export type Effort = "low" | "medium" | "high";

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSchema[];
  readonly effort?: Effort;
  /** Provider-specific escape hatch; adapters may ignore. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** AbortSignal so callers can cancel a stream. */
  readonly signal?: AbortSignal;
}


// ------------------------------------------------------------------
// Streaming events
// ------------------------------------------------------------------

export interface TextDeltaEvent {
  readonly type: "text-delta";
  readonly text: string;
}

export interface ToolCallStartEvent {
  readonly type: "tool-call-start";
  readonly id: string;
  readonly name: string;
}

export interface ToolCallDeltaEvent {
  readonly type: "tool-call-delta";
  readonly id: string;
  /** Partial JSON arguments chunk. */
  readonly argumentsDelta: string;
}

export interface ToolCallEndEvent {
  readonly type: "tool-call-end";
  readonly id: string;
}

export interface UsageEvent {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface DoneEvent {
  readonly type: "done";
  /** Why the stream stopped, in provider-neutral terms. */
  readonly finishReason: FinishReason;
}

export type FinishReason = "stop" | "tool-calls" | "length" | "error" | "aborted";

export type AdapterEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | UsageEvent
  | DoneEvent;


// ------------------------------------------------------------------
// Adapter capabilities
// ------------------------------------------------------------------

export interface AdapterCapabilities {
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsImages: boolean;
  readonly supportsThinking: boolean;
  /** Max context window in tokens, if known. 0 = unknown. */
  readonly contextWindow: number;
}


// ------------------------------------------------------------------
// Adapter configuration (what ProtocolDetector hands to an adapter)
// ------------------------------------------------------------------

export interface AdapterConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Provider-specific extras (custom mapping file path, headers, etc). */
  readonly extras?: Readonly<Record<string, unknown>>;
}


// ------------------------------------------------------------------
// ProviderError type name — re-exported for adapter authors
// ------------------------------------------------------------------

export type { ProviderErrorType };


// ------------------------------------------------------------------
// The adapter contract
// ------------------------------------------------------------------

export interface ProviderAdapter {
  /** Stable id, e.g. "openai-compatible". */
  readonly id: string;

  /** What this adapter (with this config) can do. */
  readonly capabilities: AdapterCapabilities;

  /**
   * A cheap, minimal call used by ProtocolDetector to confirm the endpoint
   * speaks this protocol and the key is valid. Must NOT stream.
   * Should complete in a few seconds or throw.
   */
  handshake(config: AdapterConfig): Promise<void>;

  /**
   * Stream a chat completion. MUST yield AdapterEvent values and end with a
   * DoneEvent. All failures MUST be thrown as ProviderError.
   */
  streamChat(
    config: AdapterConfig,
    request: ChatRequest
  ): AsyncIterable<AdapterEvent>;
}