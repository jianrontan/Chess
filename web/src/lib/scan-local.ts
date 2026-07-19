"use client";

/**
 * Client-side board recognition (vision/GATE_REPORT.md — squarenet-v5).
 *
 * The 215KB int8 ONNX model classifies 64 square crops into 13 classes
 * entirely in the browser: zero API cost, no Turnstile, the image never
 * leaves the machine. Trust chain: the model ships only behind the
 * committed gate report (100% on real Lichess screenshots), the result is
 * validated by chess.js in the editor flow, and the user always confirms
 * on the editor screen — orientation and side-to-move are theirs to state.
 *
 * Pure logic (king constraint, FEN assembly, orientation heuristic) lives
 * in scan-logic.ts where vitest covers it.
 */

// ORT is loaded LAZILY and only in the browser: the wasm-only entry (the
// default entry pulls a 25.6MiB jsep/webgpu runtime that busts the Workers
// 25MiB asset limit) crashes Next's prerender when imported at module scope,
// and eager loading would cost every visitor the download whether they scan
// or not. Types come from the package root (same API surface).
import type { InferenceSession, Tensor as OrtTensor } from "onnxruntime-web";
import { enforceKings, gridToBoardFen, softmaxRows } from "@/lib/scan-logic";

const MODEL_URL = "/models/squarenet-v5.int8.onnx";
export const CROP = 32;

type OrtModule = typeof import("onnxruntime-web/wasm");

let ortPromise: Promise<OrtModule> | null = null;
let sessionPromise: Promise<InferenceSession> | null = null;

function getOrt(): Promise<OrtModule> {
  ortPromise ??= import("onnxruntime-web/wasm");
  return ortPromise;
}

/** First-scan download budget (ORT wasm + model). A stalled fetch must REJECT
 * so the caller's /api/scan fallback can take over — a hang here used to
 * dead-end the crop screen with Cancel disabled. */
const LOAD_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function getSession(): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = withTimeout(
      getOrt().then((ort) => {
        ort.env.wasm.wasmPaths = "/ort/";
        ort.env.wasm.numThreads = 1; // 64 tiny crops — threading buys nothing
        return ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ["wasm"],
        });
      }),
      LOAD_TIMEOUT_MS,
      "recognition model load",
    );
    sessionPromise.catch(() => {
      sessionPromise = null; // transient load failure must not stick forever
      ortPromise = null; // the stalled import may itself be the culprit
    });
  }
  return sessionPromise;
}

export interface BoardRegion {
  x: number;
  y: number;
  size: number; // square side in source-image pixels
}

/** Slice the selected square region into 64 CROP x CROP crops (NCHW floats). */
function regionToFloats(image: HTMLImageElement | ImageBitmap, region: BoardRegion): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = CROP * 8;
  canvas.height = CROP * 8;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(image, region.x, region.y, region.size, region.size, 0, 0, CROP * 8, CROP * 8);
  const { data } = ctx.getImageData(0, 0, CROP * 8, CROP * 8);
  const out = new Float32Array(64 * 3 * CROP * CROP);
  for (let sq = 0; sq < 64; sq++) {
    const sx = (sq % 8) * CROP;
    const sy = Math.floor(sq / 8) * CROP;
    for (let y = 0; y < CROP; y++) {
      for (let x = 0; x < CROP; x++) {
        const px = ((sy + y) * CROP * 8 + sx + x) * 4;
        const base = sq * 3 * CROP * CROP;
        out[base + 0 * CROP * CROP + y * CROP + x] = data[px] / 255;
        out[base + 1 * CROP * CROP + y * CROP + x] = data[px + 1] / 255;
        out[base + 2 * CROP * CROP + y * CROP + x] = data[px + 2] / 255;
      }
    }
  }
  return out;
}

export interface LocalScanResult {
  /** Full FEN with placeholder side-to-move/castling (editor sets those).
   * Read White-at-bottom; orientation is the USER'S call (Rotate 180° in
   * the editor) — see scan-logic.ts for why no heuristic can decide it. */
  fen: string;
}

/** Classify a board region entirely in the browser. */
export async function scanRegion(
  image: HTMLImageElement | ImageBitmap,
  region: BoardRegion,
): Promise<LocalScanResult> {
  // The whole load races the timeout — a hung dynamic import would otherwise
  // bypass getSession's internal deadline via this parallel getOrt() await.
  const [ort, session] = await withTimeout(
    Promise.all([getOrt(), getSession()]),
    LOAD_TIMEOUT_MS,
    "recognition model load",
  );
  const floats = regionToFloats(image, region);
  const input: OrtTensor = new ort.Tensor("float32", floats, [64, 3, CROP, CROP]);
  const output = await session.run({ squares: input });
  const logits = output.logits.data as Float32Array;
  const probs = softmaxRows(logits, 64, 13);
  const fixed = enforceKings(probs);
  return { fen: `${gridToBoardFen(fixed)} w - - 0 1` };
}
