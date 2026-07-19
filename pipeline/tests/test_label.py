"""Line walkthrough shown to the human labeler.

The terminal status must come from python-chess, never from the
explanation being graded — that is the whole point of showing it.
"""

from pipeline.label import _board_art, walk_line

MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24"
MATE_PV = ["h3c8", "b7c8", "f1f8"]


def test_board_art_orients_white_at_bottom():
    art = _board_art("8/8/8/8/8/8/8/R3K3 w Q - 0 1")
    lines = [x for x in art.splitlines() if x.strip()]
    assert lines[0].startswith(" 8")
    assert lines[7].startswith(" 1")
    assert "R . . . K" in lines[7]
    assert "a b c d e f g h" in lines[-1]


def test_walk_line_confirms_real_checkmate():
    out = walk_line(MATE_FEN, MATE_PV)
    assert "after 24. Qxc8+" in out
    assert "after 24... Bxc8" in out
    assert "CHECKMATE — White wins." in out


def test_walk_line_reports_no_mate_when_line_is_quiet():
    out = walk_line(MATE_FEN, ["f1e1"])
    assert "no forced mate" in out
    assert "CHECKMATE" not in out


def test_walk_line_reports_check_without_mate():
    out = walk_line(MATE_FEN, ["h3c8"])
    assert "check (not mate)" in out


def test_walk_line_survives_an_illegal_move():
    out = walk_line(MATE_FEN, ["h3c8", "a1a8"])
    assert "line breaks at a1a8" in out


def test_walk_line_handles_empty_line():
    assert "no forced mate" in walk_line(MATE_FEN, [])
