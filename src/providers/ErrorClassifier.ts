/**
 * src/providers/ErrorClassifier.ts
 * --------------------------------
 * Turns any raw error (HTTP status, network failure, provider-specific body)
 * into a single common vocabulary: ProviderErrorType.
 *
 * Also defines ProviderError — the ONLY error type adapters may throw.
 *
 * No network. No I/O. Pure classification + one Error subclass.
 */

// ------------------------------------------------------------------
// Common error vocabulary
// ------------------------------------------------------------------

export type ProviderErrorType =
  | "quota_exceeded"   // 429 / out-of-credits / rate limit
  | "model_not_found"  // 404 model / bad model name
  | "auth_invalid"     // 401 / 403 / bad or missing key
  | "network_error"    // DNS, TLS, connection reset, timeout
  | "server_error"     // 5xx from provider
  | "bad_request"      // 400 / malformed request we sent
  | "content_blocked"  // provider-side content policy refusal
  | "unknown";         // anything we could not classify


// ------------------------------------------------------------------
// ProviderError
// ------------------------------------------------------------------

export interface ProviderErrorInit {
  readonly type: ProviderErrorType;
  readonly message: string;
  readonly status?: number;
  /** Raw provider payload / body, kept for logging. */
  readonly raw?: unknown;
  /** Original error, if this wrapped something. */
  readonly cause?: unknown;
  /** Whether this is worth retrying with the same input. */
  readonly retryable?: boolean;
}

export class ProviderError extends Error {
  public readonly type: ProviderErrorType;
  public readonly status?: number;
  public readonly raw?: unknown;
  public readonly retryable: boolean;
  public override readonly cause?: unknown;

  constructor(init: ProviderErrorInit) {
    super(init.message);
    this.name = "ProviderError";
    this.type = init.type;
    this.status = init.status;
    this.raw = init.raw;
    this.cause = init.cause;
    this.retryable =
      init.retryable ??
      (init.type === "network_error" ||
        init.type === "server_error" ||
        init.type === "quota_exceeded");
  }
}


// ------------------------------------------------------------------
// Abort detection (handles DOMException from fetch, undici errors,
// and Node's various abort shapes)
// ------------------------------------------------------------------

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  if (e.code === "ABORT_ERR") return true;
  if (e.code === "UND_ERR_ABORTED") return true;
  if (e.code === 20) return true;
  if (typeof e.message === "string") {
    const m = e.message.toLowerCase();
    if (m.includes("aborted")) return true;
    if (m.includes("operation was aborted")) return true;
  }
  return false;
}

// ------------------------------------------------------------------
// Retry guidance
// ------------------------------------------------------------------

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError ? err.retryable : false;
}

