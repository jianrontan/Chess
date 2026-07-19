"""Move grading: win%-drop classification of a played move.

Python port of web/src/lib/engine/grading.ts — the serve pipeline's Mode 2.
The two implementations must agree (same Lichess win% formula, same
thresholds) so a harness grade means the same thing as a prod grade; the
golden cases in tests/test_grading.py pin the parity.

Eval perspective: cp/mate are from the SIDE TO MOVE of the analyzed
position (UCI convention). Both lines passed to grade_played_move must
come from the same pre-move position so they share that perspective.
"""

import math
from dataclasses import dataclass

MoveClass = str  # "best" | "good" | "inaccuracy" | "mistake" | "blunder"

# Win%-drop thresholds (lichess-style), mirrors grading.ts THRESHOLDS.
_THRESHOLDS: tuple[tuple[float, str], ...] = (
    (30, "blunder"),
    (20, "mistake"),
    (10, "inaccuracy"),
)


def cp_to_win_pct(cp: float) -> float:
    """Lichess's centipawns -> expected-win-percentage conversion."""
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def line_win_pct(cp: int | None, mate: int | None) -> float:
    """Win% for a line, treating forced mates as decided."""
    if mate is not None:
        return 100.0 if mate > 0 else 0.0
    if cp is not None:
        return cp_to_win_pct(cp)
    return 50.0


@dataclass(frozen=True, slots=True)
class MoveVerdict:
    move_class: MoveClass
    win_pct_before: float
    """Mover's win% had they played the best move."""
    win_pct_after: float
    """Mover's win% after the move actually played."""
    win_pct_drop: float


def grade_played_move(
    best: tuple[int | None, int | None, str],
    played: tuple[int | None, int | None, str],
) -> MoveVerdict:
    """Grade a played move against the best line of the same position.

    Each line is (cp, mate, first_move_uci) with the eval from the mover's
    perspective. Mirrors gradePlayedMove in grading.ts.
    """
    best_cp, best_mate, best_uci = best
    played_cp, played_mate, played_uci = played
    win_before = line_win_pct(best_cp, best_mate)
    win_after = min(win_before, line_win_pct(played_cp, played_mate))
    drop = win_before - win_after

    move_class: MoveClass = "good"
    if played_uci == best_uci:
        move_class = "best"
    else:
        for threshold, cls in _THRESHOLDS:
            if drop >= threshold:
                move_class = cls
                break
    return MoveVerdict(
        move_class=move_class,
        win_pct_before=win_before,
        win_pct_after=win_after,
        win_pct_drop=drop,
    )
