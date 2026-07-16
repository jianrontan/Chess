/**
 * Builds the LLM prompt from a validated request.
 *
 * This is the legality gate: every client-reported PV is replayed with
 * chess.js from the given FEN. An illegal move anywhere fails the whole
 * request — nothing the client sent reaches the prompt as free text; the
 * prompt is assembled from OUR re-serialization (SAN via chess.js, evals
 * clamped by schema.ts and formatted here).
 *
 * The template itself lives at prompts/explain.v1.json (repo root) — single
 * source of truth shared with the Python eval harness. Bump versions by
 * adding a new file, never by editing v1 in place.
 */

import { Chess } from "chess.js";
import template from "../../../prompts/explain.v1.json";
import type { ExplainRequest, WireLine, WireMoveClass } from "./schema";

export const PROMPT_VERSION: string = template.version;

export interface BuiltPrompt {
  system: string;
  user: string;
  promptVersion: string;
}

export type PromptResult =
  | { ok: true; prompt: BuiltPrompt }
  | { ok: false; error: string };

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`missing template variable: ${name}`);
    return v;
  });
}

/**
 * Replay a PV from `fen`, returning the SAN move list ("1. e4 e5 2. Nf3 ...").
 * Returns null if any move is illegal — the legality check for client input.
 */
export function pvToSan(fen: string, pv: string[]): string | null {
  let board: Chess;
  try {
    board = new Chess(fen);
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const uci of pv) {
    const moveNo = board.moveNumber();
    const isWhite = board.turn() === "w";
    let san: string;
    try {
      san = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      }).san;
    } catch {
      return null;
    }
    if (isWhite) parts.push(`${moveNo}. ${san}`);
    else if (parts.length === 0) parts.push(`${moveNo}... ${san}`);
    else parts.push(san);
  }
  return parts.join(" ");
}

/**
 * Human phrase for a line's eval, White-centric. UCI cp/mate are from the
 * side to move, so negate when Black is to move.
 */
export function evalPhrase(line: WireLine, sideToMove: "w" | "b"): string {
  const sign = sideToMove === "w" ? 1 : -1;
  if (line.mate !== undefined) {
    const m = line.mate * sign;
    return m > 0 ? `White mates in ${Math.abs(m)}` : `Black mates in ${Math.abs(m)}`;
  }
  const cp = (line.cp ?? 0) * sign;
  const pawns = cp / 100;
  const abs = Math.abs(pawns);
  const who = pawns >= 0 ? "White" : "Black";
  if (abs < 0.3) return "roughly equal";
  if (abs < 0.9) return `slightly better for ${who} (${pawns > 0 ? "+" : ""}${pawns.toFixed(1)})`;
  if (abs < 2.0) return `clearly better for ${who} (${pawns > 0 ? "+" : ""}${pawns.toFixed(1)})`;
  return `winning for ${who} (${pawns > 0 ? "+" : ""}${pawns.toFixed(1)})`;
}

const CLASS_PHRASES: Record<WireMoveClass, string> = {
  best: "the best move",
  good: "a good move",
  inaccuracy: "an inaccuracy",
  mistake: "a mistake",
  blunder: "a blunder",
};

function sideToMoveOf(fen: string): "w" | "b" | null {
  const field = fen.split(" ")[1];
  return field === "w" || field === "b" ? field : null;
}

export function buildPrompt(req: ExplainRequest): PromptResult {
  const stm = sideToMoveOf(req.fen);
  if (!stm) return { ok: false, error: "invalid FEN" };
  const sideName = stm === "w" ? "White" : "Black";
  // Reserved for Phase 4 RAG snippets; empty keeps template spacing stable.
  const retrieval = "";

  if (req.mode === "candidates") {
    const rows: string[] = [];
    let maxDepth = 0;
    for (const line of req.lines) {
      const san = pvToSan(req.fen, line.pv);
      if (!san) return { ok: false, error: "illegal move in engine line" };
      maxDepth = Math.max(maxDepth, line.depth);
      rows.push(`${line.multipv}. ${san} — ${evalPhrase(line, stm)}`);
    }
    const user = fill(template.user.candidates, {
      fen: req.fen,
      side_to_move: sideName,
      depth: String(maxDepth),
      candidates: rows.join("\n"),
      retrieval,
    });
    return {
      ok: true,
      prompt: { system: template.system, user, promptVersion: PROMPT_VERSION },
    };
  }

  const playedSan = pvToSan(req.fen, req.playedLine.pv);
  const bestSan = pvToSan(req.fen, req.bestLine.pv);
  if (!playedSan || !bestSan) {
    return { ok: false, error: "illegal move in engine line" };
  }
  const playedMoveSan = pvToSan(req.fen, [req.verdict.moveUci]);
  if (!playedMoveSan) return { ok: false, error: "illegal played move" };

  const user = fill(template.user.grade, {
    fen: req.fen,
    side_to_move: sideName,
    played_move: playedMoveSan,
    move_class_phrase: CLASS_PHRASES[req.verdict.moveClass],
    win_before: req.verdict.winPctBefore.toFixed(0),
    win_after: req.verdict.winPctAfter.toFixed(0),
    played_line: `${playedSan} — ${evalPhrase(req.playedLine, stm)}`,
    best_line: `${bestSan} — ${evalPhrase(req.bestLine, stm)}`,
    retrieval,
  });
  return {
    ok: true,
    prompt: { system: template.system, user, promptVersion: PROMPT_VERSION },
  };
}
