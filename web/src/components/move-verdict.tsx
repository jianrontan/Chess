"use client";

import { Card, CardContent } from "@/components/ui/card";
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
}: {
  verdict: MoveVerdict | null;
  pending: boolean;
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
          {verdict.winPctDrop >= 1 && (
            <span className="text-muted-foreground">
              −{verdict.winPctDrop.toFixed(0)}% win chance
            </span>
          )}
        </div>
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
      </CardContent>
    </Card>
  );
}
