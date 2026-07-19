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
    piece_list,
    pv_to_san,
)

# Mate-in-2 sample puzzle (01gBD), White to move after the setup move.
MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24"


# GOLDEN STRINGS — byte-identical assertions exist in
# web/worker/lib/prompt.test.ts. If you change the format, change both or
# the harness stops measuring the deployed prompt.
GOLDEN_PIECE_LISTS = {
    MATE_FEN: (
        "White: Kh1, Qh3, Rf1, Ng3, pawns a2 b2 c3 d4 e5 h2\n"
        "Black: Kh8, Qd3, Rc8, Bb7, Ne4, pawns a7 b6 d5 g7 h7"
    ),
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1": (
        "White: Ke1, Qd1, Ra1, Rh1, Bc1, Bf1, Nb1, Ng1, "
        "pawns a2 b2 c2 d2 e2 f2 g2 h2\n"
        "Black: Ke8, Qd8, Ra8, Rh8, Bc8, Bf8, Nb8, Ng8, "
        "pawns a7 b7 c7 d7 e7 f7 g7 h7"
    ),
    "8/8/8/8/8/8/8/K6k w - - 0 1": "White: Ka1\nBlack: Kh1",
}


@pytest.mark.parametrize(("fen", "expected"), GOLDEN_PIECE_LISTS.items())
def test_piece_list_golden(fen, expected):
    assert piece_list(fen) == expected


def test_piece_list_states_the_squares_the_model_kept_inventing():
    # Regression for the v1 bug: the model claimed a queen on h3 for Black
    # (it is White's) and rooks on c2. The list must make both unambiguous.
    text = piece_list(MATE_FEN)
    assert "Qh3" in text.split("\n")[0]  # White's queen, not Black's
    assert "c2" not in text  # nothing stands on c2


def test_piece_list_is_included_in_both_prompts():
    lines = [EngineLine(multipv=1, depth=20, pv=("h3c8", "b7c8", "f1f8"), cp=None, mate=2)]
    candidates = build_candidates_prompt(MATE_FEN, lines)
    assert GOLDEN_PIECE_LISTS[MATE_FEN] in candidates.user
    grade = build_grade_prompt(MATE_FEN, "f1f8", "blunder", 100.0, 21.6, lines[0], lines[0])
    assert GOLDEN_PIECE_LISTS[MATE_FEN] in grade.user


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
    assert prompt.prompt_version == "explain-v2"
    assert prompt.user == (
        f"Position (FEN): {MATE_FEN}\n"
        "White to move.\n"
        "\n"
        "Pieces on the board:\n"
        f"{GOLDEN_PIECE_LISTS[MATE_FEN]}\n"
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
    assert tpl["version"] == "explain-v2"
    assert "{{candidates}}" in tpl["user"]["candidates"]
    assert "{{played_line}}" in tpl["user"]["grade"]
    # The v2 fix is only real if BOTH prompts carry the piece list.
    assert "{{pieces}}" in tpl["user"]["candidates"]
    assert "{{pieces}}" in tpl["user"]["grade"]
