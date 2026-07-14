/** A single engine line (one MultiPV entry) at some depth. */
export interface EngineLine {
  /** 1-based MultiPV rank (1 = best). */
  multipv: number;
  /** Search depth this line was reported at. */
  depth: number;
  /** Evaluation in centipawns from the side to move, if not a mate score. */
  cp?: number;
  /** Mate in N (negative = getting mated), if a mate score. */
  mate?: number;
  /** Principal variation as UCI moves; pv[0] is the candidate move. */
  pv: string[];
}

export interface AnalyzeOptions {
  /** Number of candidate lines to search (MultiPV). Default 3. */
  multipv?: number;
  /** Fixed search time in milliseconds. Default 3000. */
  movetimeMs?: number;
  /** Restrict the search to these UCI moves (Mode 2 grading). */
  searchMoves?: string[];
  /** Progressive updates as depth climbs. */
  onLines?: (lines: EngineLine[]) => void;
}

export interface AnalyzeResult {
  /** Final lines, index 0 = best. */
  lines: EngineLine[];
  /**
   * Engine's bestmove answer. `null` for terminal positions (checkmate,
   * stalemate) or a searchmoves restriction with no legal move — callers
   * must handle this before building any downstream payload.
   */
  bestMove: string | null;
  /** Deepest completed depth. */
  depth: number;
}

export interface EngineInfo {
  /** Whether the page is cross-origin isolated (SharedArrayBuffer available). */
  threaded: boolean;
  /** Threads the engine was configured with. */
  threads: number;
  /** Engine build variant in use. */
  variant: "lite" | "lite-single";
}
