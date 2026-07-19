"""Runner end-to-end on a fake engine + fake LLM (no binary, no key, no net).

The real-engine path is covered by test_engine.py (skipped when no binary).
"""

import chess
import pytest

from pipeline.engine import EngineLine
from pipeline.judge_eval import _jobs_from_record
from pipeline.llm import FakeLLM
from pipeline.prompts import load_template
from pipeline.run_eval import _check_meta, _done_ids, run_puzzle

# Real sample record (puzzle 01gBD, mate-in-2).
RECORD = {
    "puzzle_id": "01gBD",
    "fen": "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24",
    "csv_fen": "2r4k/pb4pp/1p6/3pP3/3Pn3/2PBq1NQ/PP5P/5R1K b - - 4 23",
    "setup_move": "e3d3",
    "solution": ["h3c8", "b7c8", "f1f8"],
    "solver_color": "w",
    "rating": 1373,
    "rating_band": "1200-1799",
    "themes": ["backRankMate", "mate", "mateIn2", "middlegame", "sacrifice", "short"],
    "game_url": "https://lichess.org/Oojuy157/black#46",
}


class FakeEngine:
    """Deterministic engine: top-k legal moves in UCI order, fixed evals.

    analyse_move returns `move_cp` — set it low to make the setup move a
    blunder (grade arm runs) or near the top eval (arm skipped).
    """

    id_name = "fake-engine"

    def __init__(self, move_cp: int):
        self._move_cp = move_cp

    def analyse(self, fen, *, depth, multipv=1):
        board = chess.Board(fen)
        moves = sorted(board.legal_moves, key=lambda m: m.uci())[:multipv]
        return [
            EngineLine(multipv=i + 1, depth=depth, pv=(m.uci(),), cp=100 - 10 * i, mate=None)
            for i, m in enumerate(moves)
        ]

    def analyse_move(self, fen, uci, *, depth):
        return EngineLine(multipv=1, depth=depth, pv=(uci,), cp=self._move_cp, mate=None)


def test_run_puzzle_shape_and_grounded_fake():
    result = run_puzzle(
        RECORD, FakeEngine(move_cp=95), FakeLLM(), load_template(), depth=8, multipv=3
    )
    assert result["puzzle_id"] == "01gBD"
    assert result["csv_fen"] == RECORD["csv_fen"]
    assert result["solution_san"] == "24. Qxc8+ Bxc8 25. Rf8#"
    cand = result["candidates"]
    assert len(cand["lines"]) == 3
    # The fake LLM echoes a given engine row, so it must be grounded.
    assert cand["grounded"], cand["ground_violations"]
    # cp 95 vs top cp 100 is within the equivalence window.
    assert cand["move_match"]["matched"] and not cand["move_match"]["exact"]
    # Setup move graded ~equal -> no mistake -> grade arm skipped.
    assert result["grade"]["move_class"] in ("best", "good")
    assert result["grade"]["explained"] is False


def test_grade_arm_runs_on_blunder():
    result = run_puzzle(
        RECORD, FakeEngine(move_cp=-300), FakeLLM(), load_template(), depth=8, multipv=3
    )
    grade = result["grade"]
    assert grade["move_class"] == "blunder"
    assert grade["explained"] is True
    assert grade["explanation"]
    assert "Played move:" in grade["lines_text"]
    # A blunder-scored solution also breaks candidates-arm move-match.
    assert not result["candidates"]["move_match"]["matched"]

    # Judge jobs: candidates uses the post-setup fen, grade the pre-setup fen.
    jobs = _jobs_from_record(result)
    assert [j["arm"] for j in jobs] == ["candidates", "grade"]
    assert jobs[0]["fen"] == RECORD["fen"]
    assert jobs[1]["fen"] == RECORD["csv_fen"]


def test_done_ids_resume(tmp_path):
    out = tmp_path / "run.jsonl"
    assert _done_ids(out) == set()
    out.write_text('{"puzzle_id": "a"}\n{"puzzle_id": "b"}\n', encoding="utf-8")
    assert _done_ids(out) == {"a", "b"}


def test_meta_mismatch_refuses_resume(tmp_path):
    meta_path = tmp_path / "run.jsonl.meta.json"
    meta = {
        "sample": "s.jsonl",
        "engine_depth": 14,
        "multipv": 3,
        "model": "fake",
        "prompt_version": "explain-v1",
    }
    _check_meta(meta_path, meta)  # first run writes it
    _check_meta(meta_path, dict(meta))  # identical resume is fine
    with pytest.raises(SystemExit):
        _check_meta(meta_path, meta | {"engine_depth": 20})
