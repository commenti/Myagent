/**
 * src/providers/CapabilityRegistry.ts
 * -----------------------------------
 * Static knowledge about model capabilities, keyed by a normalized model id.
 *
 * Used by:
 *   • context/TokenBudget  — to know the context window size.
 *   • orchestrator         — to know if tools / thinking are available.
 *   • providers/*Adapter   — to advertise AdapterCapabilities.
 *
 * Lookup order:
 *   1. Exact match (lowercased model id).
 *   2. Prefix match (longest key that is a prefix of the id) — e.g. "gpt-4o"
 *      matches "gpt-4o-2024-08-06".
 *   3. Fallback: a conservative default (tools on, 8k context).
 *
 * No network. No I/O. Pure lookup.
 * A user-supplied override can be registered at runtime (see registerOverride).
 */

import type { AdapterCapabilities } from "./AdapterBase";


// ------------------------------------------------------------------
// Known models
// ------------------------------------------------------------------
// Keys are lowercased and use no spaces. Add freely — order does not matter,
// prefix matching picks the longest match.
// ------------------------------------------------------------------

const KNOWN: Readonly<Record<string, AdapterCapabilities>> = {
  // --- OpenAI ---
  "gpt-4o": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 128_000,
  },
  "gpt-4o-mini": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 128_000,
  },
  "gpt-4-turbo": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 128_000,
  },
  "gpt-4": {
    supportsTools: true, supportsStreaming: true, supportsImages: false,
    supportsThinking: false, contextWindow: 8_192,
  },
  "gpt-3.5-turbo": {
    supportsTools: true, supportsStreaming: true, supportsImages: false,
    supportsThinking: false, contextWindow: 16_385,
  },
  "o1": {
    supportsTools: true, supportsStreaming: false, supportsImages: false,
    supportsThinking: true, contextWindow: 200_000,
  },
  "o3": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: true, contextWindow: 200_000,
  },

  // --- Anthropic ---
  "claude-3-5-sonnet": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 200_000,
  },
  "claude-3-5-haiku": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 200_000,
  },
  "claude-3-opus": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 200_000,
  },
  "claude-sonnet-4": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: true, contextWindow: 200_000,
  },
  "claude-opus-4": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: true, contextWindow: 200_000,
  },

  // --- Google ---
  "gemini-1.5-pro": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 1_000_000,
  },
  "gemini-1.5-flash": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 1_000_000,
  },
  "gemini-2.0-flash": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: false, contextWindow: 1_000_000,
  },
  "gemini-2.5-pro": {
    supportsTools: true, supportsStreaming: true, supportsImages: true,
    supportsThinking: true, contextWindow: 1_000_000,
  },

  // --- DeepSeek ---
  "deepseek-chat": {
    supportsTools: true, supportsStreaming: true, supportsImages: false,
    supportsThinking: false, contextWindow: 64_000,
  },
  "deepseek-reasoner": {
    supportsTools: false, supportsStreaming: true, supportsImages: false,
    supportsThinking: true, contextWindow: 64_000,
  },

  // --- Meta / Llama (common hosted ids) ---
  "llama-3.1-70b": {
    supportsTools: true, supportsStreaming: true, supportsImages: false,
    supportsThinking: false, contextWindow: 128_000,
  },
  "llama-3.1-405b": {
    supportsTools: true, supportsStreaming: true, supportsImages: false,
    supportsThinking: false, contextWindow: 128_000,
  },
};


// ------------------------------------------------------------------
// Conservative default for unknown models
// ------------------------------------------------------------------

export const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  supportsTools: true,
  supportsStreaming: true,
  supportsImages: false,
  supportsThinking: false,
  contextWindow: 8_192,
};


// ------------------------------------------------------------------
// Runtime overrides (per-process)
// ------------------------------------------------------------------

const overrides = new Map<string, AdapterCapabilities>();

/** Normalize a model id for lookup: lowercase, trim. */
function norm(model: string): string {
  return model.trim().toLowerCase();
}

/** Register a runtime override for a model id. */
export function registerOverride(model: string, caps: AdapterCapabilities): void {
  overrides.set(norm(model), caps);
}

/** Remove a runtime override (mostly useful in tests). */
export function clearOverride(model: string): void {
  overrides.delete(norm(model));
}

/** Clear all runtime overrides (mostly useful in tests). */
export function clearAllOverrides(): void {
  overrides.clear();
}


// ------------------------------------------------------------------
// Lookup
// ------------------------------------------------------------------

/**
 * Find the longest known key that is a prefix of the given model id.
 * Returns null if nothing matches.
 */
function findByPrefix(model: string): AdapterCapabilities | null {
  let bestKey = "";
  let bestCaps: AdapterCapabilities | null = null;

  for (const key of Object.keys(KNOWN)) {
    if (model === key || model.startsWith(key + "-") || model.startsWith(key + ".")) {
      if (key.length > bestKey.length) {
        bestKey = key;
        bestCaps = KNOWN[key];
      }
    }
  }
  return bestCaps;
}

/**
 * Resolve capabilities for a model id.
 * Order: exact override → exact known → prefix known → default.
 * Never throws.
 */
export function getCapabilities(model: string): AdapterCapabilities {
  const id = norm(model);
  if (id.length === 0) return DEFAULT_CAPABILITIES;

  const ov = overrides.get(id);
  if (ov) return ov;

  const exact = KNOWN[id];
  if (exact) return exact;

  const prefix = findByPrefix(id);
  if (prefix) return prefix;

  return DEFAULT_CAPABILITIES;
}

/** Convenience: just the context window, with a sane floor. */
export function getContextWindow(model: string): number {
  const n = getCapabilities(model).contextWindow;
  return n > 0 ? n : DEFAULT_CAPABILITIES.contextWindow;
}

/** True if this model id is explicitly known (not just a fallback). */
export function isKnownModel(model: string): boolean {
  const id = norm(model);
  if (overrides.has(id) || KNOWN[id]) return true;
  return findByPrefix(id) !== null;
}