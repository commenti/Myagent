/**
 * src/context/Summarizer.ts
 * -------------------------
 * Writes the summary text for an old slice of conversation history.
 *
 * CRITICAL (ARCHITECTURE.md §13.1):
 *   • This summarizes CONVERSATION HISTORY only — user instructions
 *     (AGENTS.md, global/project custom instructions) are NEVER passed here
 *     and are NEVER summarized.
 *   • The DECISION to summarize is made by Compaction, not here.
 *   • This is an ISOLATED call — a separate, small request that does not
 *     touch the main conversation.
 *
 * Design:
 *   • The actual model call is INJECTED (SummarizeFn) so this module stays
 *     pure, testable, and provider-agnostic. Compaction wires the real
 *     adapter + config.
 *   • Output is structured into three sections: Decisions, Progress, Facts.
 *   • If the model misbehaves, we fall back to a plain text summary — but we
 *     NEVER silently drop content.
 *
 * No direct network. No file I/O. Pure orchestration + parsing.
 */

import type {
  ChatMessage,
  ProviderAdapter,
  AdapterConfig,
  ChatRequest,
} from "../providers/AdapterBase";
import { normalizeError } from "../providers/ErrorClassifier";
import { estimateTokens } from "./TokenBudget";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface SummarizerInput {
  /** Old conversation entries to summarize (raw text form). */
  readonly transcript: string;
  /** Optional hint: what the work was about (topic, task id). */
  readonly topic?: string;
  /** Optional override for the model used (e.g. a cheaper summaryModel). */
  readonly model?: string;
  /** Optional max tokens for the summary itself. Default 800. */
  readonly maxOutputTokens?: number;
  /** AbortSignal so the caller can cancel. */
  readonly signal?: AbortSignal;
}

export interface SummarySections {
  /** Decisions made and why. Each item is one line. */
  readonly decisions: readonly string[];
  /** Progress — what was completed. Each item is one line. */
  readonly progress: readonly string[];
  /** Facts — technical details worth keeping. Each item is one line. */
  readonly facts: readonly string[];
}

export interface SummaryResult {
  readonly sections: SummarySections;
  /** Rendered markdown block ready to append to DECISIONS/PROGRESS. */
  readonly markdown: string;
  /** The raw text the model returned (for debugging / fallback). */
  readonly raw: string;
  /** True if we could not parse the model output and used the fallback. */
  readonly usedFallback: boolean;
  /** Rough estimate of tokens in the returned summary. */
  readonly estimatedTokens: number;
}


/**
 * The injected model-call. Takes a chat request, returns the model's full
 * text response. Implementations wire this to an actual adapter.
 */
export type SummarizeFn = (req: ChatRequest) => Promise<string>;

