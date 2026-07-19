"use client";

import { useRef, useState } from "react";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import {
  Chessboard,
  ChessboardProvider,
  SparePiece,
  defaultPieces,
  type PieceDropHandlerArgs,
} from "react-chessboard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  availableCastling,
  buildEditorFen,
  castlingFromFen,
  materialError,
  rotate180,
  type CastlingChoice,
} from "@/lib/editor";

const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const SPARE_TYPES = ["K", "Q", "R", "B", "N", "P"] as const;
const SQUARES: Square[] = [..."abcdefgh"].flatMap((f) =>
  [..."12345678"].map((r) => (f + r) as Square),
);

const CASTLING_LABELS: { key: keyof CastlingChoice; label: string }[] = [
  { key: "K", label: "White kingside" },
  { key: "Q", label: "White queenside" },
  { key: "k", label: "Black kingside" },
  { key: "q", label: "Black queenside" },
];

export function BoardEditor({
  initialFen,
  onApply,
  onCancel,
  requireSideChoice = false,
}: {
  initialFen: string;
  onApply: (fen: string) => void;
  onCancel: () => void;
  /** Scan mode: an image cannot say whose turn it is, so side-to-move starts
   * UNSET and Apply is blocked until the user states it — a silent
   * White default made the engine confidently analyze the wrong side. */
  requireSideChoice?: boolean;
}) {
  // skipValidation: mid-edit positions are allowed to be arbitrary.
  const placementRef = useRef(new Chess(initialFen, { skipValidation: true }));
  const [position, setPosition] = useState(() =>
    new Chess(initialFen, { skipValidation: true }).fen(),
  );
  const [side, setSide] = useState<"w" | "b" | null>(() => {
    if (requireSideChoice) return null;
    return initialFen.split(" ")[1] === "b" ? "b" : "w";
  });
  // The user's castling wishes; what's actually emitted is wishes ∩ available.
  // Scan mode: the image can't say castling rights either, so default to
  // "everything placement allows" (Lichess-editor convention) instead of the
  // scanned FEN's empty "-", which silently stripped rights on apply.
  const [castling, setCastling] = useState<CastlingChoice>(() =>
    requireSideChoice
      ? { K: true, Q: true, k: true, q: true }
      : castlingFromFen(initialFen),
  );
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [pgnOpen, setPgnOpen] = useState(false);
  const [pgnText, setPgnText] = useState("");
  const [error, setError] = useState("");

  // Derived from the position STATE (not the ref — refs are off-limits in
  // render); position is kept in sync with placementRef on every change.
  const available = availableCastling(new Chess(position, { skipValidation: true }));

  function onPieceDrop({ piece, sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean {
    const placement = placementRef.current;
    const color = piece.pieceType[0] as Color;
    const type = piece.pieceType[1].toLowerCase() as PieceSymbol;

    if (!targetSquare) {
      // Dragged off the board — remove.
      placement.remove(sourceSquare as Square);
      setPosition(placement.fen());
      setError("");
      return true;
    }

    // Trial mutation with rollback: impossible material (9th pawn, extra
    // queen with all pawns present) is refused AT DROP TIME, NCM-style,
    // not left to sit until apply.
    const before = placement.fen();
    if (!piece.isSparePiece) placement.remove(sourceSquare as Square);
    const ok = placement.put({ color, type }, targetSquare as Square);
    if (!ok) {
      placementRef.current = new Chess(before, { skipValidation: true });
      setError("Each side has exactly one king.");
      return false;
    }
    const material = materialError(placement);
    if (material) {
      placementRef.current = new Chess(before, { skipValidation: true });
      setError(material);
      return false;
    }
    setPosition(placement.fen());
    setError("");
    return true;
  }

  function setBoard(fen: string) {
    placementRef.current = new Chess(fen, { skipValidation: true });
    setPosition(placementRef.current.fen());
    setCastling(castlingFromFen(fen));
    const stm = fen.split(" ")[1];
    if (stm === "w" || stm === "b") setSide(stm);
    setError("");
  }

  /** Reinterpret orientation: pieces move to their mirrored squares. */
  function rotateBoard() {
    placementRef.current = rotate180(placementRef.current);
    setPosition(placementRef.current.fen());
    setError("");
  }

  /** NCM's "Capture all": every piece off the board except the two kings. */
  function captureAll() {
    const placement = placementRef.current;
    for (const sq of SQUARES) {
      const p = placement.get(sq);
      if (p && p.type !== "k") placement.remove(sq);
    }
    setPosition(placement.fen());
    setError("");
  }

  function loadPgn() {
    try {
      const game = new Chess();
      game.loadPgn(pgnText);
      setBoard(game.fen());
      setPgnOpen(false);
      setPgnText("");
    } catch (e: unknown) {
      setError(e instanceof Error ? `PGN: ${e.message}` : "Could not read that PGN");
    }
  }

  function apply() {
    if (side === null) {
      setError("Set who moves first — the screenshot can't tell us.");
      return;
    }
    const result = buildEditorFen(placementRef.current, side, castling);
    if (result.error || !result.fen) {
      setError(result.error ?? "Invalid position");
      return;
    }
    onApply(result.fen);
  }

  const spareRow = (color: "w" | "b") => (
    <div className="flex gap-1">
      {SPARE_TYPES.map((t) => (
        <div key={color + t} className="h-10 w-10">
          <SparePiece pieceType={`${color}${t}` as keyof typeof defaultPieces} />
        </div>
      ))}
    </div>
  );

  return (
    <ChessboardProvider
      options={{ position, onPieceDrop, boardOrientation: orientation, id: "editor-board" }}
    >
      <div className="flex flex-col gap-3">
        {spareRow(orientation === "white" ? "b" : "w")}
        <Chessboard />
        {spareRow(orientation === "white" ? "w" : "b")}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setBoard(START_FEN)}>
            Reset board
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBoard(EMPTY_FEN)}>
            Clear
          </Button>
          <Button variant="outline" size="sm" onClick={captureAll}>
            Capture all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
            title="Rotate your VIEW only — the position doesn't change"
          >
            Flip view
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={rotateBoard}
            title="Move every piece to its mirrored square — use when a position was read from the wrong side"
          >
            Rotate 180°
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPgnOpen((v) => !v)}
          >
            Load PGN
          </Button>
        </div>

        {pgnOpen && (
          <div className="flex flex-col gap-2">
            <textarea
              className="min-h-20 rounded-md border bg-transparent p-2 font-mono text-xs"
              placeholder="Paste a PGN — the final position is loaded into the editor."
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
            />
            <div>
              <Button size="sm" variant="outline" onClick={loadPgn} disabled={!pgnText.trim()}>
                Load final position
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">To move:</span>
          <Button
            variant={side === "w" ? "default" : "outline"}
            size="sm"
            onClick={() => setSide("w")}
          >
            White
          </Button>
          <Button
            variant={side === "b" ? "default" : "outline"}
            size="sm"
            onClick={() => setSide("b")}
          >
            Black
          </Button>
          {side === null && (
            <span className="ml-1 font-medium text-amber-600">
              ← choose before analyzing
            </span>
          )}
        </div>

        <fieldset className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <legend className="mb-1 text-muted-foreground">Castling availability</legend>
          {CASTLING_LABELS.map(({ key, label }) => (
            <label
              key={key}
              className={`flex items-center gap-2 ${available[key] ? "" : "opacity-50"}`}
            >
              <Checkbox
                checked={castling[key] && available[key]}
                disabled={!available[key]}
                onCheckedChange={(checked) =>
                  setCastling((c) => ({ ...c, [key]: checked === true }))
                }
              />
              {label}
            </label>
          ))}
        </fieldset>

        <p className="text-xs text-muted-foreground">
          Drag spare pieces onto the board; drag pieces off the board to remove
          them. Boxes gray out when the king or rook isn&apos;t on its home square.
        </p>

        <div className="flex gap-2">
          <Button size="sm" onClick={apply} disabled={side === null}>
            Analyze this position
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </ChessboardProvider>
  );
}
