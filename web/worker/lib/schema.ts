/**
 * Request schema + structural validation for /api/explain.
 *
 * Everything the browser sends is CLIENT-REPORTED and untrusted: evals are
 * clamped, list/string sizes are capped, and move legality is verified later
 * by replaying the lines with chess.js (see prompt.ts). The Worker never
 * forwards raw client text into the LLM prompt — only values that survived
 * these checks, re-serialized by our own code.
 */

/** Payload caps — abuse guardrails, not UX limits. */
export const CAPS = {
  bodyBytes: 16_384,
  lines: 5, // k <= 5
  pvMoves: 12, // PVs are truncated, not rejected
  fenChars: 100,
} as const;

export interface WireLine {
  multipv: number;
  depth: number;
  cp?: number;
  mate?: number;
  pv: string[];
}

export const MOVE_CLASSES = [
  "best",
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
] as const;
export type WireMoveClass = (typeof MOVE_CLASSES)[number];

export interface CandidatesRequest {
  mode: "candidates";
  fen: string;
  lines: WireLine[];
}

export interface GradeRequest {
  mode: "grade";
  fen: string; // position BEFORE the played move
  verdict: {
    moveUci: string;
    moveClass: WireMoveClass;
    winPctBefore: number;
    winPctAfter: number;
  };
  playedLine: WireLine; // engine line starting with the played move
  bestLine: WireLine; // engine's preferred line from the same position
}

export type ExplainRequest = CandidatesRequest | GradeRequest;

export type ParseResult =
  | { ok: true; request: ExplainRequest }
  | { ok: false; error: string };

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Validate + normalize one client-reported engine line. Returns null if malformed. */
function parseLine(v: unknown): WireLine | null {
  if (!isRecord(v)) return null;
  const { multipv, depth, cp, mate, pv } = v;
  if (typeof multipv !== "number" || !Number.isInteger(multipv)) return null;
  if (typeof depth !== "number" || !Number.isInteger(depth)) return null;
  if (!Array.isArray(pv) || pv.length === 0) return null;
  const moves = pv.slice(0, CAPS.pvMoves);
  for (const m of moves) {
    if (typeof m !== "string" || !UCI_RE.test(m)) return null;
  }
  const line: WireLine = {
    multipv: clamp(multipv, 1, CAPS.lines),
    depth: clamp(depth, 1, 99),
    pv: moves as string[],
  };
  if (typeof cp === "number" && Number.isFinite(cp)) {
    line.cp = clamp(Math.round(cp), -9999, 9999);
  }
  if (typeof mate === "number" && Number.isInteger(mate)) {
    line.mate = clamp(mate, -64, 64);
  }
  if (line.cp === undefined && line.mate === undefined) return null;
  return line;
}

/**
 * Structural validation of the request body. Does NOT check chess legality —
 * that happens in prompt.ts when lines are replayed for SAN conversion.
 */
export function parseExplainRequest(body: unknown): ParseResult {
  if (!isRecord(body)) return fail("body must be a JSON object");

  const { fen, mode } = body;
  if (typeof fen !== "string" || fen.length === 0 || fen.length > CAPS.fenChars) {
    return fail("fen must be a non-empty string");
  }

  if (mode === "candidates") {
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return fail("lines must be a non-empty array");
    }
    if (body.lines.length > CAPS.lines) {
      return fail(`at most ${CAPS.lines} lines allowed`);
    }
    const lines: WireLine[] = [];
    for (const raw of body.lines) {
      const line = parseLine(raw);
      if (!line) return fail("malformed engine line");
      lines.push(line);
    }
    return { ok: true, request: { mode, fen, lines } };
  }

  if (mode === "grade") {
    const v = body.verdict;
    if (!isRecord(v)) return fail("verdict must be an object");
    if (typeof v.moveUci !== "string" || !UCI_RE.test(v.moveUci)) {
      return fail("verdict.moveUci must be a UCI move");
    }
    if (!MOVE_CLASSES.includes(v.moveClass as WireMoveClass)) {
      return fail("verdict.moveClass is invalid");
    }
    if (typeof v.winPctBefore !== "number" || typeof v.winPctAfter !== "number") {
      return fail("verdict win percentages must be numbers");
    }
    const playedLine = parseLine(body.playedLine);
    const bestLine = parseLine(body.bestLine);
    if (!playedLine || !bestLine) return fail("malformed engine line");
    if (playedLine.pv[0] !== v.moveUci) {
      return fail("playedLine must start with the played move");
    }
    return {
      ok: true,
      request: {
        mode,
        fen,
        verdict: {
          moveUci: v.moveUci,
          moveClass: v.moveClass as WireMoveClass,
          winPctBefore: clamp(v.winPctBefore, 0, 100),
          winPctAfter: clamp(v.winPctAfter, 0, 100),
        },
        playedLine,
        bestLine,
      },
    };
  }

  return fail("mode must be 'candidates' or 'grade'");
}
