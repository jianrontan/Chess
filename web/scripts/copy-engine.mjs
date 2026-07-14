// Copies the Stockfish WASM builds we ship from node_modules to public/engine/.
// Runs before dev/build (see package.json). public/engine/ is git-ignored.
//
// Variant matrix (see docs/ARCHITECTURE.md "Engine budgets by device"):
// - stockfish-18-lite        threaded, lite NNUE (~7MB)  — desktop primary
// - stockfish-18-lite-single single-thread fallback      — no crossOriginIsolated
// The full NNUE build (108MB) exceeds the 25MiB static-asset limit and is not shipped.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "stockfish", "bin");
const dest = join(root, "public", "engine");

const FILES = [
  "stockfish-18-lite.js",
  "stockfish-18-lite.wasm",
  "stockfish-18-lite-single.js",
  "stockfish-18-lite-single.wasm",
];

mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  copyFileSync(join(src, f), join(dest, f));
}
console.log(`copied ${FILES.length} engine files to public/engine/`);
