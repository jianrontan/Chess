import { describe, expect, it } from "vitest";
import { buildPrompt, evalPhrase, PROMPT_VERSION, pvToSan } from "./prompt";
import type { ExplainRequest } from "./schema";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// After 1. e4: Black to move.
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

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
