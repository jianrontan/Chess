import { describe, expect, it } from "vitest";
import { cpToWinPct, gradePlayedMove, lineWinPct } from "./grading";
import type { EngineLine } from "./types";

function line(overrides: Partial<EngineLine>): EngineLine {
  return { multipv: 1, depth: 20, pv: ["e2e4"], ...overrides };
}

describe("cpToWinPct", () => {
  it("is 50% at equality", () => {
    expect(cpToWinPct(0)).toBeCloseTo(50);
  });

  it("is symmetric", () => {
    expect(cpToWinPct(150) + cpToWinPct(-150)).toBeCloseTo(100);
  });

  it("saturates toward 100 for winning evals", () => {
    expect(cpToWinPct(1000)).toBeGreaterThan(95);
    expect(cpToWinPct(1000)).toBeLessThanOrEqual(100);
  });

  it("a pawn up in an equal game matters more than at +9", () => {
    const nearEqual = cpToWinPct(100) - cpToWinPct(0);
    const alreadyWinning = cpToWinPct(1000) - cpToWinPct(900);
    expect(nearEqual).toBeGreaterThan(alreadyWinning * 5);
  });
});

describe("lineWinPct", () => {
  it("treats mate for the mover as 100", () => {
    expect(lineWinPct({ mate: 3 })).toBe(100);
  });

  it("treats getting mated as 0", () => {
    expect(lineWinPct({ mate: -2 })).toBe(0);
  });

  it("falls back to 50 with no score", () => {
    expect(lineWinPct({})).toBe(50);
  });
});

describe("gradePlayedMove", () => {
  const best = line({ cp: 35, pv: ["e2e4", "e7e5"] });

  it("classifies the engine's own move as best regardless of noise", () => {
    const played = line({ cp: 30, pv: ["e2e4", "c7c5"] });
    expect(gradePlayedMove(best, played).moveClass).toBe("best");
  });

  it("small drop is good", () => {
    const played = line({ cp: 10, pv: ["g1f3"] });
    const v = gradePlayedMove(best, played);
    expect(v.moveClass).toBe("good");
    expect(v.winPctDrop).toBeLessThan(10);
  });

  it("hanging the queen is a blunder", () => {
    const played = line({ cp: -900, pv: ["d1g4"] });
    expect(gradePlayedMove(best, played).moveClass).toBe("blunder");
  });

  it("missing a forced mate for a drawish eval is a blunder", () => {
    const mateBest = line({ mate: 2, pv: ["d1h5"] });
    const played = line({ cp: 0, pv: ["a2a3"] });
    const v = gradePlayedMove(mateBest, played);
    expect(v.moveClass).toBe("blunder");
    expect(v.winPctDrop).toBeCloseTo(50);
  });

  it("walking into mate is a blunder", () => {
    const played = line({ mate: -4, pv: ["f2f3"] });
    expect(gradePlayedMove(best, played).moveClass).toBe("blunder");
  });

  it("clamps a better-than-best played move to zero drop", () => {
    const played = line({ cp: 60, pv: ["d2d4"] });
    const v = gradePlayedMove(best, played);
    expect(v.winPctDrop).toBe(0);
    expect(v.moveClass).toBe("good");
  });

  it("mid-range drop is a mistake", () => {
    // 35cp -> -250cp is a ~25 win% drop
    const played = line({ cp: -250, pv: ["b2b4"] });
    expect(gradePlayedMove(best, played).moveClass).toBe("mistake");
  });
});
