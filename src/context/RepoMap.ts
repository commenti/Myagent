/**
 * src/context/RepoMap.ts
 * ----------------------
 * Builds a lightweight "map" of the repository: file paths + the symbols
 * (functions, classes, interfaces, types, exported consts) they contain.
 * This is the L1 layer of context (ARCHITECTURE.md §8).
 *
 * Parser strategy:
 *   1. Try tree-sitter (native) — most accurate.
 *   2. If native bindings can't load (e.g. Termux without build tools),
 *      fall back to a regex extractor. Never crash over parsing.
 *
 * Output is provider-agnostic: a list of FileSymbol entries. Callers turn
 * it into whatever the model needs (a compact text block, a search index…).
 *
 * No AI calls. No writes. In-memory cache only.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";

import { PathGuard } from "../policy/PathGuard";


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

const DEFAULT_MAX_FILES = 2000;
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB

const CODE_EXTS = new Set<string>([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
]);

const SKIP_DIRS = new Set<string>([
  "node_modules", ".git", "dist", "build", "coverage",
  ".agent-runtime", ".next", ".cache", ".turbo",
  ".idea", ".vscode", "__pycache__", "venv", ".venv",
]);


// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "method"
  | "variable";

export interface FileSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based line where the symbol is declared. */
  readonly line: number;
  /** True if the symbol is exported from the file. */
  readonly exported: boolean;
}

export interface FileEntry {
  readonly relPath: string;
  readonly absPath: string;
  readonly byteSize: number;
  readonly symbols: readonly FileSymbol[];
}

export interface RepoMapOptions {
  readonly cwd: string;
  /** Cap on files scanned. Default 2000. */
  readonly maxFiles?: number;
  /** Restrict to a subpath (relative to cwd). Default: root. */
  readonly subPath?: string;
  /** Only include files with these extensions (with dots). */
  readonly extensions?: readonly string[];
}

export interface RepoMap {
  readonly rootDir: string;
  readonly files: readonly FileEntry[];
  readonly totalFiles: number;
  readonly totalSymbols: number;
  readonly truncated: boolean;
  readonly parser: "tree-sitter" | "regex";
  readonly builtAt: string;
}


export class RepoMapError extends Error {
  public readonly code: "blocked" | "io_error";
  constructor(code: RepoMapError["code"], message: string) {
    super(message);
    this.name = "RepoMapError";
    this.code = code;
  }
}


// ------------------------------------------------------------------
// Parser interface
// ------------------------------------------------------------------

interface Parser {
  readonly kind: "tree-sitter" | "regex";
  extract(source: string): FileSymbol[];
}


// ------------------------------------------------------------------
// Regex fallback parser (always available)
// ------------------------------------------------------------------

const RE_EXPORT = /^\s*export\b/;

const RE_SYMBOLS: ReadonlyArray<readonly [SymbolKind, RegExp]> = [
  ["function", /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/],
  ["class",    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/],
  ["interface",/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
  ["type",     /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/],
  ["enum",     /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/],
  ["const",    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/],
];

function extractRegex(source: string): FileSymbol[] {
  const out: FileSymbol[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    // Skip lines that are obviously inside comments.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    const exported = RE_EXPORT.test(line);
    for (const [kind, re] of RE_SYMBOLS) {
      const m = line.match(re);
      if (m && m[1]) {
        out.push({ name: m[1], kind, line: i + 1, exported });
        break;
      }
    }
  }
  return out;
}


// ------------------------------------------------------------------
// tree-sitter parser (best-effort load)
// ------------------------------------------------------------------

interface TsNode {
  type: string;
  startPosition: { row: number; column: number };
  namedChildren: TsNode[];
  childForFieldName?: (name: string) => TsNode | null;
  text: string;
}

interface TsParser {
  setLanguage(lang: unknown): void;
  parse(src: string): { rootNode: TsNode };
}

interface TsGrammars {
  ts: unknown;
  tsx: unknown;
  js: unknown;
  jsx: unknown;
}

async function tryLoadTreeSitter(): Promise<{ Parser: new () => TsParser; grammars: TsGrammars } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ParserMod = require("tree-sitter") as { default?: new () => TsParser } | (new () => TsParser);
    const tsMod = require("tree-sitter-typescript") as { typescript?: unknown; tsx?: unknown };
    const jsMod = require("tree-sitter-javascript") as unknown;

    const ParserCtor = typeof ParserMod === "function" ? ParserMod : ParserMod.default;
    if (!ParserCtor) return null;

    return {
      Parser: ParserCtor as new () => TsParser,
      grammars: {
        ts: tsMod.typescript ?? tsMod,
        tsx: tsMod.tsx ?? tsMod.typescript ?? tsMod,
        js: jsMod,
        jsx: jsMod,
      },
    };
  } catch {
    return null;
  }
}

function walkTsNode(node: TsNode, out: FileSymbol[], source: string): void {
  const t = node.type;

  if (
    t === "function_declaration" ||
    t === "function_expression" ||
    t === "arrow_function" ||
    t === "class_declaration" ||
    t === "interface_declaration" ||
    t === "type_alias_declaration" ||
    t === "enum_declaration" ||
    t === "lexical_declaration" ||
    t === "variable_declaration"
  ) {
    const nameNode = node.childForFieldName?.("name") ?? null;
    const name = nameNode?.text ?? "";

    const kind: SymbolKind | null =
      t === "function_declaration" || t === "function_expression" ? "function" :
      t === "arrow_function" ? "function" :
      t === "class_declaration" ? "class" :
      t === "interface_declaration" ? "interface" :
      t === "type_alias_declaration" ? "type" :
      t === "enum_declaration" ? "enum" :
      (t === "lexical_declaration" || t === "variable_declaration") ? "const" :
      null;

    if (kind && name.length > 0 && name !== "(") {
      const line = node.startPosition.row + 1;
      // Determine export: look for `export` token right before this node in source line.
      const lineText = source.split("\n")[line - 1] ?? "";
      const exported = /^\s*export\b/.test(lineText);
      out.push({ name, kind, line, exported });
    }
  }

  for (const child of node.namedChildren) {
    walkTsNode(child, out, source);
  }
}

