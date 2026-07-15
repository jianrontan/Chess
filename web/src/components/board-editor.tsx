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
import { buildEditorFen } from "@/lib/editor";

const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const SPARE_TYPES = ["K", "Q", "R", "B", "N", "P"] as const;

export function BoardEditor({
  initialFen,
  onApply,
  onCancel,
}: {
  initialFen: string;
  onApply: (fen: string) => void;
  onCancel: () => void;
}) {
  // skipValidation: mid-edit positions are allowed to be arbitrary.
  const placementRef = useRef(new Chess(initialFen, { skipValidation: true }));
  const [position, setPosition] = useState(() =>
    new Chess(initialFen, { skipValidation: true }).fen(),
  );
  const [side, setSide] = useState<"w" | "b">("w");
  const [error, setError] = useState("");

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
    if (!piece.isSparePiece) placement.remove(sourceSquare as Square);
    const ok = placement.put({ color, type }, targetSquare as Square);
    if (!ok) return false; // e.g. a second king of the same color
    setPosition(placement.fen());
    setError("");
    return true;
  }

  function setBoard(fen: string) {
    placementRef.current = new Chess(fen, { skipValidation: true });
    setPosition(placementRef.current.fen());
    setError("");
  }

  function apply() {
    const result = buildEditorFen(placementRef.current, side);
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
    <ChessboardProvider options={{ position, onPieceDrop, id: "editor-board" }}>
      <div className="flex flex-col gap-3">
        {spareRow("b")}
        <Chessboard />
        {spareRow("w")}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setBoard(EMPTY_FEN)}>
            Clear
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBoard(START_FEN)}>
            Start position
          </Button>
          <div className="ml-2 flex items-center gap-1 text-sm">
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
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Drag spare pieces onto the board; drag pieces off the board to remove them.
          Castling rights are inferred from piece placement.
        </p>

        <div className="flex gap-2">
          <Button size="sm" onClick={apply}>
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
