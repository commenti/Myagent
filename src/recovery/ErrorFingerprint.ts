/**
 * src/recovery/ErrorFingerprint.ts
 * --------------------------------
 * Produces a stable signature ("fingerprint") from raw error output so the
 * FailureLedger can detect repeats of the SAME error, even when line numbers,
 * paths, timestamps, or hashes differ between occurrences.
 *
 * Used by:
 *   • recovery/FailureLedger — counts repeats of the same error.
 *   • orchestrator/StateMachine — decides "approach must change" on 2nd hit.
 *
 * No I/O. No network. Pure functions.
 */

import * as crypto from "crypto";


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type ErrorCategory =
  | "compile"       // tsc / syntax / type error
  | "test"          // test runner failure
  | "lint"          // linter complaint
  | "runtime"       // process threw at runtime
  | "timeout"       // command exceeded time
  | "network"       // provider / fetch failure
  | "permission"    // denied by policy
  | "unknown";

export interface Fingerprint {
  /** Short hex digest — stable for equivalent errors. */
  readonly hash: string;
  /** Category inferred from the shape of the output. */
  readonly category: ErrorCategory;
  /** First meaningful line, trimmed — for display, not comparison. */
  readonly headline: string;
}


// ------------------------------------------------------------------
// Normalization
// ------------------------------------------------------------------

// Order matters: more specific patterns first.

const NORMALIZERS: ReadonlyArray<readonly [RegExp, string]> = [
  // Absolute POSIX paths (keep last segment as a hint)
  [/\/(?:[^\s/]+\/)+([^\s/:]+)/g, "<path>/$1"],
  // Windows paths
  [/[A-Za-z]:\\(?:[^\s\\]+\\)+([^\s\\:]+)/g, "<path>\\$1"],
  // file:line:col  →  file:<L>:<C>
  [/:(\d+):(\d+)\b/g, ":<L>:<C>"],
  // standalone line:number (test frameworks)
  [/\bline\s+\d+\b/gi, "line <N>"],
  // ANSI color escape sequences
  [/\x1b\[[0-9;]*m/g, ""],
  // ISO timestamps
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>"],
  // git SHAs / long hex (>= 7 chars)
  [/\b[0-9a-f]{7,64}\b/gi, "<hex>"],
  // UUIDs
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  // Long decimal numbers (ports, pids, byte counts)
  [/\b\d{4,}\b/g, "<num>"],
  // Durations
  [/\b\d+(?:\.\d+)?\s*(ms|s|sec|seconds|m|min|minutes)\b/gi, "<dur>"],
  // Quoted strings — collapse to keep the shape but drop the literal
  [/"[^"\n]{0,200}"/g, '"<s>"'],
  [/'[^'\n]{0,200}'/g, "'<s>'"],
  // Collapse whitespace
  [/\s+/g, " "],
];

function normalizeLine(line: string): string {
  let out = line;
  for (const [re, rep] of NORMALIZERS) {
    out = out.replace(re, rep);
  }
  return out.trim();
}


// ------------------------------------------------------------------
// Category detection
// ------------------------------------------------------------------

const CATEGORY_HINTS: ReadonlyArray<readonly [ErrorCategory, RegExp]> = [
  ["timeout",    /\b(timed?\s*out|timeout|exceeded.*time|deadline)\b/i],
  ["compile",    /\b(TS\d{3,5}|error TS|SyntaxError|TypeError: .* is not assignable|Cannot find module)\b/],
  ["test",       /\b(FAIL|✗|✘|AssertionError|expected .* to (be|equal)|tests? failed|test suite failed)\b/i],
  ["lint",       /\b(eslint|tslint|Lint|warning\s+\S+\s+@|prettier)\b/i],
  ["permission", /\b(EACCES|EPERM|permission denied|not permitted|policy blocked)\b/i],
  ["network",    /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|TLS)\b/i],
  ["runtime",    /\b(Error:|Exception|throw|unhandledRejection|uncaughtException)\b/],
];

function detectCategory(raw: string): ErrorCategory {
  for (const [cat, re] of CATEGORY_HINTS) {
    if (re.test(raw)) return cat;
  }
  return "unknown";
}


// ------------------------------------------------------------------
// Headline extraction
// ------------------------------------------------------------------

const NOISE_PREFIXES = [
  "at ",
  "from ",
  "caused by:",
  "stack trace:",
];

function pickHeadline(raw: string): string {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    const low = t.toLowerCase();
    if (NOISE_PREFIXES.some((p) => low.startsWith(p))) continue;
    // Skip pure separators
    if (/^[-=*_]{3,}$/.test(t)) continue;
    return t.length > 200 ? t.slice(0, 200) + "…" : t;
  }
  return "(empty error output)";
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export interface FingerprintInput {
  /** Raw combined stdout+stderr, or any error text. */
  readonly output: string;
  /** Optional: the command that produced it (helps disambiguate). */
  readonly command?: string;
  /** Optional: exit code, if known. */
  readonly exitCode?: number;
}

/**
 * Build a stable fingerprint. The `hash` is what the ledger compares.
 * Never throws.
 */
export function fingerprint(input: FingerprintInput): Fingerprint {
  const output = typeof input.output === "string" ? input.output : String(input.output ?? "");
  const command = typeof input.command === "string" ? input.command : "";

  const headline = pickHeadline(output);
  const category = detectCategory(output);

  // Take the first ~20 non-empty lines — enough shape, avoids runaway tail.
  const meaningfulLines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 20)
    .map(normalizeLine);

  // Command + exit code + normalized body = the signature.
  const basis = [
    `cmd=${normalizeLine(command)}`,
    `exit=${input.exitCode ?? "?"}`,
    `cat=${category}`,
    ...meaningfulLines,
  ].join("\n");

  const hash = crypto
    .createHash("sha256")
    .update(basis, "utf8")
    .digest("hex")
    .slice(0, 16);

  return { hash, category, headline };
}

/** Convenience: just the hash. */
export function fingerprintHash(input: FingerprintInput): string {
  return fingerprint(input).hash;
}

/** True if two inputs produce the same fingerprint. */
export function isSameError(a: FingerprintInput, b: FingerprintInput): boolean {
  return fingerprint(a).hash === fingerprint(b).hash;
}