/** Human-friendly one-liner, English only. */
export function describeError(err: unknown): string {
  if (err instanceof ProviderError) {
    const s = err.status !== undefined ? ` (HTTP ${err.status})` : "";
    return `[${err.type}]${s} ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}


// ------------------------------------------------------------------
// Body sniffing (provider-agnostic)
// ------------------------------------------------------------------

function lower(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function bodyToText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/** Extract a message string from a typical {error:{message}} body. */
function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const err = b.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.type === "string") return e.type;
  }
  if (typeof b.message === "string") return b.message;
  if (typeof b.error === "string") return b.error;
  return null;
}


// ------------------------------------------------------------------
// Classifiers
// ------------------------------------------------------------------

function classifyStatus(status: number, text: string): ProviderErrorType {
  if (status === 401 || status === 403) return "auth_invalid";
  if (status === 404) {
    // 404 + "model" hint = model_not_found; otherwise auth-ish or bad_request.
    if (text.includes("model")) return "model_not_found";
    return "bad_request";
  }
  if (status === 429) return "quota_exceeded";
  if (status === 400 || status === 422) {
    if (text.includes("content") && (text.includes("policy") || text.includes("block"))) {
      return "content_blocked";
    }
    return "bad_request";
  }
  if (status >= 500 && status <= 599) return "server_error";
  return "unknown";
}

function classifyText(text: string): ProviderErrorType {
  const t = text;

  if (
    t.includes("insufficient_quota") ||
    t.includes("quota exceeded") ||
    t.includes("rate limit") ||
    t.includes("too many requests") ||
    t.includes("billing")
  ) {
    return "quota_exceeded";
  }

  if (
    t.includes("invalid api key") ||
    t.includes("incorrect api key") ||
    t.includes("unauthorized") ||
    t.includes("authentication") ||
    t.includes("invalid_api_key")
  ) {
    return "auth_invalid";
  }

  if (
    t.includes("model not found") ||
    t.includes("unknown model") ||
    t.includes("no such model") ||
    t.includes("does not exist") && t.includes("model")
  ) {
    return "model_not_found";
  }

  if (
    t.includes("econnrefused") ||
    t.includes("enotfound") ||
    t.includes("eai_again") ||
    t.includes("etimedout") ||
    t.includes("socket hang up") ||
    t.includes("network") ||
    t.includes("fetch failed") ||
    t.includes("tls")
  ) {
    return "network_error";
  }

  if (
    t.includes("content policy") ||
    t.includes("content_policy") ||
    t.includes("safety") && t.includes("block") ||
    t.includes("flagged")
  ) {
    return "content_blocked";
  }

  return "unknown";
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export interface ClassifyInput {
  /** HTTP status if any. */
  readonly status?: number;
  /** Parsed or raw response body. */
  readonly body?: unknown;
  /** Underlying cause (fetch/network error). */
  readonly cause?: unknown;
}

/**
 * Classify any error-shaped input into a ProviderError.
 * Never throws. Always returns a ProviderError.
 */
export function classifyProviderError(input: ClassifyInput): ProviderError {
  const { status, body, cause } = input;

  const bodyText = lower(bodyToText(body));
  const causeText =
    cause instanceof Error
      ? lower(cause.message + " " + (cause.name ?? ""))
      : lower(String(cause ?? ""));
  const combined = (bodyText + " " + causeText).trim();

  // 1) If we have a status code, trust it first.
  let type: ProviderErrorType =
    status !== undefined ? classifyStatus(status, combined) : "unknown";

  // 2) If status gave us nothing useful, sniff the text.
  if (type === "unknown" && combined.length > 0) {
    type = classifyText(combined);
  }

  // 3) If we have no status but a cause (fetch failure), it's network.
  if (type === "unknown" && status === undefined && cause !== undefined) {
    type = "network_error";
  }

  let message =
    extractMessage(body) ??
    (cause instanceof Error ? cause.message : null) ??
    (status !== undefined ? "HTTP " + status : null);

  if (!message || message.trim().length === 0) {
    try {
      const raw = cause !== undefined ? cause : body;
      const str = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (str && str !== "{}" && str !== "null" && str !== "undefined") {
        message = "unclassified provider error: " + str.slice(0, 300);
      }
    } catch { /* ignore */ }
  }
  if (!message || message.trim().length === 0) message = "provider error";

  return new ProviderError({
    type,
    message,
    status,
    raw: body,
    cause,
  });
}

/**
 * Wrap an already-thrown error. If it is a ProviderError, returns as-is.
 * Otherwise classifies it.
 */
export function normalizeError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  // Catch any abort shape (DOMException, undici error, Node timeout).
  if (isAbortError(err)) {
    return new ProviderError({
      type: "network_error",
      message: "request was aborted or timed out",
      cause: err,
      retryable: true,
    });
  }

  if (err instanceof Error) {
    return classifyProviderError({ cause: err });
  }

  // Non-Error object (DOMException, undici error, plain object).
  if (err && typeof err === "object") {
    const o = err as { name?: unknown; message?: unknown };
    const name = typeof o.name === "string" ? o.name : "unknown";
    const msg = typeof o.message === "string" ? o.message : "";
    const wrapped = new Error(name + (msg ? ": " + msg : ""));
    return classifyProviderError({ cause: wrapped, body: err });
  }

  return classifyProviderError({ body: err });
}