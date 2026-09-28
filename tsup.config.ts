/**
 * tsup.config.ts
 * --------------
 * Build configuration for agent-cli.
 *
 * Why tsup instead of plain `tsc`:
 *   • The project uses `ink` v4, which is an ESM-only package.
 *     A CommonJS build must therefore bundle it instead of
 *     requiring it at runtime (which would fail).
 *   • tree-sitter family ships native bindings and must NOT be
 *     bundled — they stay as runtime `require()` calls.
 *
 * Output: dist/index.js (CJS), dist/index.d.ts, sourcemaps.
 */

import { defineConfig } from "tsup";

export default defineConfig({
  // Entry point — everything reachable from here is included.
  entry: ["src/index.ts"],

  // CJS output (matches package.json "type": "commonjs").
  format: ["cjs"],

  // Node 18+ target (matches package.json engines).
  target: "node18",
  platform: "node",

  // Output directory and cleanup.
  outDir: "dist",
  clean: true,

  // Generate .d.ts files so `types` in package.json resolves.
  dts: true,

  // Sourcemaps for debugging.
  sourcemap: true,

  // Single bundle; no code splitting.
  splitting: false,

  // No CJS/ESM interop shims — we control the output format.
  shims: false,

  // tree-sitter native bindings — must stay external so that
  // Node's require() loads the real .node binaries at runtime.
  external: [
    "tree-sitter",
    "tree-sitter-javascript",
    "tree-sitter-typescript",
  ],

  // ink v4 is ESM-only. Force-bundle it into our CJS output so
  // that require("ink") is not attempted at runtime.
  // (If any other ESM-only dependency joins later, add it here.)
  noExternal: ["ink"],
});