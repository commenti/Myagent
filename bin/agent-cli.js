#!/usr/bin/env node
/**
 * bin/agent-cli.js
 * ----------------
 * npm global bin entry for "agent-cli".
 *
 * यह फ़ाइल जान-बूझकर छोटी और मूर्ख (dumb) रखी गई है:
 *   • कोई business logic यहाँ नहीं — सब कुछ src/index.ts (build होकर dist/index.js) में है।
 *   • बस यह जाँचती है कि build मौजूद है या नहीं, और साफ़ error देती है।
 *   • फिर dist/index.js का main() call करके exit code वापस देती है।
 *
 * क्यों plain .js (TypeScript नहीं)?
 *   npm global bin के लिए सबसे भरोसेमंद रास्ता — कोई ts-node/tsx runtime नहीं चाहिए,
 *   और यह फ़ाइल हमेशा हाथ में रहती है, user के पास publish होकर जाती है।
 */

"use strict";

const path = require("path");
const fs = require("fs");

// ------------------------------------------------------------------
// dist/index.js खोजो
// ------------------------------------------------------------------

const distEntry = path.join(__dirname, "..", "dist", "index.js");

if (!fs.existsSync(distEntry)) {
  process.stderr.write(
    "\n" +
      "  agent-cli: build नहीं मिला (dist/index.js मौजूद नहीं).\n" +
      "\n" +
      "  अगर आपने इसे npm से global install किया है, तो यह असामान्य है —\n" +
      "  कृपया दोबारा install करें:  npm install -g agent-cli\n" +
      "\n" +
      "  अगर आप सोर्स से चला रहे हैं, तो पहले build करें:\n" +
      "      npm install\n" +
      "      npm run build\n" +
      "\n"
  );
  process.exit(1);
}

// ------------------------------------------------------------------
// dist/index.js का main() load करो और चलाओ
// ------------------------------------------------------------------

let mod;
try {
  mod = require(distEntry);
} catch (err) {
  process.stderr.write(
    "\n  agent-cli: dist/index.js load नहीं हो सका।\n\n" +
      "  " + (err && err.stack ? err.stack : String(err)) + "\n\n"
  );
  process.exit(1);
}

const main =
  typeof mod === "function"
    ? mod
    : typeof mod.main === "function"
    ? mod.main
    : typeof mod.default === "function"
    ? mod.default
    : null;

if (!main) {
  process.stderr.write(
    "\n" +
      "  agent-cli: dist/index.js में कोई main() export नहीं मिला।\n" +
      "  (उम्मीद थी: `export function main()` या `export default function main()`)\n\n"
  );
  process.exit(1);
}

// main() का return अगर Promise हो तो await करो, और exit code उससे लो।
Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then((code) => {
    const n = typeof code === "number" ? code : 0;
    process.exit(n);
  })
  .catch((err) => {
    process.stderr.write(
      "\n  agent-cli: अचानक error आ गई।\n\n" +
        "  " + (err && err.stack ? err.stack : String(err)) + "\n\n"
    );
    process.exit(1);
  });