"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Lichess-style vertical evaluation bar.
 *
 * The fill colours are chess-semantic, not theme colours: White's share of the
 * bar is literally white and Black's is near-black in BOTH light and dark mode,
 * so they are hardcoded on purpose. Only the surrounding chrome (border/track)
 * uses theme tokens so the bar sits cleanly on either background.
 *
 * `winPct` is White's win probability (0..100), computed by the parent from the
 * engine eval. Passing `null` means "no fresh data" — rather than snapping the
 * bar to 50% mid-search, we hold the LAST known value (kept in a ref) so it
 * only ever animates toward a real number. Before any value has arrived we
 * show a neutral 50%.
 */
export interface EvalBarProps {
  /** White's win percentage, 0..100. `null` holds the last known value. */
  winPct: number | null;
  /** Pre-formatted score to label, White-centric (e.g. "+0.37", "#3"). */
  scoreText: string;
  /** Height utility for the track, so the parent can match the board. */
  heightClass?: string;
}

function clampPct(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export function EvalBar({
  winPct,
  scoreText,
  heightClass = "h-full",
}: EvalBarProps) {
  // The displayed fill lives in state so it persists across renders. A null
  // `winPct` leaves it untouched (we hold the last real value); it seeds at 50
  // so the bar is neutral until the first eval lands. We adjust it during
  // render when `winPct` changes — React's sanctioned pattern for deriving
  // state from a prop, avoiding an effect + extra paint.
  const [pct, setPct] = React.useState(50);
  const [seenWinPct, setSeenWinPct] = React.useState(winPct);
  if (winPct !== seenWinPct) {
    setSeenWinPct(winPct);
    if (winPct !== null && Number.isFinite(winPct)) {
      setPct(clampPct(winPct));
    }
  }
  const whiteWinning = pct >= 50;

  return (
    <div
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Evaluation: ${scoreText}`}
      className={cn(
        "relative w-4 shrink-0 overflow-hidden rounded border border-border bg-neutral-900",
        heightClass,
      )}
    >
      {/* White's share grows up from the bottom of the track. */}
      <div
        className="absolute inset-x-0 bottom-0 bg-white transition-[height] duration-500"
        style={{ height: `${pct}%` }}
      />
      {/* Score label pinned to the winning edge, coloured to read against the
          half it sits on: dark text over White's fill, light over Black's. */}
      <span
        className={cn(
          "absolute inset-x-0 z-10 text-center text-[9px] leading-none font-medium tabular-nums",
          whiteWinning
            ? "bottom-0.5 text-neutral-900"
            : "top-0.5 text-neutral-100",
        )}
      >
        {scoreText}
      </span>
    </div>
  );
}
