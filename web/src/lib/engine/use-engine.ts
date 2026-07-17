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
  /**
   * The position the lines belong to. Consumers MUST check this before
   * using lines as a baseline — for ~debounce duration after a move,
   * lines still describe the previous position.
   */
  fen: string;
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
  /** True while one of THIS hook's analysis searches is actually running —
   * stop() must not truncate a Mode 2 grading search (cross-depth skew). */
  const analysisRunningRef = useRef(false);
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
    fen: "",
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
      // Shorten only OUR running analysis. A grading search must never be
      // stopped early — its depth must match its baseline (review finding).
      if (analysisRunningRef.current) client.stop();
      setAnalysis({ lines: [], depth: 0, analyzing: true, fen });
      client
        .analyze(fen, {
          multipv,
          movetimeMs,
          // Stale searches skip at dequeue instead of burning full movetime.
          isCancelled: () => generationRef.current !== generation,
          onStart: () => {
            analysisRunningRef.current = true;
          },
          onLines: (lines) => {
            if (generationRef.current !== generation) return;
            const depth = lines[0]?.depth ?? 0;
            // Publish only when the search deepens. Stockfish emits many info
            // lines per second; pushing each one through setState re-renders
            // the whole page and makes the board flicker mid-animation.
            setAnalysis((prev) =>
              depth > prev.depth ? { lines, depth, analyzing: true, fen } : prev,
            );
          },
        })
        .then((result) => {
          analysisRunningRef.current = false;
          if (generationRef.current !== generation) return;
          setAnalysis({
            lines: result.lines,
            depth: result.depth,
            analyzing: false,
            fen,
          });
        })
        .catch((e: unknown) => {
          analysisRunningRef.current = false;
          // Cancelled/stale/disposed: nothing to show. A genuine failure on
          // the CURRENT position must not leave the panel stuck "Analyzing…".
          if (generationRef.current !== generation) return;
          const msg = e instanceof Error ? e.message : "";
          if (msg === "cancelled" || msg === "engine disposed") return;
          setAnalysis((a) => ({ ...a, analyzing: false }));
          setEngine((prev) =>
            prev.status === "ready" ? { ...prev, status: "error", error: msg } : prev,
          );
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [fen, engine.status, multipv, movetimeMs]);

  /**
   * Grade a move played from `preFen` (Mode 2). Reuses the pre-move
   * analysis when the move was among the top-k lines (instant); otherwise
   * runs a searchmoves query to the SAME DEPTH the baseline reached —
   * matching depth, not configured movetime, because the user usually
   * moves before the analysis finishes (see ARCHITECTURE.md "Step 2b").
   */
  const gradeMove = useCallback(
    async (
      preFen: string,
      moveUci: string,
      preLines: EngineLine[],
    ): Promise<MoveVerdict | null> => {
      const client = clientRef.current;
      const bestLine = preLines[0];
      if (!client || !bestLine) return null; // no baseline — caller shows "not graded"
      const mover: "w" | "b" = preFen.split(" ")[1] === "b" ? "b" : "w";

      const known = preLines.find((l) => l.pv[0] === moveUci);
      if (known) return gradePlayedMove(bestLine, known, mover);

      try {
        const result = await client.gradeMove(preFen, moveUci, {
          depth: bestLine.depth,
        });
        const playedLine = result.lines[0];
        if (!playedLine) return null; // terminal position or illegal restriction
        return gradePlayedMove(bestLine, playedLine, mover);
      } catch {
        return null; // disposed mid-search
      }
    },
    [],
  );

  return { engine, analysis, gradeMove };
}
