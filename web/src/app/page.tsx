"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EngineClient } from "@/lib/engine/client";
import type { EngineLine } from "@/lib/engine/types";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function formatScore(line: EngineLine): string {
  if (line.mate !== undefined) return `#${line.mate}`;
  if (line.cp !== undefined) return (line.cp / 100).toFixed(2);
  return "?";
}

export default function Home() {
  const engineRef = useRef<EngineClient | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "analyzing" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [isolated, setIsolated] = useState<boolean | null>(null);
  const [threads, setThreads] = useState(0);
  const [variant, setVariant] = useState("");
  const [lines, setLines] = useState<EngineLine[]>([]);
  const [health, setHealth] = useState<string>("checking…");

  useEffect(() => {
    // Strict mode mounts effects twice in dev: the cancelled flag keeps the
    // disposed first engine's rejections from touching the live UI state.
    let cancelled = false;
    const engine = new EngineClient();
    engineRef.current = engine;
    engine
      .init()
      .then(() => {
        if (cancelled) return;
        setIsolated(typeof crossOriginIsolated !== "undefined" && crossOriginIsolated);
        setThreads(engine.info.threads);
        setVariant(engine.info.variant);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      });

    fetch("/api/health")
      .then((r) => r.json())
      .then((j: { ok?: boolean }) => {
        if (!cancelled) setHealth(j.ok ? "ok" : "unexpected response");
      })
      .catch(() => {
        if (!cancelled) setHealth("unreachable");
      });

    return () => {
      cancelled = true;
      engine.dispose();
    };
  }, []);

  async function analyze() {
    const engine = engineRef.current;
    if (!engine) return;
    setStatus("analyzing");
    setLines([]);
    try {
      const result = await engine.analyze(START_FEN, {
        multipv: 3,
        movetimeMs: 5000,
        onLines: setLines,
      });
      setLines(result.lines);
      setStatus("ready");
    } catch (e: unknown) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Chess Explanation Engine — Phase 1 proof</h1>

      <Card>
        <CardHeader>
          <CardTitle>Environment</CardTitle>
          <CardDescription>
            Threading requires cross-origin isolation (COOP/COEP headers).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            crossOriginIsolated:{" "}
            <span className={isolated ? "text-green-600" : "text-red-600"}>
              {isolated === null ? "…" : String(isolated)}
            </span>
          </p>
          <p>
            Engine: {variant} · {threads} thread{threads === 1 ? "" : "s"} · status: {status}
            {status === "error" ? ` (${error})` : ""}
          </p>
          <p>/api/health (same-origin Worker): {health}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top 3 moves from the start position</CardTitle>
          <CardDescription>MultiPV analysis, 5s fixed movetime, progressive.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={analyze} disabled={status !== "ready"}>
            {status === "analyzing" ? "Analyzing…" : "Analyze"}
          </Button>
          {lines.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-4">#</th>
                  <th className="py-1 pr-4">Move</th>
                  <th className="py-1 pr-4">Eval</th>
                  <th className="py-1 pr-4">Depth</th>
                  <th className="py-1">Line</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.multipv} className="border-t">
                    <td className="py-1 pr-4">{l.multipv}</td>
                    <td className="py-1 pr-4 font-mono">{l.pv[0]}</td>
                    <td className="py-1 pr-4 font-mono">{formatScore(l)}</td>
                    <td className="py-1 pr-4">{l.depth}</td>
                    <td className="py-1 font-mono text-xs text-muted-foreground">
                      {l.pv.slice(0, 8).join(" ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
