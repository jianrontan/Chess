import { describe, expect, it } from "vitest";
import { flipSideToMove } from "./fen";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("flipSideToMove", () => {
  it("flips white to black and clears en passant", () => {
    const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const flipped = flipSideToMove(afterE4);
    expect(flipped).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1");
  });

  it("flips black to white", () => {
    expect(flipSideToMove(START)?.split(" ")[1]).toBe("b");
  });

  it("refuses when the side to move is in check (passing is illegal)", () => {
    // White king on e1 checked by a rook on e8.
    const inCheck = "4r1k1/8/8/8/8/8/8/4K3 w - - 0 1";
    expect(flipSideToMove(inCheck)).toBeNull();
  });

  it("refuses garbage", () => {
    expect(flipSideToMove("not a fen")).toBeNull();
    expect(flipSideToMove("")).toBeNull();
  });
});
