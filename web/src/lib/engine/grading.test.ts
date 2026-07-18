import { describe, expect, it } from "vitest";
import { cpToWinPct, gradePlayedMove, lineWinPct } from "./grading";
import type { MoveClass } from "./grading";
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
    expect(gradePlayedMove(best, played, "w").moveClass).toBe("best");
  });

  it("small drop is good", () => {
    const played = line({ cp: 10, pv: ["g1f3"] });
    const v = gradePlayedMove(best, played, "w");
    expect(v.moveClass).toBe("good");
    expect(v.winPctDrop).toBeLessThan(10);
  });

  it("hanging the queen is a blunder", () => {
    const played = line({ cp: -900, pv: ["d1g4"] });
    expect(gradePlayedMove(best, played, "w").moveClass).toBe("blunder");
  });

  it("missing a forced mate for a drawish eval is a blunder", () => {
    const mateBest = line({ mate: 2, pv: ["d1h5"] });
    const played = line({ cp: 0, pv: ["a2a3"] });
    const v = gradePlayedMove(mateBest, played, "w");
    expect(v.moveClass).toBe("blunder");
    expect(v.winPctDrop).toBeCloseTo(50);
  });

  it("walking into mate is a blunder", () => {
    const played = line({ mate: -4, pv: ["f2f3"] });
    expect(gradePlayedMove(best, played, "w").moveClass).toBe("blunder");
  });

  it("clamps a better-than-best played move to zero drop", () => {
    const played = line({ cp: 60, pv: ["d2d4"] });
    const v = gradePlayedMove(best, played, "w");
    expect(v.winPctDrop).toBe(0);
    expect(v.moveClass).toBe("good");
  });

  it("mid-range drop is a mistake", () => {
    // 35cp -> -250cp is a ~25 win% drop
    const played = line({ cp: -250, pv: ["b2b4"] });
    expect(gradePlayedMove(best, played, "w").moveClass).toBe("mistake");
  });
});

describe("gradePlayedMove — class boundaries", () => {
  // THRESHOLDS in grading.ts are checked as `drop >= threshold`, most severe
  // first: >=30 blunder, >=20 mistake, >=10 inaccuracy, else good.
  //
  // Lichess win% is winPct(cp) = 100 / (1 + exp(-0.00368208*cp)). We anchor the
  // best line at cp 0 (exactly 50%), so the mover's drop == 50 - winPct(played).
  // Solving winPct(played) for each target drop, then nudging just over / under
  // the boundary (cp is integer here, so exact-threshold ties don't arise):
  //
  //   drop 10 boundary (inaccuracy): winPct 40 at cp = -110.1
  //     cp -111 -> winPct 39.92 -> drop 10.08 (>=10 -> inaccuracy)
  //     cp -109 -> winPct 40.10 -> drop  9.90 (<10  -> good)
  //   drop 20 boundary (mistake):    winPct 30 at cp = -230.1
  //     cp -231 -> winPct 29.93 -> drop 20.07 (>=20 -> mistake)
  //     cp -229 -> winPct 30.09 -> drop 19.91 (<20  -> inaccuracy)
  //   drop 30 boundary (blunder):    winPct 20 at cp = -376.5
  //     cp -378 -> winPct 19.91 -> drop 30.09 (>=30 -> blunder)
  //     cp -375 -> winPct 20.09 -> drop 29.91 (<30  -> mistake)
  const bestEven = line({ cp: 0, pv: ["e2e4", "e7e5"] });

  // Both movers exercised: cp is already mover-relative (same side to move for
  // best and played), so the classification math is identical either way — the
  // `mover` field is just recorded. We assert both to lock that in.
  const cases: ReadonlyArray<{ cp: number; expected: MoveClass; note: string }> = [
    { cp: -109, expected: "good", note: "just under the inaccuracy boundary" },
    { cp: -111, expected: "inaccuracy", note: "just over the inaccuracy boundary" },
    { cp: -229, expected: "inaccuracy", note: "just under the mistake boundary" },
    { cp: -231, expected: "mistake", note: "just over the mistake boundary" },
    { cp: -375, expected: "mistake", note: "just under the blunder boundary" },
    { cp: -378, expected: "blunder", note: "just over the blunder boundary" },
  ];

  for (const mover of ["w", "b"] as const) {
    for (const { cp, expected, note } of cases) {
      it(`${mover}-mover: cp ${cp} is ${expected} (${note})`, () => {
        const played = line({ cp, pv: ["a2a3"] });
        expect(gradePlayedMove(bestEven, played, mover).moveClass).toBe(expected);
      });
    }
  }

  it("the inaccuracy class is reachable", () => {
    const played = line({ cp: -111, pv: ["a2a3"] });
    expect(gradePlayedMove(bestEven, played, "w").moveClass).toBe("inaccuracy");
  });
});
