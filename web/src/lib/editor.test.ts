import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  availableCastling,
  buildEditorFen,
  castlingFromFen,
  materialError,
  type CastlingChoice,
} from "./editor";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const ALL: CastlingChoice = { K: true, Q: true, k: true, q: true };
const NONE: CastlingChoice = { K: false, Q: false, k: false, q: false };

function placement(fen: string): Chess {
  return new Chess(fen, { skipValidation: true });
}

describe("availableCastling", () => {
  it("gives full availability from the start position", () => {
    expect(availableCastling(placement(START))).toEqual(ALL);
  });

  it("drops availability when a rook is missing", () => {
    // no h1 rook
    const p = placement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w - - 0 1");
    expect(availableCastling(p)).toEqual({ ...ALL, K: false });
  });

  it("drops all white availability when the king is off e1", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1KNR w - - 0 1");
    expect(availableCastling(p)).toEqual({ ...ALL, K: false, Q: false });
  });

  it("is empty for a bare-kings position", () => {
    expect(availableCastling(placement("8/8/8/4k3/8/4K3/8/8 w - - 0 1"))).toEqual(NONE);
  });
});

describe("castlingFromFen", () => {
  it("parses KQkq and -", () => {
    expect(castlingFromFen(START)).toEqual(ALL);
    expect(castlingFromFen("8/8/8/4k3/8/4K3/8/8 w - - 0 1")).toEqual(NONE);
    expect(castlingFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kq - 0 1")).toEqual({
      K: true,
      Q: false,
      k: false,
      q: true,
    });
  });
});

describe("materialError", () => {
  it("accepts the start position and bare kings", () => {
    expect(materialError(placement(START))).toBeNull();
    expect(materialError(placement("8/8/8/4k3/8/4K3/8/8 w - - 0 1"))).toBeNull();
  });

  it("rejects 9 pawns", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/P7/PPPPPPPP/RNBQKBNR w - - 0 1");
    expect(materialError(p)).toMatch(/9 pawns/);
  });

  it("rejects 8 pawns + 2 queens (no pawn left to have promoted)", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/3Q4/PPPPPPPP/RNBQKBNR w - - 0 1");
    expect(materialError(p)).toMatch(/impossible/);
  });

  it("accepts 7 pawns + 2 queens (one promotion)", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/3Q4/PPPPPPP1/RNBQKBNR w - - 0 1");
    expect(materialError(p)).toBeNull();
  });

  it("rejects 3 knights with all 8 pawns", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/3N4/PPPPPPPP/RNBQKBNR w - - 0 1");
    expect(materialError(p)).toMatch(/impossible/);
  });

  it("accepts underpromotion armies (3 rooks, 6 pawns)", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/3RR3/PPPPPP2/RNBQKBN1 w - - 0 1");
    expect(materialError(p)).toBeNull();
  });

  it("checks both colors", () => {
    const p = placement("rnbqkbnr/pppppppp/3q4/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1");
    expect(materialError(p)).toMatch(/Black/);
  });
});

describe("buildEditorFen", () => {
  it("accepts a normal position with chosen castling", () => {
    const r = buildEditorFen(placement(START), "w", ALL);
    expect(r.error).toBeUndefined();
    expect(r.fen).toContain("KQkq");
  });

  it("honors unchecked castling boxes", () => {
    const r = buildEditorFen(placement(START), "w", { ...ALL, K: false });
    expect(r.fen).toContain(" Qkq ");
  });

  it("drops checked-but-unavailable rights instead of failing", () => {
    // no h1 rook: K is impossible even though the box is checked
    const p = placement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w - - 0 1");
    const r = buildEditorFen(p, "w", ALL);
    expect(r.error).toBeUndefined();
    expect(r.fen).toContain(" Qkq ");
  });

  it("defaults to no castling when no choice is given", () => {
    const r = buildEditorFen(placement(START), "w");
    expect(r.fen).toContain(" - ");
  });

  it("rejects impossible material before FEN validation", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/3Q4/PPPPPPPP/RNBQKBNR w - - 0 1");
    expect(buildEditorFen(p, "w", ALL).error).toMatch(/impossible/);
  });

  it("rejects a position with no black king", () => {
    const p = placement("8/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(buildEditorFen(p, "w", NONE).error).toBeTruthy();
  });

  it("rejects pawns on the back rank", () => {
    const p = placement("P3k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(buildEditorFen(p, "w", NONE).error).toBeTruthy();
  });

  it("rejects when the side NOT to move is in check", () => {
    // Black king attacked by the e7 rook, but White to move — impossible.
    const p = placement("4k3/4R3/8/8/8/8/8/4K3 w - - 0 1");
    expect(buildEditorFen(p, "w", NONE).error).toMatch(/impossible/);
  });

  it("allows the side to move to be in check (that's just check)", () => {
    const r = buildEditorFen(
      new Chess("4k3/4R3/8/8/8/8/8/4K3 b - - 0 1", { skipValidation: true }),
      "b",
      NONE,
    );
    expect(r.error).toBeUndefined();
  });

  it("round-trips a PGN final position", () => {
    const game = new Chess();
    game.loadPgn("1. e4 e5 2. Nf3 Nc6 3. Bb5");
    const p = new Chess(game.fen(), { skipValidation: true });
    const r = buildEditorFen(p, "b", castlingFromFen(game.fen()));
    expect(r.error).toBeUndefined();
    expect(r.fen?.split(" ")[0]).toBe(game.fen().split(" ")[0]);
    expect(r.fen).toContain("KQkq");
  });
});
