import { describe, expect, it } from "vitest";
import { whiteScore } from "./format";

// UCI convention (web/CLAUDE.md): engine cp/mate are from the SIDE TO MOVE.
// whiteScore re-expresses that from White's perspective — so a score is left
// as-is when White is to move and sign-flipped when Black is to move.
describe("whiteScore", () => {
  describe("centipawns", () => {
    it("leaves a cp score unchanged when White is to move", () => {
      // side-to-move eval already == White's eval.
      expect(whiteScore({ cp: 50 }, "w")).toBe("+0.50");
    });

    it("negates a cp score when Black is to move", () => {
      // +0.50 for Black-to-move means -0.50 for White.
      expect(whiteScore({ cp: 50 }, "b")).toBe("-0.50");
    });

    it("flips a Black-favouring cp score to positive for White", () => {
      // Black to move is worse off (-1.20) => White is +1.20.
      expect(whiteScore({ cp: -120 }, "b")).toBe("+1.20");
    });

    it("keeps a negative cp negative when White is to move", () => {
      expect(whiteScore({ cp: -30 }, "w")).toBe("-0.30");
    });

    it("shows zero as +0.00 for either side to move", () => {
      expect(whiteScore({ cp: 0 }, "w")).toBe("+0.00");
      expect(whiteScore({ cp: 0 }, "b")).toBe("+0.00");
    });

    it("renders two decimal places for sub-pawn edges", () => {
      expect(whiteScore({ cp: 5 }, "w")).toBe("+0.05");
    });
  });

  describe("mate scores (#-N convention: '#3' White mates, '#-3' Black mates)", () => {
    it("keeps a positive mate positive when White is to move (White mates)", () => {
      expect(whiteScore({ mate: 3 }, "w")).toBe("#3");
    });

    it("negates a positive mate when Black is to move (Black mates)", () => {
      // mate 3 for Black-to-move => Black delivers mate => '#-3' for White.
      expect(whiteScore({ mate: 3 }, "b")).toBe("#-3");
    });

    it("shows a negative mate as White getting mated when White is to move", () => {
      expect(whiteScore({ mate: -3 }, "w")).toBe("#-3");
    });

    it("shows a negative mate as White mating when Black is to move", () => {
      // Black-to-move is getting mated (mate -3) => White mates => '#3'.
      expect(whiteScore({ mate: -3 }, "b")).toBe("#3");
    });

    it("handles mate in 1 for both movers", () => {
      expect(whiteScore({ mate: 1 }, "w")).toBe("#1");
      expect(whiteScore({ mate: 1 }, "b")).toBe("#-1");
    });

    it("prefers mate over cp when both are present", () => {
      expect(whiteScore({ cp: 20, mate: 2 }, "w")).toBe("#2");
    });
  });

  it("returns '?' when neither cp nor mate is present", () => {
    expect(whiteScore({}, "w")).toBe("?");
  });
});
