"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { fileToDataUrl, scanImage } from "@/lib/scan";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Chessboard isn't memoized internally: unrelated page re-renders (each
// streamed explanation chunk, engine status updates) would re-run it and can
// tear the board mid-animation. With memo + the stable boardOptions object,
// the board only re-renders when the position/orientation actually changes.
const MemoChessboard = memo(Chessboard);

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
  // Image-to-FEN: the scanned position opens in the editor for the user to
  // confirm/fix (side to move + castling can't come from a photo).
  const [scanPreview, setScanPreview] = useState<string | null>(null);
  const [scannedFen, setScannedFen] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const { overText, inCheck } = useMemo(() => {
    const game = new Chess(fen);
    return { overText: gameOverText(game), inCheck: game.inCheck() };
  }, [fen]);

  // Latest analysis for event handlers, WITHOUT making the handlers (and
  // therefore the board options) change identity on every engine update —
  // unstable options force react-chessboard to reprocess mid-animation
  // (the flicker/board-gap bug).
  const analysisRef = useRef(analysis);
  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  const clearExplanation = useCallback(() => {
    explainIdRef.current++; // a stale in-flight stream stops writing state
    setExplanation(null);
  }, []);

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!targetSquare) return false;
      // Snapshot BEFORE the move: grading compares against this position.
      // analysis.lines may still describe the PREVIOUS position (debounce
      // window) — only use them if they are tagged with this exact FEN.
      const preFen = gameRef.current.fen();
      const latest = analysisRef.current;
      const preLines = latest.fen === preFen ? latest.lines : [];
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
    },
    [gradeMove, clearExplanation],
  );

  // Stable unless the position/orientation actually changes — engine updates
  // must not re-render the board.
  const boardOptions = useMemo(
    () => ({
      position: fen,
      onPieceDrop,
      boardOrientation: orientation,
      id: "main-board",
    }),
    [fen, orientation, onPieceDrop],
  );

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

  async function onScanFile(file: File) {
    setScanBusy(true);
    setScanError("");
    try {
      const dataUrl = await fileToDataUrl(file);
      const result = await scanImage(dataUrl);
      setScanPreview(dataUrl);
      setScannedFen(result.fen);
      setEditing(true);
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : "scan failed");
    } finally {
      setScanBusy(false);
    }
  }

  function closeEditor() {
    setEditing(false);
    setScanPreview(null);
    setScannedFen(null);
  }

  function undo() {
    gameRef.current.undo();
    setFen(gameRef.current.fen());
    clearVerdict();
  }

  return (
    // w-full is load-bearing: body is a flex container, and mx-auto on a
    // flex item defeats the default width stretch — without w-full, main
    // shrink-wraps its CONTENT and re-centers every time the analysis or
    // explanation text changes length (measured: the whole page slid ~75px
    // during a piece drag).
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Chess Explanation Engine</h1>

      {/* The board column is FIXED width, and items-start stops the default
          grid stretch: without it the left column is stretched to the height
          of the (growing) right column, and react-chessboard's height:100%
          root distributes that surplus BETWEEN the ranks — the horizontal
          gaps that widened while explanations streamed in. */}
      <div className="grid gap-6 lg:grid-cols-[480px_minmax(0,1fr)] lg:items-start">
        <div className="flex w-full max-w-[480px] flex-col gap-4">
          {editing ? (
            <>
              {scanPreview && (
                <div className="space-y-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
                  <img
                    src={scanPreview}
                    alt="Uploaded board photo"
                    className="max-h-56 w-full rounded-md border object-contain"
                  />
                  <p className="text-xs text-muted-foreground">
                    Check the board against your photo — fix any squares, then
                    set who moves before applying.
                  </p>
                </div>
              )}
              <BoardEditor
                initialFen={scannedFen ?? fen}
                onApply={(newFen) => {
                  gameRef.current = new Chess(newFen);
                  setFen(newFen);
                  setFenError("");
                  clearVerdict();
                  closeEditor();
                }}
                onCancel={closeEditor}
              />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full border-2 ${
                    sideToMove === "w"
                      ? "border-neutral-400 bg-white"
                      : "border-neutral-900 bg-neutral-900"
                  }`}
                  aria-hidden
                />
                {overText ?? (
                  <>
                    {sideToMove === "w" ? "White" : "Black"} to move
                    {inCheck && <span className="font-semibold text-red-600">— check!</span>}
                  </>
                )}
              </div>

              {/* aspect-square guard: the board root fills its parent 100%,
                  so its parent must always be exactly square. */}
              <div className="aspect-square w-full">
                <MemoChessboard options={boardOptions} />
              </div>

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
                <Button
                  variant="outline"
                  size="sm"
                  disabled={scanBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {scanBusy ? "Scanning…" : "Scan image"}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ""; // same file can be re-picked
                    if (file) void onScanFile(file);
                  }}
                />
              </div>
              {scanError && <p className="text-xs text-red-600">{scanError}</p>}

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

        <div className="flex min-w-0 flex-col gap-4">
          <MoveVerdictCard
            verdict={verdict}
            pending={gradePending}
            skipped={gradeSkipped}
            explaining={explanation?.streaming === true}
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
            action={
              <Button
                variant="outline"
                size="sm"
                // Lines must describe the CURRENT position (analysis.fen tag),
                // and one explanation streams at a time (each request costs).
                disabled={
                  analysis.fen !== fen ||
                  analysis.lines.length === 0 ||
                  explanation?.streaming === true
                }
                onClick={() => runExplain(candidatesRequestBody(fen, analysis.lines))}
              >
                {explanation?.streaming ? "Explaining…" : "Explain position"}
              </Button>
            }
          />
          <ExplanationCard state={explanation} />

          <Card>
            <CardContent className="text-xs text-muted-foreground">
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
