// Copies the onnxruntime-web WASM runtime from node_modules to public/ort/
// (git-ignored, same pattern as copy-engine.mjs). The board-scan model runs
// single-threaded on 64 crops — only the base simd-threaded artifacts are
// needed (ORT picks thread count at session creation).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dest = join(root, "public", "ort");

// The runtime requests the JSEP variant by default (webgpu-capable build);
// ship both so the loader finds whichever it asks for.
const FILES = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  copyFileSync(join(src, f), join(dest, f));
}
console.log(`copied ${FILES.length} ort files to public/ort/`);
