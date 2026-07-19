import { Chess } from "chess.js";

/**
 * UCI → SAN conversion for DISPLAY only.
 *
 * This is deliberately best-effort and NEVER throws: the analysis UI shows
 * engine PVs as they stream in, and a display helper that could throw (or
 * silently drop moves) would blank the panel on the first oddity. Contrast
 * with the worker's `pvToSan` in web/worker/lib/prompt.ts, which is a strict
 * legality GATE — there an illegal move must fail the whole request so nothing
 * unverified reaches the LLM. Here the goal is the opposite: degrade
 * gracefully, converting what we can and passing the rest through verbatim.
 */

/**
 * Replay the UCI moves in `pv` from `fen` with chess.js, returning one SAN
 * string per move ("Nf3", "O-O", "exd8=Q+"). On the first illegal or
 * unparseable move — or an invalid FEN — conversion stops and every REMAINING
 * move (including the offending one) is passed through as its raw UCI string,
 * so the returned array is always the same length as `pv` and no move is lost.
 */
export function uciToSan(fen: string, pv: string[]): string[] {
  let board: Chess;
  try {
    board = new Chess(fen);
  } catch {
    // Invalid FEN — nothing can be converted; echo the whole line raw.
    return [...pv];
  }

  const out: string[] = [];
  let stopped = false;
  for (const uci of pv) {
    if (stopped) {
      out.push(uci);
      continue;
    }
    try {
      const san = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      }).san;
      out.push(san);
    } catch {
      // First illegal move: emit it and everything after it raw.
      stopped = true;
      out.push(uci);
    }
  }
  return out;
}

/** Side to move and fullmove counter read straight off the FEN, with safe
 * fallbacks (White, move 1) so a malformed FEN still yields sane numbering
 * rather than throwing — the raw-UCI line still renders. */
function fenMeta(fen: string): { whiteToMove: boolean; fullmove: number } {
  const fields = fen.trim().split(/\s+/);
  const whiteToMove = fields[1] !== "b";
  const parsed = Number.parseInt(fields[5] ?? "", 10);
  const fullmove = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  return { whiteToMove, fullmove };
}

/**
 * Format a PV as a numbered continuation string starting from `fen`'s own
 * side to move and fullmove counter:
 *   White to move (counter 1) → "1. e4 e5 2. Nf3"
 *   Black to move (counter 1) → "1… e5 2. Nf3 Nc6"
 *   Black to move (counter 12) → "12… Qxh2 13. Kf1 …"
 *
 * SAN comes from {@link uciToSan}, so check/mate suffixes and castling are
 * handled by chess.js and any post-illegal tail appears as raw UCI. The
 * fullmove number advances after each Black move, matching PGN convention.
 * `maxMoves` truncates the line (default: no limit); an empty `pv` yields "".
 */
export function formatSanLine(
  fen: string,
  pv: string[],
  maxMoves?: number,
): string {
  const limit = maxMoves ?? pv.length;
  const sans = uciToSan(fen, pv).slice(0, Math.max(0, limit));
  const { whiteToMove, fullmove } = fenMeta(fen);

  let n = fullmove;
  let white = whiteToMove;
  const parts: string[] = [];
  for (let i = 0; i < sans.length; i++) {
    if (white) {
      parts.push(`${n}. ${sans[i]}`);
    } else {
      // A line that opens on Black's move needs the "N… " prefix; a Black move
      // that follows its own White move in the same pair is bare.
      parts.push(i === 0 ? `${n}… ${sans[i]}` : sans[i]);
      n += 1;
    }
    white = !white;
  }
  return parts.join(" ");
}
