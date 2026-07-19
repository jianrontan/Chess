"""Prompt building must mirror web/worker/lib/prompt.ts exactly.

The golden strings here pin the serialization the Worker produces — if
either side changes, the eval no longer measures the deployed prompt.
"""

import pytest

from pipeline.engine import EngineLine
from pipeline.prompts import (
    build_candidates_prompt,
    build_grade_prompt,
    eval_phrase,
    fill,
    load_template,
    pv_to_san,
)

# Mate-in-2 sample puzzle (01gBD), White to move after the setup move.
MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24"


def test_fill_raises_on_missing_variable():
    with pytest.raises(KeyError):
        fill("hello {{name}}", {})


def test_pv_to_san_white_first():
    assert pv_to_san(MATE_FEN, ["h3c8", "b7c8", "f1f8"]) == "24. Qxc8+ Bxc8 25. Rf8#"


def test_pv_to_san_black_first_uses_ellipsis():
    fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    assert pv_to_san(fen, ["e7e5", "g1f3"]) == "1... e5 2. Nf3"


def test_pv_to_san_rejects_illegal():
    with pytest.raises(ValueError):
        pv_to_san(MATE_FEN, ["h3h8"])


def test_eval_phrase_matches_worker():
    assert eval_phrase(20, None, "w") == "roughly equal"
    assert eval_phrase(250, None, "w") == "winning for White (+2.5)"
    assert eval_phrase(250, None, "b") == "winning for Black (-2.5)"
    assert eval_phrase(-50, None, "w") == "slightly better for Black (-0.5)"
    assert eval_phrase(150, None, "w") == "clearly better for White (+1.5)"
    assert eval_phrase(None, 2, "w") == "White mates in 2"
    assert eval_phrase(None, -3, "w") == "Black mates in 3"
    assert eval_phrase(None, 2, "b") == "Black mates in 2"


def test_candidates_prompt_golden():
    lines = [
        EngineLine(multipv=1, depth=20, pv=("h3c8", "b7c8", "f1f8"), cp=None, mate=2),
        EngineLine(multipv=2, depth=20, pv=("f1e1",), cp=150, mate=None),
    ]
    prompt = build_candidates_prompt(MATE_FEN, lines)
    assert prompt.prompt_version == "explain-v1"
    assert prompt.user == (
        f"Position (FEN): {MATE_FEN}\n"
        "White to move.\n"
        "\n"
        "Engine analysis, top candidate moves (searched to depth 20):\n"
        "1. 24. Qxc8+ Bxc8 25. Rf8# — White mates in 2\n"
        "2. 24. Re1 — clearly better for White (+1.5)\n"
        "\n"
        "Explain in plain English what is going on in this position and what "
        "White should play. Compare the top candidates where they differ "
        "meaningfully."
    )


def test_grade_prompt_contains_verdict_facts():
    played = EngineLine(multipv=1, depth=18, pv=("f1f8", "c8f8"), cp=-350, mate=None)
    best = EngineLine(multipv=1, depth=18, pv=("h3c8", "b7c8", "f1f8"), cp=None, mate=2)
    prompt = build_grade_prompt(MATE_FEN, "f1f8", "blunder", 100.0, 21.6, played, best)
    assert "White played 24. Rf8+, which the engine graded as a blunder." in prompt.user
    assert "winning chances went from 100% to 22%." in prompt.user
    assert "24. Rf8+ Rxf8 — winning for Black (-3.5)" in prompt.user
    assert "24. Qxc8+ Bxc8 25. Rf8# — White mates in 2" in prompt.user


def test_template_versions_exist():
    tpl = load_template()
    assert tpl["version"] == "explain-v1"
    assert "{{candidates}}" in tpl["user"]["candidates"]
    assert "{{played_line}}" in tpl["user"]["grade"]
