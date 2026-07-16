"use client";

import { useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard, type PieceDropHandlerArgs } from "react-chessboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AnalysisPanel } from "@/components/analysis-panel";
import { BoardEditor } from "@/components/board-editor";
import { ExplanationCard } from "@/components/explanation-card";
import { MoveVerdictCard } from "@/components/move-verdict";
import type { MoveVerdict } from "@/lib/engine/grading";
import { useEngineAnalysis } from "@/lib/engine/use-engine";
import {
  candidatesRequestBody,
  gradeRequestBody,
  streamExplanation,
  type ExplainState,
} from "@/lib/explain";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function gameOverText(game: Chess): string | undefined {
  if (game.isCheckmate()) {
    return `Checkmate — ${game.turn() === "w" ? "Black" : "White"} wins.`;
  }
  if (game.isStalemate()) return "Stalemate.";
  if (game.isInsufficientMaterial()) return "Draw — insufficient material.";
  if (game.isThreefoldRepetition()) return "Draw — threefold repetition.";
  if (game.isDraw()) return "Draw.";
  return undefined;
}

export default function Home() {
  // chess.js owns the rules; the FEN state drives board + analysis.
  const gameRef = useRef(new Chess(START_FEN));
  const [fen, setFen] = useState(START_FEN);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [fenInput, setFenInput] = useState("");
  const [fenError, setFenError] = useState("");
  const [verdict, setVerdict] = useState<MoveVerdict | null>(null);
  const [gradePending, setGradePending] = useState(false);
  const [gradeSkipped, setGradeSkipped] = useState(false);
  const [editing, setEditing] = useState(false);
  const gradeIdRef = useRef(0);
  // Position the last verdict was graded from — the grade explanation
  // must be requested against THAT fen, not the current one.
  const [gradedFen, setGradedFen] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<ExplainState | null>(null);
  const explainIdRef = useRef(0);

  const { engine, analysis, gradeMove } = useEngineAnalysis(fen, {
    multipv: 3,
    movetimeMs: 5000,
  });

  const sideToMove = useMemo(() => (fen.split(" ")[1] === "b" ? "b" : "w"), [fen]);
  // Derived from FEN alone (render must not read the ref). Note: threefold
  // repetition needs move history, so it isn't detected here — fine for now.
  const overText = useMemo(() => gameOverText(new Chess(fen)), [fen]);

  function onPieceDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean {
    if (!targetSquare) return false;
    // Snapshot BEFORE the move: grading compares against this position.
    // analysis.lines may still describe the PREVIOUS position (debounce
    // window) — only use them if they are tagged with this exact FEN.
    const preFen = gameRef.current.fen();
    const preLines = analysis.fen === preFen ? analysis.lines : [];
    try {
      // TODO(ui): promotion picker; auto-queen for now.
      const move = gameRef.current.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });
      setFen(gameRef.current.fen());
      setFenError("");

      // Mode 2: grade the played move (instant if it was in the top k).
      const moveUci = move.from + move.to + (move.promotion ?? "");
      const gradeId = ++gradeIdRef.current;
      setVerdict(null);
      setGradeSkipped(false);
      setGradePending(true);
      gradeMove(preFen, moveUci, preLines).then((v) => {
        if (gradeIdRef.current !== gradeId) return; // a newer move superseded us
        setVerdict(v);
        setGradedFen(v ? preFen : null);
        setGradeSkipped(v === null); // no baseline — say so instead of vanishing
        setGradePending(false);
      });
      clearExplanation();
      return true;
    } catch {
      return false; // illegal — board reverts
    }
  }

  function clearExplanation() {
    explainIdRef.current++; // a stale in-flight stream stops writing state
    setExplanation(null);
  }

  function clearVerdict() {
    gradeIdRef.current++;
    setVerdict(null);
    setGradedFen(null);
    setGradeSkipped(false);
    setGradePending(false);
    clearExplanation();
  }

  async function runExplain(body: unknown) {
    const id = ++explainIdRef.current;
    setExplanation({ text: "", streaming: true, error: "" });
    try {
      let text = "";
      for await (const chunk of streamExplanation(body)) {
        if (explainIdRef.current !== id) return; // superseded — stop consuming
        text += chunk;
        setExplanation({ text, streaming: true, error: "" });
      }
      if (explainIdRef.current === id) {
        setExplanation({ text, streaming: false, error: "" });
      }
    } catch (e: unknown) {
      if (explainIdRef.current === id) {
        setExplanation({
          text: "",
          streaming: false,
          error: e instanceof Error ? e.message : "request failed",
        });
      }
    }
  }

  function loadFen() {
    const candidate = fenInput.trim();
    if (!candidate) return;
    try {
      gameRef.current = new Chess(candidate);
      setFen(gameRef.current.fen());
      setFenInput("");
      setFenError("");
      clearVerdict();
    } catch (e: unknown) {
      setFenError(e instanceof Error ? e.message : "Invalid FEN");
    }
  }

  function reset() {
    gameRef.current = new Chess(START_FEN);
    setFen(START_FEN);
    setFenError("");
    clearVerdict();
  }

  function undo() {
    gameRef.current.undo();
    setFen(gameRef.current.fen());
    clearVerdict();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Chess Explanation Engine</h1>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,480px)_1fr]">
        <div className="flex flex-col gap-4">
          {editing ? (
            <BoardEditor
              initialFen={fen}
              onApply={(newFen) => {
                gameRef.current = new Chess(newFen);
                setFen(newFen);
                setFenError("");
                clearVerdict();
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <Chessboard
                options={{
                  position: fen,
                  onPieceDrop,
                  boardOrientation: orientation,
                  id: "main-board",
                }}
              />

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={reset}>
                  Reset
                </Button>
                <Button variant="outline" size="sm" onClick={undo}>
                  Undo
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
                >
                  Flip
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit board
                </Button>
                <span className="ml-auto self-center text-sm text-muted-foreground">
                  {overText ?? `${sideToMove === "w" ? "White" : "Black"} to move`}
                </span>
              </div>

              <div className="flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-md border bg-transparent px-3 py-1.5 font-mono text-xs"
                  placeholder="Paste a FEN…"
                  value={fenInput}
                  onChange={(e) => setFenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") loadFen();
                  }}
                />
                <Button size="sm" onClick={loadFen}>
                  Load
                </Button>
              </div>
              {fenError && <p className="text-xs text-red-600">{fenError}</p>}
            </>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <MoveVerdictCard
            verdict={verdict}
            pending={gradePending}
            skipped={gradeSkipped}
            onExplain={
              verdict && gradedFen
                ? () => runExplain(gradeRequestBody(gradedFen, verdict))
                : undefined
            }
          />
          <AnalysisPanel
            lines={analysis.lines}
            sideToMove={sideToMove}
            analyzing={analysis.analyzing}
            depth={analysis.depth}
            gameOverText={overText}
          />
          <div>
            <Button
              variant="outline"
              size="sm"
              // Lines must describe the CURRENT position (analysis.fen tag).
              disabled={analysis.fen !== fen || analysis.lines.length === 0}
              onClick={() => runExplain(candidatesRequestBody(fen, analysis.lines))}
            >
              Explain position
            </Button>
          </div>
          <ExplanationCard state={explanation} />

          <Card>
            <CardContent className="pt-4 text-xs text-muted-foreground">
              {engine.status === "loading" && "Engine loading…"}
              {engine.status === "error" && `Engine error: ${engine.error}`}
              {engine.status === "ready" && engine.info && (
                <>
                  {engine.info.variant} · {engine.info.threads} thread
                  {engine.info.threads === 1 ? "" : "s"} ·{" "}
                  {engine.isolated ? "cross-origin isolated" : "NOT isolated (fallback)"}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
