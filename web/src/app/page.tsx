"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { Chessboard, type Arrow, type PieceDropHandlerArgs } from "react-chessboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AnalysisPanel } from "@/components/analysis-panel";
import { BoardEditor } from "@/components/board-editor";
import { EvalBar } from "@/components/eval-bar";
import { ExplanationCard } from "@/components/explanation-card";
import { MoveVerdictCard } from "@/components/move-verdict";
import { lineWinPct, type MoveVerdict } from "@/lib/engine/grading";
import { whiteScore } from "@/lib/engine/format";
import { useEngineAnalysis } from "@/lib/engine/use-engine";
import {
  candidatesRequestBody,
  gradeRequestBody,
  streamExplanation,
  type ExplainRequest,
  type ExplainState,
} from "@/lib/explain";
import { materialError } from "@/lib/editor";
import { flipSideToMove } from "@/lib/engine/fen";
import { fileToDataUrl, scanImage } from "@/lib/scan";
import { scanRegion, type BoardRegion } from "@/lib/scan-local";
import { ScanCrop } from "@/components/scan-crop";
import { supportsCredentialless } from "@/lib/turnstile";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Board position stashed across the /turnstile detour (full page nav). */
const PENDING_FEN_KEY = "chess:pending-fen";

type PromotionPiece = "q" | "r" | "b" | "n";

const PROMO_GLYPHS: Record<"w" | "b", Record<PromotionPiece, string>> = {
  w: { q: "♕", r: "♖", b: "♗", n: "♘" },
  b: { q: "♛", r: "♜", b: "♝", n: "♞" },
};

