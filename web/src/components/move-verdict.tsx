"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { whiteScore } from "@/lib/engine/format";
import { formatSanLine, uciToSan } from "@/lib/engine/san";
import type { MoveClass, MoveVerdict } from "@/lib/engine/grading";

const CLASS_STYLE: Record<MoveClass, { label: string; className: string }> = {
  best: { label: "Best move", className: "bg-green-600 text-white" },
  good: { label: "Good", className: "bg-emerald-500 text-white" },
  inaccuracy: { label: "Inaccuracy", className: "bg-yellow-500 text-black" },
  mistake: { label: "Mistake", className: "bg-orange-500 text-white" },
  blunder: { label: "Blunder", className: "bg-red-600 text-white" },
};

export function MoveVerdictCard({
  verdict,
  /** Position BEFORE the played move — SAN conversion needs it. */
  fen,
  pending,
  skipped,
  explaining,
  onExplain,
  arrowsShown,
  onToggleArrows,
}: {
  verdict: MoveVerdict | null;
  fen: string | null;
  pending: boolean;
  skipped: boolean;
  /** An explanation is currently streaming — hold off on new requests. */
  explaining?: boolean;
  onExplain?: () => void;
  /** Board arrows for this verdict (played + best move) — user-toggleable. */
  arrowsShown?: boolean;
  onToggleArrows?: () => void;
}) {
  if (pending) {
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground" aria-live="polite">
          Grading your move…
        </CardContent>
      </Card>
    );
  }
  if (skipped) {
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground" aria-live="polite">
          Move not graded — the position hadn&apos;t been analyzed yet.
        </CardContent>
      </Card>
    );
  }
  if (!verdict) return null;

  const style = CLASS_STYLE[verdict.moveClass];
  // SAN for humans (UCI belonged to the engine): "Nf3", not "g1f3". The
  // pre-move fen anchors conversion; raw UCI is the fallback if it's absent.
  const playedSan = fen ? uciToSan(fen, [verdict.playedLine.pv[0]])[0] : verdict.playedLine.pv[0];
  const refutation = fen
    ? uciToSan(fen, verdict.playedLine.pv).slice(1, 7).join(" ")
    : verdict.playedLine.pv.slice(1, 7).join(" ");
  const bestLineSan = fen
    ? formatSanLine(fen, verdict.bestLine.pv, 5)
    : verdict.bestLine.pv.slice(0, 5).join(" ");
  const showAlternative = verdict.moveClass !== "best" && verdict.moveClass !== "good";

  return (
    <Card>
      <CardContent className="space-y-2 text-sm" aria-live="polite">
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${style.className}`}>
            {style.label}
          </span>
          <span className="font-mono font-medium">{playedSan}</span>
          {/* White-centric eval: best-move eval → eval after the played move.
              Both lines share the pre-move side to move, so one conversion. */}
          <span className="font-mono text-xs text-muted-foreground">
            {whiteScore(verdict.bestLine, verdict.mover)} →{" "}
            {whiteScore(verdict.playedLine, verdict.mover)}
          </span>
          {onToggleArrows && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs text-muted-foreground"
              onClick={onToggleArrows}
            >
              {arrowsShown ? "Hide arrows" : "Show arrows"}
            </Button>
          )}
        </div>
        {verdict.winPctDrop >= 1 && (
          <p className="text-xs text-muted-foreground">
            {verdict.mover === "w" ? "White" : "Black"}&apos;s winning chances:{" "}
            {verdict.winPctBefore.toFixed(0)}% →{" "}
            {verdict.winPctAfter.toFixed(0)}% (best move kept it at{" "}
            {verdict.winPctBefore.toFixed(0)}%)
          </p>
        )}
        {refutation.length > 0 && showAlternative && (
          <p className="text-xs text-muted-foreground">
            Punished by: <span className="font-mono">{refutation}</span>
          </p>
        )}
        {showAlternative && (
          <p className="text-xs text-muted-foreground">
            Better was: <span className="font-mono font-medium">{bestLineSan}</span>
          </p>
        )}
        {onExplain && (
          <Button variant="outline" size="sm" disabled={explaining} onClick={onExplain}>
            {explaining ? "Explaining…" : "Explain this move"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
