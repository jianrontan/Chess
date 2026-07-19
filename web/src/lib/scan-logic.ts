/**
 * Pure logic for the client-side board scan — no ONNX/DOM imports so vitest
 * covers it directly. Mirrors vision/src/vision/{boardfix,render}.py; the
 * Python tests are the reference behavior.
 */

/** Must match vision/src/vision/render.py CLASSES. */
export const CLASSES = [
  "empty", "wP", "wN", "wB", "wR", "wQ", "wK",
  "bP", "bN", "bB", "bR", "bQ", "bK",
] as const;

const FEN_PIECE: Record<string, string> = {
  wP: "P", wN: "N", wB: "B", wR: "R", wQ: "Q", wK: "K",
  bP: "p", bN: "n", bB: "b", bR: "r", bQ: "q", bK: "k",
};

const WK = 6;
const BK = 12;

export function softmaxRows(logits: Float32Array, rows: number, cols: number): Float32Array {
  const out = new Float32Array(logits.length);
  for (let r = 0; r < rows; r++) {
    let max = -Infinity;
    for (let c = 0; c < cols; c++) max = Math.max(max, logits[r * cols + c]);
    let sum = 0;
    for (let c = 0; c < cols; c++) {
      const e = Math.exp(logits[r * cols + c] - max);
      out[r * cols + c] = e;
      sum += e;
    }
    for (let c = 0; c < cols; c++) out[r * cols + c] /= sum;
  }
  return out;
}

/** TS port of vision/src/vision/boardfix.py enforce_kings — keep identical. */
export function enforceKings(probs: Float32Array): number[] {
  const pred: number[] = [];
  for (let sq = 0; sq < 64; sq++) {
    let best = 0;
    for (let c = 1; c < 13; c++) if (probs[sq * 13 + c] > probs[sq * 13 + best]) best = c;
    pred.push(best);
  }
  for (const king of [WK, BK]) {
    const claimants = pred.flatMap((p, i) => (p === king ? [i] : []));
    if (claimants.length > 1) {
      let keeper = claimants[0];
      for (const sq of claimants) {
        if (probs[sq * 13 + king] > probs[keeper * 13 + king]) keeper = sq;
      }
      for (const sq of claimants) {
        if (sq === keeper) continue;
        let best = -1;
        for (let c = 0; c < 13; c++) {
          if (c === king) continue;
          if (best < 0 || probs[sq * 13 + c] > probs[sq * 13 + best]) best = c;
        }
        pred[sq] = best;
      }
    } else if (claimants.length === 0) {
      const other = king === WK ? BK : WK;
      let bestSq = -1;
      for (let sq = 0; sq < 64; sq++) {
        if (pred[sq] === other) continue;
        if (bestSq < 0 || probs[sq * 13 + king] > probs[bestSq * 13 + king]) bestSq = sq;
      }
      if (bestSq >= 0) pred[bestSq] = king;
    }
  }
  return pred;
}

/** Grid (row 0 = image top) -> FEN board field, reading White-at-bottom. */
export function gridToBoardFen(pred: number[]): string {
  const ranks: string[] = [];
  for (let iy = 0; iy < 8; iy++) {
    let rank = "";
    let run = 0;
    for (let ix = 0; ix < 8; ix++) {
      const cls = CLASSES[pred[iy * 8 + ix]];
      if (cls === "empty") {
        run++;
      } else {
        if (run > 0) rank += String(run);
        run = 0;
        rank += FEN_PIECE[cls];
      }
    }
    if (run > 0) rank += String(run);
    ranks.push(rank);
  }
  return ranks.join("/");
}

/** 180° rotation of the image-ordered grid. */
export function rotateGrid(pred: number[]): number[] {
  return [...pred].reverse();
}

// NOTE deliberately absent: an orientation auto-detect heuristic. Rotation
// maps the top row to the bottom row, so "pawns on a back rank" is invariant
// under rotation — it signals MISCLASSIFICATION, never orientation (a test
// caught the first attempt being unable to ever fire). Orientation is the
// user's call: White-bottom default + the editor's Rotate 180° button.
