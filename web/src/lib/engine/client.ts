/**
 * Typed client around the Stockfish WASM Web Worker.
 *
 * Talks UCI over postMessage. Feature-detects cross-origin isolation:
 * threaded lite build when available, single-thread lite fallback otherwise
 * (see docs/ARCHITECTURE.md "Step 0" for why the headers matter).
 */

import type { AnalyzeOptions, AnalyzeResult, EngineInfo, EngineLine } from "./types";

const ENGINE_BASE = "/engine";

function pickVariant(): { url: string; variant: EngineInfo["variant"] } {
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  return isolated
    ? { url: `${ENGINE_BASE}/stockfish-18-lite.js`, variant: "lite" }
    : { url: `${ENGINE_BASE}/stockfish-18-lite-single.js`, variant: "lite-single" };
}

function pickThreads(variant: EngineInfo["variant"]): number {
  if (variant === "lite-single") return 1;
  const cores = navigator.hardwareConcurrency || 4;
  // Leave headroom for the UI thread; cap to avoid diminishing returns.
  return Math.max(1, Math.min(cores - 1, 8));
}

/** Parse one UCI `info` line into an EngineLine (undefined if not a PV line). */
export function parseInfoLine(line: string): EngineLine | undefined {
  if (!line.startsWith("info ") || !line.includes(" pv ")) return undefined;
  const tokens = line.split(/\s+/);
  const num = (key: string): number | undefined => {
    const i = tokens.indexOf(key);
    return i >= 0 ? Number(tokens[i + 1]) : undefined;
  };
  const depth = num("depth");
  if (depth === undefined) return undefined;

  const scoreIdx = tokens.indexOf("score");
  let cp: number | undefined;
  let mate: number | undefined;
  if (scoreIdx >= 0) {
    if (tokens[scoreIdx + 1] === "cp") cp = Number(tokens[scoreIdx + 2]);
    else if (tokens[scoreIdx + 1] === "mate") mate = Number(tokens[scoreIdx + 2]);
  }

  const pvIdx = tokens.indexOf("pv");
  const pv = pvIdx >= 0 ? tokens.slice(pvIdx + 1) : [];

  return { multipv: num("multipv") ?? 1, depth, cp, mate, pv };
}

export class EngineClient {
  private worker: Worker | undefined;
  private listeners = new Set<(line: string) => void>();
  public readonly info: EngineInfo;
  private readonly url: string;

  constructor() {
    const { url, variant } = pickVariant();
    this.url = url;
    this.info = {
      threaded: variant === "lite",
      threads: pickThreads(variant),
      variant,
    };
  }

  /** Spawn the worker and complete the UCI handshake. */
  async init(): Promise<void> {
    this.worker = new Worker(this.url);
    this.worker.onmessage = (e: MessageEvent) => {
      const line = typeof e.data === "string" ? e.data : "";
      for (const fn of this.listeners) fn(line);
    };
    this.send("uci");
    await this.waitFor((l) => l === "uciok");
    this.send(`setoption name Threads value ${this.info.threads}`);
    this.send("setoption name UCI_ShowWDL value true");
    await this.ready();
  }

  /** Analyze a position; resolves on bestmove. */
  async analyze(fen: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    if (!this.worker) throw new Error("engine not initialized");
    const multipv = opts.multipv ?? 3;
    const movetime = opts.movetimeMs ?? 3000;

    this.send(`setoption name MultiPV value ${multipv}`);
    await this.ready();
    this.send(`position fen ${fen}`);

    const lines = new Map<number, EngineLine>();
    const unsubscribe = this.subscribe((line) => {
      const parsed = parseInfoLine(line);
      if (parsed) {
        lines.set(parsed.multipv, parsed);
        opts.onLines?.(sortedLines(lines));
      }
    });

    const goParts = ["go", "movetime", String(movetime)];
    if (opts.searchMoves?.length) goParts.push("searchmoves", ...opts.searchMoves);
    this.send(goParts.join(" "));

    const bestLine = await this.waitFor((l) => l.startsWith("bestmove"));
    unsubscribe();

    const bestMove = bestLine.split(/\s+/)[1] ?? "";
    const final = sortedLines(lines);
    return {
      lines: final,
      bestMove,
      depth: final[0]?.depth ?? 0,
    };
  }

  /**
   * Evaluate a single move (Mode 2 grading) via a search restricted to it.
   * Use the same movetimeMs as the MultiPV run it is graded against —
   * a cross-depth delta is skewed (see ARCHITECTURE.md).
   */
  async gradeMove(
    fen: string,
    moveUci: string,
    opts: Pick<AnalyzeOptions, "movetimeMs" | "onLines"> = {},
  ): Promise<AnalyzeResult> {
    return this.analyze(fen, { ...opts, multipv: 1, searchMoves: [moveUci] });
  }

  /** Stop any running search. */
  stop(): void {
    this.send("stop");
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  private async ready(): Promise<void> {
    this.send("isready");
    await this.waitFor((l) => l === "readyok");
  }

  private subscribe(fn: (line: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private waitFor(match: (line: string) => boolean, timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("engine timeout"));
      }, timeoutMs);
      const unsubscribe = this.subscribe((line) => {
        if (match(line)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(line);
        }
      });
    });
  }
}

function sortedLines(lines: Map<number, EngineLine>): EngineLine[] {
  return [...lines.values()].sort((a, b) => a.multipv - b.multipv);
}
