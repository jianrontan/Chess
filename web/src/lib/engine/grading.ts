/**
 * Mode 2 move grading: classify a played move by its win-percentage drop
 * versus the engine's best move in the same position.
 *
 * Win% (not raw centipawns) because a 100cp drop is huge in an equal
 * position and irrelevant at +9 — see docs/ARCHITECTURE.md "Step 2b".
 * Both evals MUST come from the same position (the position BEFORE the
 * move) at comparable movetime/depth, so they share a side-to-move
 * perspective and a cross-depth delta cannot skew the grade.
 */

import type { EngineLine } from "./types";

/** Lichess's centipawns → expected-win-percentage conversion. */
export function cpToWinPct(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Win% for a line, treating forced mates as decided. */
export function lineWinPct(line: Pick<EngineLine, "cp" | "mate">): number {
  if (line.mate !== undefined) return line.mate > 0 ? 100 : 0;
  if (line.cp !== undefined) return cpToWinPct(line.cp);
  return 50;
}

export type MoveClass = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

/** Win%-drop thresholds (lichess-style); tune by feel later (see NFRs). */
const THRESHOLDS: ReadonlyArray<[number, MoveClass]> = [
  [30, "blunder"],
  [20, "mistake"],
  [10, "inaccuracy"],
];

export interface MoveVerdict {
  moveClass: MoveClass;
  /** Side that played the graded move. */
  mover: "w" | "b";
  /** Mover's win% had they played the best move. */
  winPctBefore: number;
  /** Mover's win% after the move actually played. */
  winPctAfter: number;
  /** Win% given up versus the best move (≥ 0; small negatives clamped). */
  winPctDrop: number;
  /** The played move's own line (eval + expected continuation). */
  playedLine: EngineLine;
  /** The engine's best line in the pre-move position. */
  bestLine: EngineLine;
}

/**
 * Grade a played move against the best line of the same position.
 * `playedLine.pv[0]` must be the played move (UCI); `mover` is the side
 * to move in that position.
 */
export function gradePlayedMove(
  bestLine: EngineLine,
  playedLine: EngineLine,
  mover: "w" | "b",
): MoveVerdict {
  const winPctBefore = lineWinPct(bestLine);
  const winPctAfter = Math.min(winPctBefore, lineWinPct(playedLine));
  const drop = winPctBefore - winPctAfter;

  let moveClass: MoveClass = "good";
  if (playedLine.pv[0] === bestLine.pv[0]) {
    moveClass = "best";
  } else {
    for (const [threshold, cls] of THRESHOLDS) {
      if (drop >= threshold) {
        moveClass = cls;
        break;
      }
    }
  }
  return { moveClass, mover, winPctBefore, winPctAfter, winPctDrop: drop, playedLine, bestLine };
}
