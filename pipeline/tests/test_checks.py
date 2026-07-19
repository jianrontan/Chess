"""Groundedness (hallucinated-move detection) and move-match checks."""

import pytest

from pipeline.checks import (
    allowed_sans,
    check_groundedness,
    check_move_match,
    extract_move_claims,
)
from pipeline.engine import EngineLine

MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24"
MATE_PV = ["h3c8", "b7c8", "f1f8"]


def test_extract_definite_claims():
    text = (
        "White wins with Qxc8+! After Bxc8 comes Rf8#. Castling O-O-O is "
        "impossible; note exd5 and the e8=Q threat."
    )
    assert extract_move_claims(text) == ["Qxc8", "Bxc8", "Rf8", "O-O-O", "exd5", "e8=Q"]


def test_bare_squares_are_not_claims_unless_numbered():
    assert extract_move_claims("the e5 pawn is weak and d4 is strong") == []
    assert extract_move_claims("the game began 1. e4 e5 and later 12... d5") == ["e4", "d5"]


def test_numbered_promotion_is_one_claim_not_two():
    # Regression: real output "43. g8=Q+" matched BOTH the promotion and a
    # bare push to g8, and the phantom g8 read as a hallucinated move.
    assert extract_move_claims("White wins with 43. g8=Q+ and mates.") == ["g8=Q"]


def test_long_algebraic_from_square_is_not_a_claim():
    # Regression: "Qb7-c8" is one move written long-form; counting the
    # leading Qb7 as a separate move reported a false hallucination.
    assert extract_move_claims("The queen goes Qb7-c8, promoting.") == []


def test_groundedness_pass_and_fail():
    ok = check_groundedness("Qxc8+ forces Bxc8, and Rf8# ends it.", MATE_FEN, [MATE_PV])
    assert ok.grounded
    assert ok.claims == ("Qxc8", "Bxc8", "Rf8")

    bad = check_groundedness("Qxc8+ wins, but Qb3 was also strong.", MATE_FEN, [MATE_PV])
    assert not bad.grounded
    assert bad.violations == ("Qb3",)


def test_allowed_sans_rejects_illegal_line():
    with pytest.raises(ValueError):
        allowed_sans(MATE_FEN, [["h3h8"]])


class OneMoveEngine:
    """analyse_move stub returning a fixed eval for the forced move."""

    def __init__(self, cp=None, mate=None):
        self._cp = cp
        self._mate = mate

    def analyse_move(self, fen, uci, *, depth):
        return EngineLine(multipv=1, depth=depth, pv=(uci,), cp=self._cp, mate=self._mate)


def _top(cp=None, mate=None, move="h3c8"):
    return EngineLine(multipv=1, depth=12, pv=(move,), cp=cp, mate=mate)


def test_move_match_exact_needs_no_engine():
    result = check_move_match(None, MATE_FEN, _top(mate=2), "h3c8", depth=12)
    assert result.exact and result.matched


def test_move_match_eval_equivalent():
    # Engine prefers a different move but the solution scores the same mate.
    result = check_move_match(
        OneMoveEngine(mate=3), MATE_FEN, _top(mate=2, move="f1f8"), "h3c8", depth=12
    )
    assert not result.exact
    assert result.eval_equivalent and result.matched


def test_move_match_divergence_detected():
    result = check_move_match(
        OneMoveEngine(cp=0), MATE_FEN, _top(mate=2, move="f1f8"), "h3c8", depth=12
    )
    assert not result.matched
    assert result.engine_win_pct == 100.0
    assert result.solution_win_pct == 50.0
