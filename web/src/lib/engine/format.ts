import type { EngineLine } from "./types";

/**
 * Convert a line's score to White's perspective for display.
 * UCI cp/mate are from the side to move (see web/CLAUDE.md).
 * "#3" = White mates in 3, "#-3" = Black mates in 3.
 */
export function whiteScore(
  line: Pick<EngineLine, "cp" | "mate">,
  sideToMove: "w" | "b",
): string {
  if (line.mate !== undefined) {
    const mate = sideToMove === "w" ? line.mate : -line.mate;
    return `#${mate}`;
  }
  if (line.cp !== undefined) {
    const cp = sideToMove === "w" ? line.cp : -line.cp;
    return `${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;
  }
  return "?";
}