export class SummarizerError extends Error {
  public readonly code: "empty_input" | "model_error";
  constructor(code: SummarizerError["code"], message: string) {
    super(message);
    this.name = "SummarizerError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// The system prompt (English, minimal — this is a strict call)
// ------------------------------------------------------------------
// Deliberately does NOT include any project rules, AGENTS.md, or user
// instructions. It is purely a "compress this transcript" instruction.
// ------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a summarizer. You will be given a transcript of a coding session.

Produce a STRICT summary in exactly these three sections, nothing else:

DECISIONS:
- <one line per decision that was made and the reason>

PROGRESS:
- <one line per task that was completed>

FACTS:
- <one line per technical detail worth remembering>

Rules:
- Use English only.
- One bullet per line. No nested bullets. No prose paragraphs.
- Keep each bullet under 200 characters.
- If a section has no content, write it with no bullets.
- Do not add a preamble, closing remark, or commentary.
- Do not include code blocks. Reference symbols or paths in plain text.`;

const USER_TEMPLATE = (transcript: string, topic?: string): string => {
  const head = topic && topic.trim().length > 0
    ? `Session topic: ${topic.trim()}\n\n`
    : "";
  return `${head}Transcript follows.\n\n---\n${transcript}\n---\n\nWrite the three-section summary now.`;
};


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Produce a structured summary of a transcript using an isolated model call.
 * Never throws for a parse failure — falls back to a plain summary.
 * Throws SummarizerError only for empty input or a hard model error.
 */
export async function summarize(
  input: SummarizerInput,
  callModel: SummarizeFn
): Promise<SummaryResult> {
  if (!input.transcript || input.transcript.trim().length === 0) {
    throw new SummarizerError("empty_input", "transcript is empty — nothing to summarize");
  }

  const model = input.model && input.model.trim().length > 0 ? input.model : "";
  if (model.length === 0) {
    throw new SummarizerError(
      "model_error",
      "no model supplied to Summarizer (caller must pass the active profile model)"
    );
  }

  const messages: ChatMessage[] = [
    { role: "system", parts: [{ kind: "text", text: SYSTEM_PROMPT }] },
    {
      role: "user",
      parts: [{ kind: "text", text: USER_TEMPLATE(input.transcript, input.topic) }],
    },
  ];

  const req: ChatRequest = {
    model,
    messages,
    maxOutputTokens: input.maxOutputTokens ?? 800,
    ...(input.signal ? { signal: input.signal } : {}),
  };

  let raw: string;
  try {
    raw = await callModel(req);
  } catch (err) {
    const pe = normalizeError(err);
    throw new SummarizerError("model_error", `summarizer call failed: ${pe.message}`);
  }

  if (raw.trim().length === 0) {
    // Model returned nothing — do not lose the transcript silently.
    const sections = makeFallbackSections(input.transcript);
    return {
      sections,
      markdown: renderMarkdown(sections),
      raw: "",
      usedFallback: true,
      estimatedTokens: estimateTokens(renderMarkdown(sections)),
    };
  }

  const sections = parseSections(raw);
  const usedFallback = !sectionsOk(sections);

  if (usedFallback) {
    const fallback = makeFallbackSections(input.transcript);
    return {
      sections: fallback,
      markdown: renderMarkdown(fallback),
      raw,
      usedFallback: true,
      estimatedTokens: estimateTokens(renderMarkdown(fallback)),
    };
  }

  const markdown = renderMarkdown(sections);
  return {
    sections,
    markdown,
    raw,
    usedFallback: false,
    estimatedTokens: estimateTokens(markdown),
  };
}


// ------------------------------------------------------------------
// Convenience: wire a real adapter into a SummarizeFn
// ------------------------------------------------------------------

/**
 * Build a SummarizeFn from an adapter + config. Streams text deltas and
 * concatenates them. Tool calls in the response are ignored (this call
 * never advertises tools).
 */
export function makeAdapterSummarizeFn(
  adapter: ProviderAdapter,
  config: AdapterConfig
): SummarizeFn {
  return async (req: ChatRequest): Promise<string> => {
    let text = "";
    for await (const ev of adapter.streamChat(config, req)) {
      if (ev.type === "text-delta") text += ev.text;
      else if (ev.type === "done") break;
    }
    return text;
  };
}


// ------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------

const SECTION_HEADERS = ["DECISIONS", "PROGRESS", "FACTS"] as const;
type SectionName = (typeof SECTION_HEADERS)[number];

function parseSections(raw: string): SummarySections {
  const lines = raw.split(/\r?\n/);
  const buckets: Record<SectionName, string[]> = {
    DECISIONS: [],
    PROGRESS: [],
    FACTS: [],
  };

  let current: SectionName | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Header line: "DECISIONS:" or "**DECISIONS**" or "## DECISIONS"
    const headerMatch = matchHeader(trimmed);
    if (headerMatch) {
      current = headerMatch;
      continue;
    }

    if (current === null) continue;

    // Bullet line: "- text", "* text", "• text"
    const bullet = trimmed.replace(/^[-*•]\s*/, "");
    if (bullet.length === 0) continue;
    if (bullet.length > 400) continue; // ignore runaway lines
    buckets[current].push(bullet);
  }

  return {
    decisions: buckets.DECISIONS,
    progress: buckets.PROGRESS,
    facts: buckets.FACTS,
  };
}

function matchHeader(line: string): SectionName | null {
  // Strip markdown decorations: **, ##, trailing colon, whitespace.
  const cleaned = line
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/:+\s*$/, "")
    .trim()
    .toUpperCase();
  for (const h of SECTION_HEADERS) {
    if (cleaned === h) return h;
  }
  return null;
}

function sectionsOk(s: SummarySections): boolean {
  // A parse is "ok" if at least one section has at least one line.
  return s.decisions.length + s.progress.length + s.facts.length > 0;
}


// ------------------------------------------------------------------
// Fallback
// ------------------------------------------------------------------
// If the model refuses / returns nothing parseable, we do NOT lose the
// transcript: we keep a compact, honest note so the caller knows the
// original slice should stay in the archive.
// ------------------------------------------------------------------

function makeFallbackSections(transcript: string): SummarySections {
  const lines = transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const head = lines.slice(0, 5).map((l) => truncate(l, 180));
  const tail = lines.slice(-3).map((l) => truncate(l, 180));

  const facts: string[] = [];
  facts.push("Summary produced in fallback mode (model output was unusable).");
  if (head.length > 0) facts.push(`Early lines: ${head.join(" | ")}`);
  if (tail.length > 0) facts.push(`Late lines: ${tail.join(" | ")}`);

  return { decisions: [], progress: [], facts };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}


// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------

function renderMarkdown(s: SummarySections): string {
  const parts: string[] = [];
  parts.push("DECISIONS:");
  for (const d of s.decisions) parts.push(`- ${d}`);
  parts.push("");
  parts.push("PROGRESS:");
  for (const p of s.progress) parts.push(`- ${p}`);
  parts.push("");
  parts.push("FACTS:");
  for (const f of s.facts) parts.push(`- ${f}`);
  return parts.join("\n");
}