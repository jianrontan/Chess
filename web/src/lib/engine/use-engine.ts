"use client";

/**
 * React hook owning the engine lifecycle and position analysis.
 *
 * Analysis strategy: on every FEN change we debounce briefly, stop any
 * running search, and issue a new one. A generation counter discards stale
 * results (EngineClient serializes searches internally, but a queued result
 * can still arrive after the position moved on).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EngineClient } from "./client";
import { gradePlayedMove, type MoveVerdict } from "./grading";
import type { EngineInfo, EngineLine } from "./types";

const DEBOUNCE_MS = 250;

export interface EngineState {
  status: "loading" | "ready" | "error";
  error: string;
  info: EngineInfo | null;
  isolated: boolean | null;
}

export interface AnalysisState {
  lines: EngineLine[];
  /** Deepest depth reported for the current position so far. */
  depth: number;
  analyzing: boolean;
}

export function useEngineAnalysis(
  fen: string,
  opts: { multipv?: number; movetimeMs?: number } = {},
): {
  engine: EngineState;
  analysis: AnalysisState;
  gradeMove: (
    preFen: string,
    moveUci: string,
    preLines: EngineLine[],
  ) => Promise<MoveVerdict | null>;
} {
  const clientRef = useRef<EngineClient | null>(null);
  const generationRef = useRef(0);
  const [engine, setEngine] = useState<EngineState>({
    status: "loading",
    error: "",
    info: null,
    isolated: null,
  });
  const [analysis, setAnalysis] = useState<AnalysisState>({
    lines: [],
    depth: 0,
    analyzing: false,
  });

  const multipv = opts.multipv ?? 3;
  const movetimeMs = opts.movetimeMs ?? 5000;

  // Engine lifecycle (strict-mode safe: cancelled flag + immediate dispose).
  useEffect(() => {
    let cancelled = false;
    const client = new EngineClient();
    clientRef.current = client;
    client
      .init()
      .then(() => {
        if (cancelled) return;
        setEngine({
          status: "ready",
          error: "",
          info: client.info,
          isolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setEngine({
          status: "error",
          error: e instanceof Error ? e.message : String(e),
          info: null,
          isolated: null,
        });
      });
    return () => {
      cancelled = true;
      clientRef.current = null;
      client.dispose();
    };
  }, []);

  // Analyze on position change.
  useEffect(() => {
    if (engine.status !== "ready") return;
    const client = clientRef.current;
    if (!client) return;

    const generation = ++generationRef.current;
    const timer = setTimeout(() => {
      if (generationRef.current !== generation) return;
      client.stop(); // shorten any running search; queued call runs next
      setAnalysis({ lines: [], depth: 0, analyzing: true });
      client
        .analyze(fen, {
          multipv,
          movetimeMs,
          onLines: (lines) => {
            if (generationRef.current !== generation) return;
            setAnalysis({
              lines,
              depth: lines[0]?.depth ?? 0,
              analyzing: true,
            });
          },
        })
        .then((result) => {
          if (generationRef.current !== generation) return;
          setAnalysis({
            lines: result.lines,
            depth: result.depth,
            analyzing: false,
          });
        })
        .catch(() => {
          // Disposed mid-search or stale — nothing to show.
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [fen, engine.status, multipv, movetimeMs]);

  /**
   * Grade a move played from `preFen` (Mode 2). Reuses the pre-move
   * analysis when the move was among the top-k lines (instant); otherwise
   * runs a searchmoves query at the SAME movetime as the analysis run so
   * the delta is not cross-depth (see ARCHITECTURE.md "Step 2b").
   */
  const gradeMove = useCallback(
    async (
      preFen: string,
      moveUci: string,
      preLines: EngineLine[],
    ): Promise<MoveVerdict | null> => {
      const client = clientRef.current;
      const bestLine = preLines[0];
      if (!client || !bestLine) return null; // no baseline yet — skip grading

      const known = preLines.find((l) => l.pv[0] === moveUci);
      if (known) return gradePlayedMove(bestLine, known);

      try {
        const result = await client.gradeMove(preFen, moveUci, { movetimeMs });
        const playedLine = result.lines[0];
        if (!playedLine) return null; // terminal position or illegal restriction
        return gradePlayedMove(bestLine, playedLine);
      } catch {
        return null; // disposed mid-search
      }
    },
    [movetimeMs],
  );

  return { engine, analysis, gradeMove };
}
