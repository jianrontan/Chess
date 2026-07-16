/**
 * Client for /api/explain. Builds request bodies from engine state and
 * streams the plain-text response chunk by chunk.
 *
 * The Worker treats everything here as client-reported: it re-validates,
 * replays moves for legality, and clamps evals. Keep bodies minimal — only
 * what the prompt needs.
 */

import type { MoveVerdict } from "@/lib/engine/grading";
import type { EngineLine } from "@/lib/engine/types";

export interface ExplainState {
  text: string;
  streaming: boolean;
  error: string;
}

function wireLine(l: EngineLine) {
  return { multipv: l.multipv, depth: l.depth, cp: l.cp, mate: l.mate, pv: l.pv };
}

export function candidatesRequestBody(fen: string, lines: EngineLine[]): unknown {
  return { mode: "candidates", fen, lines: lines.map(wireLine) };
}

export function gradeRequestBody(preFen: string, v: MoveVerdict): unknown {
  return {
    mode: "grade",
    fen: preFen,
    verdict: {
      moveUci: v.playedLine.pv[0],
      moveClass: v.moveClass,
      winPctBefore: v.winPctBefore,
      winPctAfter: v.winPctAfter,
    },
    playedLine: wireLine(v.playedLine),
    bestLine: wireLine(v.bestLine),
  };
}

/**
 * POST to /api/explain and yield text chunks as they stream in.
 * Throws on a non-2xx response (the Worker returns JSON errors before it
 * starts streaming). Cancels the underlying stream if the consumer stops.
 */
export async function* streamExplanation(body: unknown): AsyncGenerator<string> {
  const res = await fetch("/api/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `explain failed (${res.status})`;
    try {
      const err: unknown = await res.json();
      if (
        typeof err === "object" &&
        err !== null &&
        "error" in err &&
        typeof err.error === "string"
      ) {
        message = err.error;
      }
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error("empty response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
