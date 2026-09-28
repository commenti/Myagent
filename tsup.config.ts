import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  // These must NOT be bundled — ink pulls in a WASM module and an optional
  // devtools module that don't bundle cleanly. They stay as runtime imports.
  external: [
    "ink",
    "react",
    "react-dom",
    "yoga-wasm-web",
    "react-devtools-core",
  ],
});
