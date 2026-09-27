/**
 * src/recovery/FailureLedger.ts
 * -----------------------------
 * Persistent ledger of failed attempts, keyed by ErrorFingerprint hash.
 *
 * Purpose (ARCHITECTURE.md §11 + Core Principle #9):
 *   • 1st failure of a fingerprint → plain retry is allowed.
 *   • 2nd failure of the same fingerprint → approach MUST change.
 *   • 3rd failure → StateMachine triggers rollback + fresh-context debug.
 *
 * Storage: <runtimeDir>/failures.json  (one JSON file, bounded).
 * Append-only in spirit; the file is rewritten atomically on every change.
 *
 * No AI calls. Pure file I/O.
 */

import * as fs from "fs/promises";
import * as path from "path";

import {
  fingerprint,
  type ErrorCategory,
  type FingerprintInput,
} from "./ErrorFingerprint";
import type { ProjectPaths } from "../config/ProjectConfig";


// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const LEDGER_FILE = "failures.json";
const LEDGER_VERSION = 1 as const;
const MAX_RECORDS = 500; // drop oldest when exceeded


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface FailureRecord {
  readonly ts: string;
  readonly fingerprintHash: string;
  readonly category: ErrorCategory;
  readonly headline: string;
  readonly command?: string;
  readonly exitCode?: number;
  /** Optional task id this failure belongs to. */
  readonly taskId?: string;
  /** Optional free-text description of the approach used (English). */
  readonly approach?: string;
  /** 1-based count of this fingerprint at the moment of recording. */
  readonly occurrence: number;
}

export interface RecordFailureInput {
  /** Raw combined output (stdout+stderr) from the failed attempt. */
  readonly output: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly taskId?: string;
  readonly approach?: string;
}

export interface RecordFailureResult {
  readonly record: FailureRecord;
  /** Occurrence count AFTER recording (>= 1). */
  readonly count: number;
}

interface LedgerFileShape {
  readonly version: typeof LEDGER_VERSION;
  readonly records: readonly FailureRecord[];
}

export class FailureLedgerError extends Error {
  public readonly code: "io_error" | "bad_format";
  constructor(code: FailureLedgerError["code"], message: string) {
    super(message);
    this.name = "FailureLedgerError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// FailureLedger
// ------------------------------------------------------------------

export class FailureLedger {
  private readonly file: string;
  private records: FailureRecord[] = [];
  private loaded = false;

  constructor(paths: ProjectPaths) {
    this.file = path.join(paths.runtimeDir, LEDGER_FILE);
  }


  // ----------------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------------

  /** Load the ledger from disk. Safe to call multiple times. */
  public async load(): Promise<void> {
    if (this.loaded) return;
    this.records = await this.readFromDisk();
    this.loaded = true;
  }

  /** Reload from disk, discarding in-memory state. */
  public async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  private async readFromDisk(): Promise<FailureRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      const msg = err instanceof Error ? err.message : String(err);
      throw new FailureLedgerError("io_error", `read ledger failed: ${msg}`);
    }
    if (raw.trim().length === 0) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt ledger: start fresh rather than crash.
      return [];
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== LEDGER_VERSION ||
      !Array.isArray((parsed as { records?: unknown }).records)
    ) {
      return [];
    }
    const arr = (parsed as { records: unknown[] }).records;
    const out: FailureRecord[] = [];
    for (const r of arr) {
      if (isFailureRecord(r)) out.push(r);
    }
    return out;
  }

  private async writeToDisk(): Promise<void> {
    const payload: LedgerFileShape = {
      version: LEDGER_VERSION,
      records: this.records,
    };
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = this.file + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      await fs.rename(tmp, this.file);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      throw new FailureLedgerError("io_error", `write ledger failed: ${msg}`);
    }
  }


  // ----------------------------------------------------------------
  // Recording
  // ----------------------------------------------------------------

  /**
   * Record a failure. Computes the fingerprint, increments the occurrence
   * count for that fingerprint, persists. Returns the record + new count.
   */
  public async record(input: RecordFailureInput): Promise<RecordFailureResult> {
    await this.load();

    const fp: FingerprintInput = {
      output: input.output,
      command: input.command,
      exitCode: input.exitCode,
    };
    const { hash, category, headline } = fingerprint(fp);

    const count = this.countForSync(hash) + 1;

    const record: FailureRecord = {
      ts: new Date().toISOString(),
      fingerprintHash: hash,
      category,
      headline,
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.approach !== undefined ? { approach: input.approach } : {}),
      occurrence: count,
    };

    this.records.push(record);
    this.enforceCap();
    await this.writeToDisk();

    return { record, count };
  }


  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  /** How many times has this exact fingerprint been recorded? */
  public countFor(hash: string): number {
    return this.countForSync(hash);
  }

  private countForSync(hash: string): number {
    let n = 0;
    for (const r of this.records) {
      if (r.fingerprintHash === hash) n++;
    }
    return n;
  }

  /** All records for a given fingerprint, in insertion order. */
  public occurrencesFor(hash: string): readonly FailureRecord[] {
    return this.records.filter((r) => r.fingerprintHash === hash);
  }

  /** All records (copy). */
  public all(): readonly FailureRecord[] {
    return [...this.records];
  }

  /** Records for a task id. */
  public forTask(taskId: string): readonly FailureRecord[] {
    return this.records.filter((r) => r.taskId === taskId);
  }

  /**
   * Count for a raw error without recording it.
   * Useful before deciding whether to record.
   */
  public async peek(output: string, command?: string, exitCode?: number): Promise<number> {
    await this.load();
    const { hash } = fingerprint({ output, command, exitCode });
    return this.countForSync(hash);
  }


  // ----------------------------------------------------------------
  // Clearing
  // ----------------------------------------------------------------

  /** Remove all records for a fingerprint (call after a successful fix). */
  public async clearFor(hash: string): Promise<void> {
    await this.load();
    const before = this.records.length;
    this.records = this.records.filter((r) => r.fingerprintHash !== hash);
    if (this.records.length !== before) await this.writeToDisk();
  }

  /** Remove all records for a task. */
  public async clearTask(taskId: string): Promise<void> {
    await this.load();
    const before = this.records.length;
    this.records = this.records.filter((r) => r.taskId !== taskId);
    if (this.records.length !== before) await this.writeToDisk();
  }

  /** Wipe the ledger entirely (e.g. at the start of a new task). */
  public async clearAll(): Promise<void> {
    await this.load();
    this.records = [];
    await this.writeToDisk();
  }


  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private enforceCap(): void {
    if (this.records.length <= MAX_RECORDS) return;
    const drop = this.records.length - MAX_RECORDS;
    this.records = this.records.slice(drop);
  }
}


// ------------------------------------------------------------------
// Type guard
// ------------------------------------------------------------------

function isFailureRecord(v: unknown): v is FailureRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.ts !== "string") return false;
  if (typeof o.fingerprintHash !== "string") return false;
  if (typeof o.category !== "string") return false;
  if (typeof o.headline !== "string") return false;
  if (typeof o.occurrence !== "number") return false;
  if (o.command !== undefined && typeof o.command !== "string") return false;
  if (o.exitCode !== undefined && typeof o.exitCode !== "number") return false;
  if (o.taskId !== undefined && typeof o.taskId !== "string") return false;
  if (o.approach !== undefined && typeof o.approach !== "string") return false;
  return true;
}