async function makeTreeSitterParser(): Promise<Parser | null> {
  const loaded = await tryLoadTreeSitter();
  if (!loaded) return null;

  const { Parser, grammars } = loaded;
  const langByExt: Record<string, unknown> = {
    ".ts": grammars.ts,
    ".tsx": grammars.tsx,
    ".js": grammars.js,
    ".jsx": grammars.jsx,
    ".mjs": grammars.js,
    ".cjs": grammars.js,
  };

  return {
    kind: "tree-sitter",
    extract(source: string): FileSymbol[] {
      // Without knowing the ext here, default to TS grammar. Caller may refine
      // by picking a per-ext parser; for a first cut this is acceptable.
      const parser = new Parser();
      try {
        parser.setLanguage(langByExt[".ts"]);
      } catch {
        return extractRegex(source);
      }
      let tree: { rootNode: TsNode };
      try {
        tree = parser.parse(source);
      } catch {
        return extractRegex(source);
      }
      const out: FileSymbol[] = [];
      walkTsNode(tree.rootNode, out, source);
      // De-duplicate on (name, line).
      const seen = new Set<string>();
      return out.filter((s) => {
        const key = `${s.line}:${s.name}:${s.kind}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  };
}


// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Build a repo map. Uses tree-sitter if it can load, else regex.
 * Throws RepoMapError on a blocked subpath or unexpected I/O.
 */
export async function buildRepoMap(opts: RepoMapOptions): Promise<RepoMap> {
  const guard = new PathGuard(opts.cwd);
  const rootDir = guard.workingDir;

  let startDir: string;
  try {
    startDir = opts.subPath ? guard.resolveSafeReal(opts.subPath) : rootDir;
  } catch (err) {
    throw new RepoMapError("blocked", err instanceof Error ? err.message : String(err));
  }

  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const extSet = opts.extensions && opts.extensions.length > 0
    ? new Set(opts.extensions.map((e) => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase()))
    : CODE_EXTS;

  // Collect files first (cheap), then parse.
  const filePaths: string[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (filePaths.length >= maxFiles) { truncated = true; return; }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
        continue;
      }
      if (e.isSymbolicLink()) continue;
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!extSet.has(ext)) continue;
      filePaths.push(abs);
    }
  }
  await walk(startDir);

  // Pick a parser (tree-sitter if possible; regex otherwise).
  const tsParser = await makeTreeSitterParser();
  const parser: Parser = tsParser ?? { kind: "regex", extract: extractRegex };

  const files: FileEntry[] = [];
  let totalSymbols = 0;

  for (const absPath of filePaths) {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(absPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    let source: string;
    try {
      const buf = await fs.readFile(absPath);
      // Cheap binary sniff on first 1 KB.
      const head = buf.subarray(0, Math.min(1024, buf.length));
      let binary = false;
      for (let i = 0; i < head.length; i++) {
        if (head[i] === 0) { binary = true; break; }
      }
      if (binary) continue;
      source = buf.toString("utf8");
      if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
    } catch {
      continue;
    }

    let symbols: FileSymbol[];
    try {
      symbols = parser.extract(source);
    } catch {
      symbols = extractRegex(source);
    }

    const relPath = path.relative(rootDir, absPath) || path.basename(absPath);
    files.push({
      relPath,
      absPath,
      byteSize: stat.size,
      symbols,
    });
    totalSymbols += symbols.length;
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return {
    rootDir,
    files,
    totalFiles: files.length,
    totalSymbols,
    truncated,
    parser: parser.kind,
    builtAt: new Date().toISOString(),
  };
}


// ------------------------------------------------------------------
// Formatting helpers (compact text block for the model)
// ------------------------------------------------------------------

/**
 * Render the repo map as a compact, token-efficient text block.
 * One line per file, symbols in parentheses:
 *
 *   src/index.ts  (fn main, cls Agent)
 *   src/ui/Renderer.tsx  (fn Renderer)
 */
export function formatRepoMap(map: RepoMap, maxFiles = 400): string {
  const lines: string[] = [];
  const files = map.files.slice(0, maxFiles);
  for (const f of files) {
    if (f.symbols.length === 0) {
      lines.push(f.relPath);
      continue;
    }
    const syms = f.symbols
      .slice(0, 12)
      .map((s) => `${shortKind(s.kind)} ${s.name}`)
      .join(", ");
    lines.push(`${f.relPath}  (${syms})`);
  }
  if (map.files.length > maxFiles) {
    lines.push(`… ${map.files.length - maxFiles} more files`);
  }
  return lines.join("\n");
}

function shortKind(k: SymbolKind): string {
  switch (k) {
    case "function": return "fn";
    case "class": return "cls";
    case "interface": return "iface";
    case "type": return "type";
    case "enum": return "enum";
    case "const": return "const";
    case "method": return "mth";
    case "variable": return "var";
  }
}


/** Find files that declare a symbol with the given name. */
export function findSymbols(map: RepoMap, name: string): readonly { file: string; symbol: FileSymbol }[] {
  const out: { file: string; symbol: FileSymbol }[] = [];
  for (const f of map.files) {
    for (const s of f.symbols) {
      if (s.name === name) out.push({ file: f.relPath, symbol: s });
    }
  }
  return out;
}