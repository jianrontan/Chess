import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { CLASSES, enforceKings, gridToBoardFen, rotateGrid, softmaxRows } from "./scan-logic";

const idx = (name: (typeof CLASSES)[number]) => CLASSES.indexOf(name);

function probsFor(labels: number[]): Float32Array {
  const probs = new Float32Array(64 * 13).fill(0.01);
  labels.forEach((lab, i) => {
    probs[i * 13 + lab] = 0.9;
  });
  return probs;
}

function startGrid(): number[] {
  const g = new Array(64).fill(0);
  const back = ["bR", "bN", "bB", "bQ", "bK", "bB", "bN", "bR"] as const;
  back.forEach((p, i) => {
    g[i] = idx(p);
  });
  for (let i = 0; i < 8; i++) g[8 + i] = idx("bP");
  for (let i = 0; i < 8; i++) g[48 + i] = idx("wP");
  const white = ["wR", "wN", "wB", "wQ", "wK", "wB", "wN", "wR"] as const;
  white.forEach((p, i) => {
    g[56 + i] = idx(p);
  });
  return g;
}

describe("gridToBoardFen", () => {
  it("renders the start position and chess.js accepts it", () => {
    const fen = gridToBoardFen(startGrid());
    expect(fen).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
    expect(() => new Chess(`${fen} w - - 0 1`)).not.toThrow();
  });

  it("compresses empty runs correctly", () => {
    const g = new Array(64).fill(0);
    g[0] = idx("bK");
    g[63] = idx("wK");
    expect(gridToBoardFen(g)).toBe("k7/8/8/8/8/8/8/7K");
  });
});

describe("enforceKings (parity with vision/boardfix.py tests)", () => {
  it("passes through a legal grid", () => {
    const labels = startGrid();
    expect(enforceKings(probsFor(labels))).toEqual(labels);
  });

  it("demotes the less confident duplicate king to its next-best class", () => {
    const labels = new Array(64).fill(0);
    labels[10] = idx("wK");
    labels[11] = idx("wK");
    labels[50] = idx("bK");
    const probs = probsFor(labels);
    probs[10 * 13 + idx("wK")] = 0.95;
    probs[11 * 13 + idx("wQ")] = 0.5;
    const fixed = enforceKings(probs);
    expect(fixed[10]).toBe(idx("wK"));
    expect(fixed[11]).toBe(idx("wQ"));
  });

  it("promotes the best candidate when a king is missing", () => {
    const labels = new Array(64).fill(0);
    labels[50] = idx("bK");
    const probs = probsFor(labels);
    probs[20 * 13 + idx("wK")] = 0.4;
    const fixed = enforceKings(probs);
    expect(fixed[20]).toBe(idx("wK"));
    expect(fixed[50]).toBe(idx("bK"));
  });
});

describe("rotateGrid", () => {
  it("is a self-inverse", () => {
    const g = startGrid();
    expect(rotateGrid(rotateGrid(g))).toEqual(g);
  });

  it("back-rank pawns are INVARIANT under rotation — why no auto-orientation", () => {
    // Rotation maps image row 0 to row 7: a pawn on a back rank stays on a
    // back rank in both readings. This property is the reason scan-logic
    // ships no orientation heuristic (misclassification, not orientation).
    const g = new Array(64).fill(0);
    g[3] = idx("wP");
    const r = rotateGrid(g);
    const onBackRank = (grid: number[]) =>
      [...Array(8).keys()].some(
        (ix) => grid[ix] === idx("wP") || grid[56 + ix] === idx("wP"),
      );
    expect(onBackRank(g)).toBe(true);
    expect(onBackRank(r)).toBe(true);
  });
});

describe("softmaxRows", () => {
  it("produces rows summing to 1 with the max logit winning", () => {
    const logits = new Float32Array([1, 3, 2, 0, 0, 5]);
    const sm = softmaxRows(logits, 2, 3);
    const row0 = sm.slice(0, 3);
    expect(row0[1]).toBeGreaterThan(row0[0]);
    expect(row0.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(sm[5]).toBeGreaterThan(0.9);
  });
});
