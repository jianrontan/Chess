/**
 * Typed client around the Stockfish WASM Web Worker.
 *
 * Talks UCI over postMessage. Feature-detects cross-origin isolation:
 * threaded lite build when available, single-thread lite fallback otherwise
 * (see docs/ARCHITECTURE.md "Step 0" for why the headers matter).
 *
 * Searches are serialized internally: concurrent analyze() calls queue and
 * run one at a time (UCI engines cannot run overlapping searches, and a
 * shared message stream cannot attribute lines to searches).
 */

import type { AnalyzeOptions, AnalyzeResult, EngineInfo, EngineLine } from "./types";

const ENGINE_BASE = "/engine";

/** Extra time allowed past movetime before declaring the engine hung. */
const BESTMOVE_TIMEOUT_MARGIN_MS = 10_000;

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
  // Aspiration-window bound lines carry provisional scores; recording one as
  // the final eval would skew grading deltas. Skip them (lichess does too).
  if (tokens.includes("lowerbound") || tokens.includes("upperbound")) return undefined;

  const num = (key: string): number | undefined => {
    const i = tokens.indexOf(key);
    if (i < 0) return undefined;
    const n = Number(tokens[i + 1]);
    return Number.isFinite(n) ? n : undefined;
  };
  const depth = num("depth");
  if (depth === undefined) return undefined;

  const scoreIdx = tokens.indexOf("score");
  let cp: number | undefined;
  let mate: number | undefined;
  if (scoreIdx >= 0) {
    if (tokens[scoreIdx + 1] === "cp") cp = num("cp");
    else if (tokens[scoreIdx + 1] === "mate") mate = num("mate");
  }

  const pvIdx = tokens.indexOf("pv");
  const pv = pvIdx >= 0 ? tokens.slice(pvIdx + 1) : [];

  return { multipv: num("multipv") ?? 1, depth, cp, mate, pv };
}

export class EngineClient {
  private worker: Worker | undefined;
  private listeners = new Set<(line: string) => void>();
  /** Rejectors of in-flight waitFor promises, settled early on dispose. */
  private pendingRejects = new Set<(err: Error) => void>();
  /** Serialization chain: at most one search touches the engine at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
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
    if (this.worker) throw new Error("engine already initialized");
    if (this.disposed) throw new Error("engine disposed");
    this.worker = new Worker(this.url);
    this.worker.onmessage = (e: MessageEvent) => {
      const line = typeof e.data === "string" ? e.data : "";
      for (const fn of this.listeners) fn(line);
    };
    this.send("uci");
    await this.waitFor((l) => l === "uciok");
    this.send(`setoption name Threads value ${this.info.threads}`);
    await this.ready();
  }

  /**
   * Analyze a position; resolves on bestmove. Concurrent calls are queued
   * and run sequentially in call order.
   */
  analyze(fen: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    const run = () => this.doAnalyze(fen, opts);
    // Run after the previous search regardless of how it settled.
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
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

  /** Stop any running search (its analyze() still resolves, with bestmove). */
  stop(): void {
    this.send("stop");
  }

  /** Terminate the worker and reject all in-flight waits immediately. */
  dispose(): void {
    this.disposed = true;
    for (const reject of this.pendingRejects) reject(new Error("engine disposed"));
    this.pendingRejects.clear();
    this.send("quit");
    this.worker?.terminate();
    this.worker = undefined;
  }

  private async doAnalyze(fen: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
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

    try {
      const goParts = ["go", "movetime", String(movetime)];
      if (opts.searchMoves?.length) goParts.push("searchmoves", ...opts.searchMoves);
      this.send(goParts.join(" "));

      const bestLine = await this.waitFor(
        (l) => l.startsWith("bestmove"),
        movetime + BESTMOVE_TIMEOUT_MARGIN_MS,
      );

      // "bestmove (none)" = terminal position (mate/stalemate) or searchmoves
      // with no legal move.
      const bestToken = bestLine.split(/\s+/)[1] ?? "";
      const bestMove = bestToken === "(none)" ? null : bestToken;
      const final = sortedLines(lines);
      return {
        lines: final,
        bestMove,
        depth: final[0]?.depth ?? 0,
      };
    } finally {
      unsubscribe();
    }
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
      if (this.disposed) {
        reject(new Error("engine disposed"));
        return;
      }
      const rejectEarly = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => rejectEarly(new Error("engine timeout")), timeoutMs);
      const unsubscribe = this.subscribe((line) => {
        if (match(line)) {
          cleanup();
          resolve(line);
        }
      });
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        this.pendingRejects.delete(rejectEarly);
      };
      this.pendingRejects.add(rejectEarly);
    });
  }
}

function sortedLines(lines: Map<number, EngineLine>): EngineLine[] {
  return [...lines.values()].sort((a, b) => a.multipv - b.multipv);
}
