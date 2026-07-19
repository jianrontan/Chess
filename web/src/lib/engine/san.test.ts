import { describe, expect, it } from "vitest";
import { formatSanLine, uciToSan } from "./san";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("uciToSan", () => {
  it("converts a simple White-to-move opening PV to SAN", () => {
    expect(uciToSan(START_FEN, ["e2e4", "e7e5", "g1f3"])).toEqual([
      "e4",
      "e5",
      "Nf3",
    ]);
  });

  it("converts moves when Black is to move", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    expect(uciToSan(fen, ["e7e5", "g1f3", "b8c6"])).toEqual([
      "e5",
      "Nf3",
      "Nc6",
    ]);
  });

  it("renders a promotion with the =Q suffix", () => {
    // White pawn e7 promotes with check down the e-file onto the Black king.
    const fen = "8/4P3/8/4k3/8/8/8/7K w - - 0 1";
    expect(uciToSan(fen, ["e7e8q"])).toEqual(["e8=Q+"]);
  });

  it("converts castling to O-O", () => {
    const fen =
      "rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    expect(uciToSan(fen, ["e1g1"])).toEqual(["O-O"]);
  });

  it("stops at the first illegal move and passes the remainder through raw", () => {
    // e2e4 is legal; e2e4 again is illegal (pawn already moved) → raw tail.
    expect(uciToSan(START_FEN, ["e2e4", "e2e4", "g1f3"])).toEqual([
      "e4",
      "e2e4",
      "g1f3",
    ]);
  });

  it("returns every move raw when the FEN is invalid", () => {
    expect(uciToSan("not a fen", ["e2e4", "e7e5"])).toEqual(["e2e4", "e7e5"]);
  });

  it("returns an empty array for an empty PV", () => {
    expect(uciToSan(START_FEN, [])).toEqual([]);
  });
});

describe("formatSanLine", () => {
  it("numbers a White-to-move opening line", () => {
    expect(formatSanLine(START_FEN, ["e2e4", "e7e5", "g1f3"])).toBe(
      "1. e4 e5 2. Nf3",
    );
  });

  it("uses the ellipsis prefix for a Black-to-move line", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    expect(formatSanLine(fen, ["e7e5", "g1f3", "b8c6"])).toBe(
      "1… e5 2. Nf3 Nc6",
    );
  });

  it("respects the FEN's fullmove counter for a mid-game Black line", () => {
    // Counter 12, Black to move → "12… " and the number ticks after Black.
    const fen =
      "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 b - - 6 12";
    expect(formatSanLine(fen, ["c5f2", "g1h1", "f2e3"])).toBe(
      "12… Bxf2+ 13. Kh1 Be3",
    );
  });

  it("formats a promotion inside a numbered line", () => {
    const fen = "8/4P3/8/4k3/8/8/8/7K w - - 0 1";
    expect(formatSanLine(fen, ["e7e8q"])).toBe("1. e8=Q+");
  });

  it("truncates to maxMoves", () => {
    expect(
      formatSanLine(START_FEN, ["e2e4", "e7e5", "g1f3", "b8c6"], 2),
    ).toBe("1. e4 e5");
  });

  it("keeps numbering while spilling the illegal tail as raw UCI", () => {
    // Conversion stops at the illegal 2nd move, so g1f3 also stays raw — but
    // the move numbering keeps ticking regardless of SAN vs UCI.
    expect(formatSanLine(START_FEN, ["e2e4", "e2e4", "g1f3"])).toBe(
      "1. e4 e2e4 2. g1f3",
    );
  });

  it("still numbers from move 1 (White) when the FEN is invalid", () => {
    expect(formatSanLine("garbage", ["e2e4", "e7e5"])).toBe("1. e2e4 e7e5");
  });

  it("returns an empty string for an empty PV", () => {
    expect(formatSanLine(START_FEN, [])).toBe("");
  });
});
