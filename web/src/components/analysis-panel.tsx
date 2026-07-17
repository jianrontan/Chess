"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { whiteScore } from "@/lib/engine/format";
import type { EngineLine } from "@/lib/engine/types";

export interface AnalysisPanelProps {
  lines: EngineLine[];
  sideToMove: "w" | "b";
  analyzing: boolean;
  depth: number;
  gameOverText?: string;
  /** Rows to reserve while lines are empty, so the card height (and with it
   * the page scrollbar) doesn't jump every time a new search starts. */
  placeholderRows?: number;
}

export function AnalysisPanel({
  lines,
  sideToMove,
  analyzing,
  depth,
  gameOverText,
  placeholderRows = 3,
}: AnalysisPanelProps) {
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Engine analysis</CardTitle>
        <CardDescription>
          {gameOverText
            ? gameOverText
            : analyzing
              ? `Analyzing… depth ${depth}`
              : depth > 0
                ? `Depth ${depth}`
                : "Waiting for position"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {gameOverText ? (
          <p className="text-sm text-muted-foreground">No moves to analyze.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3">#</th>
                <th className="py-1 pr-3">Move</th>
                <th className="py-1 pr-3">Eval</th>
                <th className="py-1">Line</th>
              </tr>
            </thead>
            <tbody>
              {lines.length > 0
                ? lines.map((l) => (
                    <tr key={l.multipv} className="border-t align-top">
                      <td className="py-1.5 pr-3">{l.multipv}</td>
                      <td className="py-1.5 pr-3 font-mono font-medium">{l.pv[0]}</td>
                      <td className="py-1.5 pr-3 font-mono">{whiteScore(l, sideToMove)}</td>
                      <td className="py-1.5 font-mono text-xs text-muted-foreground">
                        {l.pv.slice(0, 6).join(" ")}
                      </td>
                    </tr>
                  ))
                : // Same row heights as real lines — the card must not shrink
                  // (and bounce the page scrollbar) while a search restarts.
                  Array.from({ length: placeholderRows }, (_, i) => (
                    <tr key={i} className="border-t align-top text-muted-foreground/50">
                      <td className="py-1.5 pr-3">{i + 1}</td>
                      <td className="py-1.5 pr-3 font-mono font-medium">—</td>
                      <td className="py-1.5 pr-3 font-mono">—</td>
                      <td className="py-1.5 font-mono text-xs">
                        {analyzing ? "searching…" : "waiting for position"}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
