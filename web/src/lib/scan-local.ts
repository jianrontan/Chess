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

import * as ort from "onnxruntime-web";
import { enforceKings, gridToBoardFen, softmaxRows } from "@/lib/scan-logic";

const MODEL_URL = "/models/squarenet-v5.int8.onnx";
export const CROP = 32;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = "/ort/";
    ort.env.wasm.numThreads = 1; // 64 tiny crops — threading buys nothing
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
    });
    sessionPromise.catch(() => {
      sessionPromise = null; // transient load failure must not stick forever
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
function regionToTensor(image: HTMLImageElement | ImageBitmap, region: BoardRegion): ort.Tensor {
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
  return new ort.Tensor("float32", out, [64, 3, CROP, CROP]);
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
  const session = await getSession();
  const input = regionToTensor(image, region);
  const output = await session.run({ squares: input });
  const logits = output.logits.data as Float32Array;
  const probs = softmaxRows(logits, 64, 13);
  const fixed = enforceKings(probs);
  return { fen: `${gridToBoardFen(fixed)} w - - 0 1` };
}
