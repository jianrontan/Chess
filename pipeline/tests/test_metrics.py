"""Deterministic explanation metrics (no LLM, no API spend)."""

import pytest

from pipeline.engine import EngineLine
from pipeline.metrics import (
    THEME_VOCAB,
    UNSCORED_THEMES,
    check_mate_consistency,
    check_piece_references,
    check_theme_coverage,
)

MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24"
MATE_PV = ["h3c8", "b7c8", "f1f8"]


def test_theme_vocab_and_unscored_do_not_overlap():
    assert not (set(THEME_VOCAB) & UNSCORED_THEMES)


def test_theme_coverage_named_and_missed():
    themes = ["backRankMate", "sacrifice", "mateIn2", "middlegame"]
    text = "White sacrifices the queen to force a back-rank mate."
    cov = check_theme_coverage(text, themes)
    # mateIn2/middlegame are unscored; only the two tactical tags count.
    assert set(cov.scored) == {"backRankMate", "sacrifice"}
    assert set(cov.named) == {"backRankMate", "sacrifice"}
    assert cov.rate == 1.0

    missed = check_theme_coverage("White plays a strong move and wins.", themes)
    assert missed.named == ()
    assert missed.rate == 0.0


def test_theme_coverage_not_applicable_without_tactical_tags():
    cov = check_theme_coverage("anything", ["middlegame", "crushing", "long"])
    assert not cov.applicable
    assert cov.rate is None


def test_piece_reference_accepts_root_and_line_positions():
    # Rook starts on f1 and lands on f8 during the mating line; the bishop
    # recaptures on c8. All three are legitimate claims.
    text = "The rook on f1 swings to f8. Black's bishop on b7 must take on c8."
    result = check_piece_references(text, MATE_FEN, [MATE_PV])
    assert result.clean, result.errors
    assert "rook on f1" in result.claims


def test_piece_reference_catches_hallucinated_placement():
    text = "White wins the rook on a8 with a skewer."
    result = check_piece_references(text, MATE_FEN, [MATE_PV])
    assert not result.clean
    assert result.errors == ("rook on a8",)


def test_piece_reference_rejects_illegal_line():
    with pytest.raises(ValueError):
        check_piece_references("text", MATE_FEN, [["h3h8"]])


def test_mate_consistency_both_directions():
    mate_line = [EngineLine(multipv=1, depth=20, pv=tuple(MATE_PV), cp=None, mate=2)]
    quiet_line = [EngineLine(multipv=1, depth=20, pv=("f1e1",), cp=150, mate=None)]

    assert check_mate_consistency("Rf8 is checkmate.", mate_line).consistent
    assert check_mate_consistency("White is simply better.", quiet_line).consistent

    invented = check_mate_consistency("This forces checkmate soon.", quiet_line)
    assert not invented.consistent
    assert invented.claimed and not invented.actual

    missed = check_mate_consistency("White wins material here.", mate_line)
    assert not missed.consistent
    assert missed.actual and not missed.claimed
