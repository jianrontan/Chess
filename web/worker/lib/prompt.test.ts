import { describe, expect, it } from "vitest";
import { buildPrompt, evalPhrase, pieceList, PROMPT_VERSION, pvToSan } from "./prompt";
import type { ExplainRequest } from "./schema";

// Mate-in-2 position shared with the Python suite.
const MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// After 1. e4: Black to move.
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

describe("pieceList — cross-language golden strings", () => {
  // These EXACT strings are asserted in pipeline/tests/test_prompts.py
  // (GOLDEN_PIECE_LISTS). The Worker and the eval harness must serialize
  // the prompt identically, or the harness stops measuring what prod
  // sends. If you change the format, change both suites together.
  it("matches the Python output for a midgame position", () => {
    expect(pieceList(MATE_FEN)).toBe(
      "White: Kh1, Qh3, Rf1, Ng3, pawns a2 b2 c3 d4 e5 h2\n" +
        "Black: Kh8, Qd3, Rc8, Bb7, Ne4, pawns a7 b6 d5 g7 h7",
    );
  });

  it("matches the Python output for the start position", () => {
    expect(pieceList(START)).toBe(
      "White: Ke1, Qd1, Ra1, Rh1, Bc1, Bf1, Nb1, Ng1, pawns a2 b2 c2 d2 e2 f2 g2 h2\n" +
        "Black: Ke8, Qd8, Ra8, Rh8, Bc8, Bf8, Nb8, Ng8, pawns a7 b7 c7 d7 e7 f7 g7 h7",
    );
  });

  it("matches the Python output for a bare-kings endgame", () => {
    expect(pieceList("8/8/8/8/8/8/8/K6k w - - 0 1")).toBe("White: Ka1\nBlack: Kh1");
  });

  it("omits squares that hold nothing", () => {
    // The v1 bug was the model asserting pieces on empty squares; the
    // list must never mention one.
    expect(pieceList(MATE_FEN)).not.toContain("c2");
  });
});

describe("pvToSan", () => {
  it("converts a legal PV to numbered SAN", () => {
    expect(pvToSan(START, ["e2e4", "e7e5", "g1f3"])).toBe("1. e4 e5 2. Nf3");
  });

  it("numbers a Black-to-move PV with '...'", () => {
    expect(pvToSan(AFTER_E4, ["e7e5", "g1f3"])).toBe("1... e5 2. Nf3");
  });

  it("returns null on an illegal move (the legality gate)", () => {
    expect(pvToSan(START, ["e2e5"])).toBeNull();
    expect(pvToSan(START, ["e2e4", "e2e4"])).toBeNull();
  });

  it("returns null on a garbage FEN", () => {
    expect(pvToSan("not a fen", ["e2e4"])).toBeNull();
  });
});

describe("evalPhrase — evals are side-to-move relative", () => {
  it("negates cp when Black is to move", () => {
    // +150 from Black's perspective = Black is better.
    expect(evalPhrase({ multipv: 1, depth: 20, cp: 150, pv: ["e7e5"] }, "b")).toContain(
      "Black",
    );
    expect(evalPhrase({ multipv: 1, depth: 20, cp: 150, pv: ["e2e4"] }, "w")).toContain(
      "White",
    );
  });

  it("phrases mate White-centrically", () => {
    expect(evalPhrase({ multipv: 1, depth: 20, mate: 3, pv: ["e7e5"] }, "b")).toBe(
      "Black mates in 3",
    );
  });

  it("calls small evals roughly equal", () => {
    expect(evalPhrase({ multipv: 1, depth: 20, cp: 10, pv: ["e2e4"] }, "w")).toBe(
      "roughly equal",
    );
  });
});

describe("buildPrompt", () => {
  it("builds a candidates prompt with SAN lines and no leftover placeholders", () => {
    const req: ExplainRequest = {
      mode: "candidates",
      fen: START,
      lines: [
        { multipv: 1, depth: 22, cp: 30, pv: ["e2e4", "e7e5"] },
        { multipv: 2, depth: 22, cp: 25, pv: ["d2d4", "d7d5"] },
      ],
    };
    const r = buildPrompt(req);
    if (!r.ok) throw new Error(r.error);
    expect(r.prompt.promptVersion).toBe(PROMPT_VERSION);
    expect(r.prompt.user).toContain("1. e4 e5");
    expect(r.prompt.user).toContain("White to move");
    expect(r.prompt.user).toContain("depth 22");
    expect(r.prompt.user).not.toMatch(/\{\{\w+\}\}/);
    expect(r.prompt.system.length).toBeGreaterThan(50);
  });

  it("builds a grade prompt with the class phrase and win percentages", () => {
    const req: ExplainRequest = {
      mode: "grade",
      fen: START,
      verdict: { moveUci: "f2f3", moveClass: "blunder", winPctBefore: 53, winPctAfter: 21 },
      playedLine: { multipv: 1, depth: 20, cp: -320, pv: ["f2f3", "e7e5"] },
      bestLine: { multipv: 1, depth: 20, cp: 30, pv: ["e2e4", "e7e5"] },
    };
    const r = buildPrompt(req);
    if (!r.ok) throw new Error(r.error);
    expect(r.prompt.user).toContain("a blunder");
    expect(r.prompt.user).toContain("53% to 21%");
    expect(r.prompt.user).toContain("1. f3");
    expect(r.prompt.user).not.toMatch(/\{\{\w+\}\}/);
  });

  it("fails on an illegal client-reported line", () => {
    const req: ExplainRequest = {
      mode: "candidates",
      fen: START,
      lines: [{ multipv: 1, depth: 20, cp: 30, pv: ["e2e4", "a1a8"] }],
    };
    expect(buildPrompt(req).ok).toBe(false);
  });

  it("fails on a FEN with a bad side-to-move field", () => {
    const req: ExplainRequest = {
      mode: "candidates",
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",
      lines: [{ multipv: 1, depth: 20, cp: 30, pv: ["e2e4"] }],
    };
    expect(buildPrompt(req).ok).toBe(false);
  });
});
