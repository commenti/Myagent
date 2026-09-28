#!/usr/bin/env node
/**
 * bin/agent-cli.js — npm global bin entry (ESM).
 * Loads dist/index.js and calls its main() export.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__dirname, "..", "dist", "index.js");

if (!existsSync(distEntry)) {
  process.stderr.write(
    "\n  agent-cli: build not found (dist/index.js is missing).\n\n" +
      "  If installed from npm, reinstall:  npm install -g agent-cli\n" +
      "  If running from source, build first:\n" +
      "      npm install\n" +
      "      npm run build\n\n"
  );
  process.exit(1);
}

let mod;
try {
  mod = await import(distEntry);
} catch (err) {
  process.stderr.write(
    "\n  agent-cli: failed to load dist/index.js\n\n  " +
      (err && err.stack ? err.stack : String(err)) +
      "\n\n"
  );
  process.exit(1);
}

const main =
  typeof mod.main === "function"
    ? mod.main
    : typeof mod.default === "function"
    ? mod.default
    : null;

if (!main) {
  process.stderr.write(
    "\n  agent-cli: dist/index.js has no main() export.\n\n"
  );
  process.exit(1);
}

try {
  const code = await main(process.argv.slice(2));
  process.exit(typeof code === "number" ? code : 0);
} catch (err) {
  process.stderr.write(
    "\n  agent-cli: unexpected error\n\n  " +
      (err && err.stack ? err.stack : String(err)) +
      "\n\n"
  );
  process.exit(1);
}