/** Verdict-arrow colors keyed by move class (played move); best move is green. */
const ARROW_CLASS_COLOR: Record<MoveVerdict["moveClass"], string> = {
  best: "#16a34a",
  good: "#10b981",
  inaccuracy: "#eab308",
  mistake: "#f97316",
  blunder: "#dc2626",
};

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
  // Crop step for the CLIENT-SIDE scan (vision model): the uploaded image
  // element + its data URL, shown with a draggable square selector.
  const [cropImage, setCropImage] = useState<{
    url: string;
    el: HTMLImageElement;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gradeIdRef = useRef(0);
  // A cancelled crop-scan must not apply its late result (the model download
  // can take a while on first scan — Cancel stays clickable throughout).
  const scanIdRef = useRef(0);
  // Undo is only meaningful while chess.js holds move history; FEN loads,
  // scans, and editor applies start a fresh game with none.
  const [moveCount, setMoveCount] = useState(0);
  const [showArrows, setShowArrows] = useState(true);
  // A pawn reached the last rank: the move is parked until the user picks
  // the piece. Auto-queening silently substituted the move being graded —
  // and made underpromotion (a real puzzle theme) unplayable.
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: string;
    to: string;
  } | null>(null);
  // Position the last verdict was graded from — the grade explanation
  // must be requested against THAT fen, not the current one.
  const [gradedFen, setGradedFen] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<ExplainState | null>(null);
  const explainIdRef = useRef(0);

  const { engine, analysis, gradeMove, analyzeFen } = useEngineAnalysis(fen, {
    multipv: 3,
    movetimeMs: 5000,
  });
  // "Explain for <other side>": engine must first analyze the flipped-side
  // position, so this has its own busy state.
  const [otherSideBusy, setOtherSideBusy] = useState(false);
  // Non-Chromium browsers can't run the invisible per-request Turnstile;
  // they need a one-time top-level verification (/turnstile detour) which
  // sets a clearance cookie. Show the prompt only when actually needed.
  const [needsVerify, setNeedsVerify] = useState(false);
  useEffect(() => {
    if (supportsCredentialless()) return;
    fetch("/api/verify")
      .then((r) => (r.ok ? r.json() : { cleared: true }))
      .then((d: { cleared?: boolean }) => setNeedsVerify(d.cleared === false))
      .catch(() => {}); // offline/dev without worker — no banner
  }, []);

  // Restore the position stashed before a /turnstile detour — the detour is
  // a full page navigation, and losing the user's setup made "Verify now"
  // punitive for exactly the browsers that need it. Async on purpose: the
  // restore must run AFTER hydration (sessionStorage is client-only), and
  // the lint bars synchronous setState in effect bodies.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const saved = sessionStorage.getItem(PENDING_FEN_KEY);
        if (!saved) return;
        sessionStorage.removeItem(PENDING_FEN_KEY);
        const game = new Chess(saved);
        if (materialError(game)) return;
        gameRef.current = game;
        setFen(game.fen());
      } catch {
        // unreadable stash (private mode, corrupted value) — start fresh
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sideToMove = useMemo(() => (fen.split(" ")[1] === "b" ? "b" : "w"), [fen]);
  // Derived from FEN alone (render must not read the ref). Note: threefold
  // repetition needs move history, so it isn't detected here — fine for now.
  const { overText, inCheck } = useMemo(() => {
    const game = new Chess(fen);
    return { overText: gameOverText(game), inCheck: game.inCheck() };
  }, [fen]);

  // Eval bar: White's win% from the freshest line of the CURRENT position
  // (stale lines are sign-hazardous — same guard as the panel). Null while
  // searching keeps the bar at its last value instead of snapping to 50.
  const analysisFresh = analysis.fen === fen;
  const topLine = analysisFresh ? analysis.lines[0] : undefined;
  const evalWinPct = useMemo(() => {
    if (!topLine) return null;
    const pct = lineWinPct(topLine); // side-to-move perspective
    return sideToMove === "w" ? pct : 100 - pct;
  }, [topLine, sideToMove]);
  const evalScoreText = topLine ? whiteScore(topLine, sideToMove) : "";

  // Verdict arrows: played move colored by its class, best move in green.
  // Hidden while a newer grade is pending (the verdict describes the
  // previous move) and toggleable — some users find arrows noisy.
  const verdictArrows = useMemo<Arrow[]>(() => {
    if (!verdict || !showArrows || gradePending) return [];
    const played = verdict.playedLine.pv[0];
    const arrows: Arrow[] = [
      {
        startSquare: played.slice(0, 2),
        endSquare: played.slice(2, 4),
        color: ARROW_CLASS_COLOR[verdict.moveClass],
      },
    ];
    const best = verdict.bestLine.pv[0];
    if (best !== played) {
      arrows.push({
        startSquare: best.slice(0, 2),
        endSquare: best.slice(2, 4),
        color: ARROW_CLASS_COLOR.best,
      });
    }
    return arrows;
  }, [verdict, showArrows, gradePending]);

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

  const playMove = useCallback(
    (from: string, to: string, promotion?: PromotionPiece): boolean => {
      // Snapshot BEFORE the move: grading compares against this position.
      // analysis.lines may still describe the PREVIOUS position (debounce
      // window) — only use them if they are tagged with this exact FEN.
      const preFen = gameRef.current.fen();
      const latest = analysisRef.current;
      const preLines = latest.fen === preFen ? latest.lines : [];
      try {
        const move = gameRef.current.move({ from, to, promotion });
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
        setMoveCount((c) => c + 1);
        clearExplanation();
        return true;
      } catch {
        return false; // illegal — board reverts
      }
    },
    [gradeMove, clearExplanation],
  );

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!targetSquare) return false;
      // A promotion parks the move behind the piece picker instead of
      // auto-queening (which silently substituted the graded move).
      const isPromotion = gameRef.current
        .moves({ square: sourceSquare as Square, verbose: true })
        .some((m) => m.to === targetSquare && m.promotion !== undefined);
      if (isPromotion) {
        setPendingPromotion({ from: sourceSquare, to: targetSquare });
        return false; // pawn snaps back; the move lands when a piece is picked
      }
      return playMove(sourceSquare, targetSquare);
    },
    [playMove],
  );

  // Stable unless the position/orientation actually changes — engine updates
  // must not re-render the board.
  const boardOptions = useMemo(
    () => ({
      position: fen,
      onPieceDrop,
      boardOrientation: orientation,
      id: "main-board",
      arrows: verdictArrows,
    }),
    [fen, orientation, onPieceDrop, verdictArrows],
  );

  function clearVerdict() {
    gradeIdRef.current++;
    setVerdict(null);
    setGradedFen(null);
    setGradeSkipped(false);
    setGradePending(false);
    setPendingPromotion(null); // a parked promotion belongs to the old position
    clearExplanation();
  }

  async function runExplain(body: ExplainRequest) {
    const id = ++explainIdRef.current;
    setExplanation({ text: "", streaming: true, error: "" });
    // Outside the try: a mid-stream failure keeps the prose that already
    // arrived instead of wiping what the user was reading.
    let text = "";
    try {
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
          text,
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
      const game = new Chess(candidate);
      // chess.js checks structure/kings/back-rank pawns but not material —
      // the paste box must enforce the same rules as the editor (a pasted
      // 9-pawn or 8-queen FEN otherwise goes straight to the engine).
      const material = materialError(game);
      if (material) {
        setFenError(material);
        return;
      }
      gameRef.current = game;
      setFen(gameRef.current.fen());
      setFenInput("");
      setFenError("");
      setMoveCount(0);
      clearVerdict();
    } catch (e: unknown) {
      setFenError(e instanceof Error ? e.message : "Invalid FEN");
    }
  }

  function reset() {
    // An explanation is the one artifact that took real waiting to produce —
    // don't let a stray Reset click destroy it silently.
    if (
      explanation?.text &&
      !window.confirm("Discard the current explanation and start over?")
    ) {
      return;
    }
    gameRef.current = new Chess(START_FEN);
    setFen(START_FEN);
    setFenError("");
    setMoveCount(0);
    clearVerdict();
  }

  // Explain what the OTHER side would play: analyze the same position with
  // the side to move flipped (real engine lines — grounding stays intact),
  // then request a normal candidates explanation for that position.
  async function runExplainOtherSide() {
    const flipped = flipSideToMove(fen);
    if (!flipped) return;
    const id = ++explainIdRef.current;
    setOtherSideBusy(true);
    setExplanation({ text: "", streaming: true, error: "" });
    try {
      const lines = await analyzeFen(flipped);
      if (explainIdRef.current !== id) return; // superseded (new move/position)
      if (lines.length === 0) {
        setExplanation({
          text: "",
          streaming: false,
          error: "couldn't analyze the position for the other side",
        });
        return;
      }
      await runExplain(candidatesRequestBody(flipped, lines));
    } catch {
      // analyzeFen/runExplain handle their own errors; this backstop keeps a
      // future throw from becoming an unhandled rejection.
      if (explainIdRef.current === id) {
        setExplanation({ text: "", streaming: false, error: "explanation failed" });
      }
    } finally {
      setOtherSideBusy(false);
    }
  }

  // Scan flow v2: load the image and open the CROP step — recognition then
  // runs client-side (vision model, see scan-local.ts). The image never
  // leaves the device.
  async function onScanFile(file: File) {
    setScanError("");
    try {
      const dataUrl = await fileToDataUrl(file);
      const el = new Image();
      el.src = dataUrl;
      await el.decode();
      setCropImage({ url: dataUrl, el });
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : "could not read that image");
    }
  }

  async function onCropConfirm(region: BoardRegion) {
    if (!cropImage) return;
    // Cancel (which stays clickable) bumps the id — a late result from an
    // abandoned scan must not reopen the editor under the user.
    const scanId = ++scanIdRef.current;
    setScanBusy(true);
    setScanError("");
    try {
      const result = await scanRegion(cropImage.el, region);
      if (scanIdRef.current !== scanId) return;
      setScanPreview(cropImage.url);
      setScannedFen(result.fen);
      setCropImage(null);
      setEditing(true);
    } catch {
      if (scanIdRef.current !== scanId) return;
      // Local model unavailable (old browser, blocked wasm, stalled model
      // download) — fall back to the server vision scan rather than
      // dead-ending the user.
      try {
        const result = await scanImage(cropImage.url);
        if (scanIdRef.current !== scanId) return;
        setScanPreview(cropImage.url);
        setScannedFen(result.fen);
        setCropImage(null);
        setEditing(true);
      } catch (e: unknown) {
        if (scanIdRef.current !== scanId) return;
        setScanError(e instanceof Error ? e.message : "scan failed");
      }
    } finally {
      if (scanIdRef.current === scanId) setScanBusy(false);
    }
  }

  function closeEditor() {
    setEditing(false);
    setScanPreview(null);
    setScannedFen(null);
  }

  function undo() {
    // No history (position came from a FEN load/scan/editor) — the old code
    // "undid" nothing but still wiped the verdict and explanation.
    if (gameRef.current.undo() === null) return;
    setFen(gameRef.current.fen());
    setMoveCount((c) => Math.max(0, c - 1));
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

      {needsVerify && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              Your browser needs a quick one-time verification before
              explanations and scans will work.
            </span>
            <Button
              size="sm"
              onClick={() => {
                // Full-page detour: stash the board so the user's setup
                // survives the round-trip (restored by the mount effect).
                try {
                  sessionStorage.setItem(PENDING_FEN_KEY, fen);
                } catch {
                  // storage unavailable — the detour still works, minus restore
                }
                window.location.assign("/turnstile");
              }}
            >
              Verify now
            </Button>
          </CardContent>
        </Card>
      )}

      {/* The board column is FIXED width, and items-start stops the default
          grid stretch: without it the left column is stretched to the height
          of the (growing) right column, and react-chessboard's height:100%
          root distributes that surplus BETWEEN the ranks — the horizontal
          gaps that widened while explanations streamed in. */}
      {/* minmax(0,1fr) on the MOBILE track too: an implicit auto track is
          content-sized, so any fixed-width child (the crop image) widened
          its own container and escaped the viewport (measured 106px). */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[480px_minmax(0,1fr)] lg:items-start">
        <div className="flex w-full max-w-[480px] flex-col gap-4">
          {cropImage ? (
            <ScanCrop
              imageUrl={cropImage.url}
              imageW={cropImage.el.naturalWidth}
              imageH={cropImage.el.naturalHeight}
              busy={scanBusy}
              error={scanError}
              onConfirm={(region) => void onCropConfirm(region)}
              onCancel={() => {
                scanIdRef.current++; // abandon any in-flight scan result
                setCropImage(null);
                setScanError("");
                setScanBusy(false);
              }}
            />
          ) : editing ? (
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
                    Check the board against your screenshot — if it reads
                    upside-down, hit &quot;Rotate 180°&quot;; fix any squares,
                    then set who moves before applying.
                  </p>
                </div>
              )}
              <BoardEditor
                // Remount when a scan arrives: initialFen is only read at
                // mount, so a scan completing while the editor is already
                // open would otherwise be silently discarded.
                key={scannedFen ?? "manual"}
                initialFen={scannedFen ?? fen}
                // A screenshot can't say whose turn it is: force the choice.
                requireSideChoice={scannedFen !== null}
                onApply={(newFen) => {
                  gameRef.current = new Chess(newFen);
                  setFen(newFen);
                  setFenError("");
                  setMoveCount(0);
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
                {orientation === "black" && (
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    viewing as Black
                  </span>
                )}
              </div>

              {/* aspect-square guard: the board root fills its parent 100%,
                  so its parent must always be exactly square. The eval bar
                  stretches to the board's height beside it. */}
              <div className="flex w-full gap-2">
                <EvalBar winPct={evalWinPct} scoreText={evalScoreText} heightClass="self-stretch" />
                <div className="relative aspect-square min-w-0 flex-1">
                  <MemoChessboard options={boardOptions} />
                  {pendingPromotion && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-sm bg-black/40">
                      <div className="flex flex-col items-center gap-2 rounded-md border bg-background p-3 shadow-lg">
                        <span className="text-sm font-medium">Promote to</span>
                        <div className="flex gap-2">
                          {(["q", "r", "b", "n"] as const).map((p) => (
                            <Button
                              key={p}
                              variant="outline"
                              className="h-12 w-12 text-3xl"
                              aria-label={{ q: "Queen", r: "Rook", b: "Bishop", n: "Knight" }[p]}
                              onClick={() => {
                                const pp = pendingPromotion;
                                setPendingPromotion(null);
                                playMove(pp.from, pp.to, p);
                              }}
                            >
                              {PROMO_GLYPHS[sideToMove][p]}
                            </Button>
                          ))}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingPromotion(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={reset}>
                  Reset
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={undo}
                  disabled={moveCount === 0}
                  title={moveCount === 0 ? "No moves to undo" : undefined}
                >
                  Undo
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
                >
                  Flip
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={scanBusy}
                  onClick={() => setEditing(true)}
                >
                  Edit board
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Scan image
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

              {/* The grading mode is otherwise invisible until stumbled upon. */}
              <p className="text-xs text-muted-foreground">
                Play a move to have it graded, or use the Explain buttons for
                the engine&apos;s ideas.
              </p>

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
            fen={gradedFen}
            pending={gradePending}
            skipped={gradeSkipped}
            explaining={explanation?.streaming === true}
            onExplain={
              verdict && gradedFen
                ? () => runExplain(gradeRequestBody(gradedFen, verdict))
                : undefined
            }
            arrowsShown={showArrows}
            onToggleArrows={() => setShowArrows((v) => !v)}
          />
          <AnalysisPanel
            // Lines are tagged with the fen they belong to. For ~debounce
            // duration after a move they still describe the PREVIOUS
            // position — rendering them under the new side to move would
            // flip every eval sign, so show placeholders until fresh lines
            // arrive (same guard the Explain button already uses).
            lines={analysisFresh ? analysis.lines : []}
            fen={fen}
            sideToMove={sideToMove}
            analyzing={engine.status === "ready" && (analysis.analyzing || !analysisFresh)}
            engineReady={engine.status === "ready"}
            depth={analysisFresh ? analysis.depth : 0}
            gameOverText={overText}
            action={
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  // Lines must describe the CURRENT position (analysis.fen
                  // tag), and one explanation streams at a time (cost).
                  disabled={
                    analysis.fen !== fen ||
                    analysis.lines.length === 0 ||
                    explanation?.streaming === true
                  }
                  onClick={() => runExplain(candidatesRequestBody(fen, analysis.lines))}
                >
                  {explanation?.streaming && !otherSideBusy
                    ? "Explaining…"
                    : `Explain for ${sideToMove === "w" ? "White" : "Black"}`}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  // Needs a legal flipped position (not in check, not over).
                  disabled={
                    !!overText ||
                    inCheck ||
                    explanation?.streaming === true ||
                    engine.status !== "ready"
                  }
                  onClick={() => void runExplainOtherSide()}
                  title="Analyzes a hypothetical: the same position with the other side to move"
                >
                  {otherSideBusy
                    ? "Analyzing…"
                    : `If it were ${sideToMove === "w" ? "Black" : "White"}'s turn…`}
                </Button>
              </div>
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
