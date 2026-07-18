import { Chess } from "chess.js";

/**
 * The same position with the OTHER side to move — the grounding for
 * "what would the other side play here?". Returns null when that position
 * is illegal (the current side to move is in check: they must address it,
 * so 'passing' the turn makes no chess sense) or the FEN doesn't parse.
 */
export function flipSideToMove(fen: string): string | null {
  try {
    if (new Chess(fen).inCheck()) return null;
  } catch {
    return null;
  }
  const parts = fen.split(" ");
  if (parts.length !== 6) return null;
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-"; // en passant evaporates with the tempo
  parts[4] = "0";
  const flipped = parts.join(" ");
  try {
    new Chess(flipped);
  } catch {
    return null;
  }
  return flipped;
}
