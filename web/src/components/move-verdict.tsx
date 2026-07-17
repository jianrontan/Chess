"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { whiteScore } from "@/lib/engine/format";
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
  pending,
  skipped,
  onExplain,
}: {
  verdict: MoveVerdict | null;
  pending: boolean;
  skipped: boolean;
  onExplain?: () => void;
}) {
  if (pending) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          Grading your move…
        </CardContent>
      </Card>
    );
  }
  if (skipped) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          Move not graded — the position hadn&apos;t been analyzed yet.
        </CardContent>
      </Card>
    );
  }
  if (!verdict) return null;

  const style = CLASS_STYLE[verdict.moveClass];
  const played = verdict.playedLine.pv[0];
  const refutation = verdict.playedLine.pv.slice(1, 7);
  const showAlternative = verdict.moveClass !== "best" && verdict.moveClass !== "good";

  return (
    <Card>
      <CardContent className="space-y-2 pt-4 text-sm">
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${style.className}`}>
            {style.label}
          </span>
          <span className="font-mono font-medium">{played}</span>
          {/* White-centric eval: best-move eval → eval after the played move.
              Both lines share the pre-move side to move, so one conversion. */}
          <span className="font-mono text-xs text-muted-foreground">
            {whiteScore(verdict.bestLine, verdict.mover)} →{" "}
            {whiteScore(verdict.playedLine, verdict.mover)}
          </span>
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
            Punished by:{" "}
            <span className="font-mono">{refutation.join(" ")}</span>
          </p>
        )}
        {showAlternative && (
          <p className="text-xs text-muted-foreground">
            Better was:{" "}
            <span className="font-mono font-medium">{verdict.bestLine.pv[0]}</span>
            <span className="font-mono"> {verdict.bestLine.pv.slice(1, 5).join(" ")}</span>
          </p>
        )}
        {onExplain && (
          <Button variant="outline" size="sm" onClick={onExplain}>
            Explain this move
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
