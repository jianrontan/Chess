import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { buildEditorFen, deriveCastlingRights } from "./editor";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function placement(fen: string): Chess {
  return new Chess(fen, { skipValidation: true });
}

describe("deriveCastlingRights", () => {
  it("gives full rights from the start position", () => {
    expect(deriveCastlingRights(placement(START))).toBe("KQkq");
  });

  it("drops rights when a rook is missing", () => {
    // no h1 rook
    const p = placement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w - - 0 1");
    expect(deriveCastlingRights(p)).toBe("Qkq");
  });

  it("drops all white rights when the king moved off e1", () => {
    const p = placement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1KNR w - - 0 1");
    expect(deriveCastlingRights(p)).toBe("kq");
  });

  it("is '-' for a bare-kings position", () => {
    const p = placement("8/8/8/4k3/8/4K3/8/8 w - - 0 1");
    expect(deriveCastlingRights(p)).toBe("-");
  });
});

describe("buildEditorFen", () => {
  it("accepts a normal position", () => {
    const r = buildEditorFen(placement(START), "w");
    expect(r.error).toBeUndefined();
    expect(r.fen).toContain("KQkq");
  });

  it("rejects a position with no black king", () => {
    const p = placement("8/8/8/8/8/8/8/4K3 w - - 0 1");
    const r = buildEditorFen(p, "w");
    expect(r.error).toBeDefined();
  });

  it("rejects when the side NOT to move is in check", () => {
    // White king on e1 attacked by rook on e8, but it's Black's move.
    const p = placement("4r2k/8/8/8/8/8/8/4K3 b - - 0 1");
    const r = buildEditorFen(p, "b");
    expect(r.error).toMatch(/impossible position/);
  });

  it("accepts the same position with the checked side to move", () => {
    const p = placement("4r2k/8/8/8/8/8/8/4K3 w - - 0 1");
    const r = buildEditorFen(p, "w");
    expect(r.error).toBeUndefined();
  });

  it("sets en passant to '-' and derives castling", () => {
    const r = buildEditorFen(placement(START), "b");
    expect(r.fen?.split(" ").slice(1)).toEqual(["b", "KQkq", "-", "0", "1"]);
  });
});
