"""Parity with web/src/lib/engine/grading.ts — same formula, same thresholds."""

import math

from pipeline.grading import cp_to_win_pct, grade_played_move, line_win_pct


def test_win_pct_center_and_symmetry():
    assert cp_to_win_pct(0) == 50
    assert math.isclose(cp_to_win_pct(100) + cp_to_win_pct(-100), 100)
    assert cp_to_win_pct(1000) > 95


def test_line_win_pct_mate_is_decided():
    assert line_win_pct(None, 3) == 100
    assert line_win_pct(None, -1) == 0
    assert line_win_pct(None, None) == 50


def test_same_move_is_best_regardless_of_drop():
    v = grade_played_move((300, None, "e2e4"), (300, None, "e2e4"))
    assert v.move_class == "best"
    assert v.win_pct_drop == 0


def test_better_played_line_clamps_to_zero_drop():
    v = grade_played_move((100, None, "e2e4"), (200, None, "d2d4"))
    assert v.move_class == "good"
    assert v.win_pct_drop == 0
    assert v.win_pct_after == v.win_pct_before


def test_threshold_classes():
    # Missing a mate for equality: 100 -> 50 = blunder.
    v = grade_played_move((None, 2, "e2e4"), (0, None, "d2d4"))
    assert v.move_class == "blunder"
    assert v.win_pct_drop == 50

    # Construct drops around each threshold using the real conversion.
    best = (300, None, "e2e4")
    before = line_win_pct(*best[:2])
    for cp, expected in ((250, "good"), (60, "inaccuracy"), (30, "mistake"), (-100, "blunder")):
        v = grade_played_move(best, (cp, None, "d2d4"))
        drop = before - line_win_pct(cp, None)
        assert v.move_class == expected, (cp, drop)
