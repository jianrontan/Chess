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
import { getTurnstileToken } from "@/lib/turnstile";
// Type-only import of the Worker's wire schema: the compiler now enforces
// the request contract at the producer, so a renamed/added field on either
// side fails `tsc` instead of surfacing as a runtime 400.
import type {
  CandidatesRequest,
  ExplainRequest,
  GradeRequest,
  WireLine,
} from "../../worker/lib/schema";

export type { ExplainRequest };

export interface ExplainState {
  text: string;
  streaming: boolean;
  error: string;
}

function wireLine(l: EngineLine): WireLine {
  return { multipv: l.multipv, depth: l.depth, cp: l.cp, mate: l.mate, pv: l.pv };
}

export function candidatesRequestBody(
  fen: string,
  lines: EngineLine[],
): CandidatesRequest {
  return { mode: "candidates", fen, lines: lines.map(wireLine) };
}

export function gradeRequestBody(preFen: string, v: MoveVerdict): GradeRequest {
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

/** POST with a fresh single-use Turnstile token attached. */
export async function postWithTurnstile(url: string, body: string): Promise<Response> {
  const token = await getTurnstileToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-turnstile-token"] = token;
  return fetch(url, { method: "POST", headers, body });
}

/** Pull the Worker's JSON `{error}` message out of a non-2xx response. */
export async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const err: unknown = await res.json();
    if (
      typeof err === "object" &&
      err !== null &&
      "error" in err &&
      typeof err.error === "string"
    ) {
      return err.error;
    }
  } catch {
    // fall through
  }
  return fallback;
}

/**
 * POST to /api/explain and yield text chunks as they stream in.
 * Throws on a non-2xx response (the Worker returns JSON errors before it
 * starts streaming). Cancels the underlying stream if the consumer stops.
 */
export async function* streamExplanation(body: ExplainRequest): AsyncGenerator<string> {
  const res = await postWithTurnstile("/api/explain", JSON.stringify(body));
  if (!res.ok) throw new Error(await extractError(res, `explain failed (${res.status})`));
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
