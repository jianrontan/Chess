/**
 * Board-editor helpers: build a valid FEN from a free-form piece placement.
 *
 * Castling rights are EXPLICIT user choices (NCM-style checkboxes) but are
 * intersected with what the placement actually allows (king/rook on their
 * home squares) — an invalid castling flag is the easiest way to build an
 * illegal FEN, so the impossible ones are dropped as defense in depth on top
 * of the UI disabling them. En passant is always "-" (an editor position has
 * no move history).
 */

import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";

export interface CastlingChoice {
  K: boolean; // White kingside
  Q: boolean; // White queenside
  k: boolean; // Black kingside
  q: boolean; // Black queenside
}

export const NO_CASTLING: CastlingChoice = { K: false, Q: false, k: false, q: false };

/** Which castling rights the placement makes POSSIBLE (home-square check). */
export function availableCastling(placement: Chess): CastlingChoice {
  const piece = (sq: string) => {
    const p = placement.get(sq as Square);
    return p ? `${p.color}${p.type}` : "";
  };
  const wk = piece("e1") === "wk";
  const bk = piece("e8") === "bk";
  return {
    K: wk && piece("h1") === "wr",
    Q: wk && piece("a1") === "wr",
    k: bk && piece("h8") === "br",
    q: bk && piece("a8") === "br",
  };
}

/** Parse a FEN castling field ("KQkq" / "-") into a choice object. */
export function castlingFromFen(fen: string): CastlingChoice {
  const field = fen.split(" ")[2] ?? "-";
  return {
    K: field.includes("K"),
    Q: field.includes("Q"),
    k: field.includes("k"),
    q: field.includes("q"),
  };
}

function castlingField(choice: CastlingChoice, avail: CastlingChoice): string {
  let rights = "";
  if (choice.K && avail.K) rights += "K";
  if (choice.Q && avail.Q) rights += "Q";
  if (choice.k && avail.k) rights += "k";
  if (choice.q && avail.q) rights += "q";
  return rights || "-";
}

/** Starting-army counts used for promotion accounting. */
const INITIAL_COUNTS: Partial<Record<PieceSymbol, number>> = {
  q: 1,
  r: 2,
  b: 2,
  n: 2,
};

/**
 * Reject impossible armies while allowing promotion-legal ones: every piece
 * beyond the starting set must be paid for by a missing pawn (a promotion).
 * 8 pawns + 2 queens is impossible; 7 pawns + 2 queens is fine.
 * Returns a human-readable error, or null when the material is possible.
 */
export function materialError(placement: Chess): string | null {
  for (const color of ["w", "b"] as Color[]) {
    const name = color === "w" ? "White" : "Black";
    const counts: Record<string, number> = {};
    for (const row of placement.board()) {
      for (const sq of row) {
        if (sq && sq.color === color) counts[sq.type] = (counts[sq.type] ?? 0) + 1;
      }
    }
    const pawns = counts.p ?? 0;
    if (pawns > 8) {
      return `${name} has ${pawns} pawns — 8 is the maximum.`;
    }
    let extras = 0;
    for (const [type, initial] of Object.entries(INITIAL_COUNTS)) {
      extras += Math.max(0, (counts[type] ?? 0) - (initial as number));
    }
    const promotions = 8 - pawns;
    if (extras > promotions) {
      return (
        `${name} has ${extras} more piece${extras === 1 ? "" : "s"} than the starting set ` +
        `but only ${promotions} missing pawn${promotions === 1 ? "" : "s"} to promote — impossible.`
      );
    }
  }
  return null;
}

export interface EditorResult {
  fen?: string;
  error?: string;
}

/**
 * Assemble and validate a full FEN from an editor placement, side to move,
 * and the user's castling choice. Returns { fen } on success or { error }
 * with a human-readable reason.
 */
export function buildEditorFen(
  placement: Chess,
  sideToMove: "w" | "b",
  castling: CastlingChoice = NO_CASTLING,
): EditorResult {
  const material = materialError(placement);
  if (material) return { error: material };

  const placementField = placement.fen().split(" ")[0];
  const rights = castlingField(castling, availableCastling(placement));
  const candidate = `${placementField} ${sideToMove} ${rights} - 0 1`;

  try {
    const game = new Chess(candidate); // full validation (kings, pawns on back ranks…)
    // chess.js accepts positions where the side NOT to move is in check —
    // those are unreachable/illegal, and the engine may misbehave on them.
    const flipped = new Chess(
      `${placementField} ${sideToMove === "w" ? "b" : "w"} ${rights} - 0 1`,
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
