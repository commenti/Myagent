/**
 * src/providers/ProtocolDetector.ts
 * ---------------------------------
 * Auto-detects which provider protocol a given (baseUrl, apiKey, model) speaks.
 *
 * Detection order (per ARCHITECTURE.md §6):
 *   openai → anthropic → google → custom-mapping
 *
 * If AdapterConfig.protocol is set, only that protocol is tried.
 * If the chosen protocol is "custom", extras.customMappingFile is required.
 *
 * Returns the first adapter whose handshake succeeds, plus the config that
 * was used. Throws a ProviderError with a per-protocol summary if all fail.
 */

import type {
  AdapterConfig,
  ProviderAdapter,
} from "./AdapterBase";
import { ProviderError, type ProviderErrorType } from "./ErrorClassifier";

import { OpenAICompatibleAdapter } from "./OpenAICompatibleAdapter";
import { AnthropicCompatibleAdapter } from "./AnthropicCompatibleAdapter";
import { GoogleCompatibleAdapter } from "./GoogleCompatibleAdapter";
import { CustomMappingAdapter } from "./CustomMappingAdapter";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type ProtocolName = "openai" | "anthropic" | "google" | "custom";

export interface DetectInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Pin a protocol instead of auto-detecting. */
  readonly protocol?: ProtocolName;
  /** Required only when protocol === "custom". */
  readonly customMappingFile?: string;
  /** Extra headers or adapter-specific fields (passed through to the adapter). */
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface DetectResult {
  readonly protocol: ProtocolName;
  readonly adapter: ProviderAdapter;
  readonly config: AdapterConfig;
  /** One line per protocol tried, English only — for logs / TUI. */
  readonly attempts: readonly DetectAttempt[];
}

export interface DetectAttempt {
  readonly protocol: ProtocolName;
  readonly ok: boolean;
  readonly errorType?: ProviderErrorType;
  readonly errorMessage?: string;
}


// ------------------------------------------------------------------
// Adapter construction
// ------------------------------------------------------------------

function makeAdapter(protocol: ProtocolName): ProviderAdapter {
  switch (protocol) {
    case "openai":
      return new OpenAICompatibleAdapter();
    case "anthropic":
      return new AnthropicCompatibleAdapter();
    case "google":
      return new GoogleCompatibleAdapter();
    case "custom":
      return new CustomMappingAdapter();
  }
}

const AUTO_ORDER: readonly ProtocolName[] = [
  "openai",
  "anthropic",
  "google",
  "custom",
];


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Try to detect a working protocol for the given credentials.
 * Never partially succeeds: either returns a full result or throws.
 */
export async function detectProtocol(input: DetectInput): Promise<DetectResult> {
  const order: readonly ProtocolName[] = input.protocol
    ? [input.protocol]
    : AUTO_ORDER;

  const attempts: DetectAttempt[] = [];

  for (const protocol of order) {
    // Custom mapping requires the file path up front — skip if missing.
    if (protocol === "custom" && !input.customMappingFile) {
      attempts.push({
        protocol,
        ok: false,
        errorType: "bad_request",
        errorMessage: "custom protocol selected but customMappingFile is missing",
      });
      continue;
    }

    const extras: Record<string, unknown> = {
      ...(input.extras ?? {}),
    };
    if (input.customMappingFile) {
      extras.customMappingFile = input.customMappingFile;
    }

    const config: AdapterConfig = {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      extras: Object.keys(extras).length > 0 ? extras : undefined,
    };

    const adapter = makeAdapter(protocol);

    try {
      await adapter.handshake(config);
      attempts.push({ protocol, ok: true });
      return { protocol, adapter, config, attempts };
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError({
              type: "unknown",
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            });

      attempts.push({
        protocol,
        ok: false,
        errorType: pe.type,
        errorMessage: pe.message,
      });

      // If the user pinned a protocol, do NOT fall through to others.
      if (input.protocol) break;
    }
  }

  // All attempts failed.
  const summary = attempts
    .map((a) => `${a.protocol}: ${a.errorType ?? "error"} — ${a.errorMessage ?? ""}`)
    .join(" | ");

  // Pick the most informative error type to surface: auth/quota are the
  // user's fault and worth surfacing; unknown/network are generic.
  const priority: readonly ProviderErrorType[] = [
    "auth_invalid",
    "model_not_found",
    "quota_exceeded",
    "content_blocked",
    "bad_request",
    "server_error",
    "network_error",
    "unknown",
  ];
  let chosen: ProviderErrorType = "unknown";
  for (const p of priority) {
    if (attempts.some((a) => a.errorType === p)) {
      chosen = p;
      break;
    }
  }

  throw new ProviderError({
    type: chosen,
    message: `Protocol detection failed. Tried: ${summary}`,
    retryable: chosen === "network_error" || chosen === "server_error",
  });
}


/** Convenience: just the protocol name, or null on failure. */
export async function detectProtocolName(
  input: DetectInput
): Promise<ProtocolName | null> {
  try {
    const result = await detectProtocol(input);
    return result.protocol;
  } catch {
    return null;
  }
}