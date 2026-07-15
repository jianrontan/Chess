/**
 * Board-editor helpers: build a valid FEN from a free-form piece placement.
 *
 * Castling rights are derived from piece placement (king/rook on their home
 * squares) rather than asked for — an invalid castling flag is the easiest
 * way to build an illegal FEN, so we don't offer the footgun. En passant is
 * always "-" (an editor position has no move history).
 */

import { Chess } from "chess.js";

/** Derive castling availability from where kings/rooks actually stand. */
export function deriveCastlingRights(placement: Chess): string {
  let rights = "";
  const piece = (sq: string) => {
    const p = placement.get(sq as Parameters<Chess["get"]>[0]);
    return p ? `${p.color}${p.type}` : "";
  };
  if (piece("e1") === "wk") {
    if (piece("h1") === "wr") rights += "K";
    if (piece("a1") === "wr") rights += "Q";
  }
  if (piece("e8") === "bk") {
    if (piece("h8") === "br") rights += "k";
    if (piece("a8") === "br") rights += "q";
  }
  return rights || "-";
}

export interface EditorResult {
  fen?: string;
  error?: string;
}

/**
 * Assemble and validate a full FEN from an editor placement + side to move.
 * Returns { fen } on success or { error } with a human-readable reason.
 */
export function buildEditorFen(placement: Chess, sideToMove: "w" | "b"): EditorResult {
  const placementField = placement.fen().split(" ")[0];
  const castling = deriveCastlingRights(placement);
  const candidate = `${placementField} ${sideToMove} ${castling} - 0 1`;

  try {
    const game = new Chess(candidate); // full validation (kings, checks, pawns on back ranks…)
    // chess.js accepts positions where the side NOT to move is in check —
    // those are unreachable/illegal, and the engine may misbehave on them.
    if (game.isCheck()) {
      // side to move in check is fine (that's just "in check")
    }
    const flipped = new Chess(
      `${placementField} ${sideToMove === "w" ? "b" : "w"} ${castling} - 0 1`,
    );
    if (flipped.isCheck()) {
      return {
        error: `${sideToMove === "w" ? "Black" : "White"} is in check but it isn't their turn — impossible position.`,
      };
    }
    return { fen: game.fen() };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Invalid position" };
  }
}
