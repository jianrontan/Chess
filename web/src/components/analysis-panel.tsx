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
}

export function AnalysisPanel({
  lines,
  sideToMove,
  analyzing,
  depth,
  gameOverText,
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
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {analyzing ? "Searching…" : "Make a move or load a position."}
          </p>
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
              {lines.map((l) => (
                <tr key={l.multipv} className="border-t align-top">
                  <td className="py-1.5 pr-3">{l.multipv}</td>
                  <td className="py-1.5 pr-3 font-mono font-medium">{l.pv[0]}</td>
                  <td className="py-1.5 pr-3 font-mono">{whiteScore(l, sideToMove)}</td>
                  <td className="py-1.5 font-mono text-xs text-muted-foreground">
                    {l.pv.slice(0, 6).join(" ")}
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
