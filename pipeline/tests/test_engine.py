"""Native Stockfish integration — skipped when no binary is installed.

CI has no engine; locally (and on the homelab) these prove the wrapper
speaks UCI correctly: mate detection, multipv ordering, forced root moves.
"""

import pytest

from pipeline.engine import Engine, find_stockfish

try:
    find_stockfish()
    HAVE_ENGINE = True
except FileNotFoundError:
    HAVE_ENGINE = False

pytestmark = pytest.mark.skipif(not HAVE_ENGINE, reason="no native Stockfish binary")

MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24"


@pytest.fixture(scope="module")
def engine():
    with Engine(threads=1, hash_mb=64) as e:
        yield e


def test_finds_forced_mate(engine):
    lines = engine.analyse(MATE_FEN, depth=12, multipv=2)
    assert lines[0].multipv == 1
    assert lines[0].mate == 2
    assert lines[0].pv[0] == "h3c8"
    assert len(lines) == 2


def test_analyse_move_forces_root(engine):
    line = engine.analyse_move(MATE_FEN, "f1f8", depth=10)
    assert line.pv[0] == "f1f8"
    # Rf8+?? just loses the rook to Rxf8 — must NOT read as mate for White.
    assert line.mate is None or line.mate < 0


def test_eval_perspective_is_side_to_move(engine):
    # Startpos, White to move: near-zero cp for the mover.
    start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    line = engine.analyse(start, depth=10, multipv=1)[0]
    assert line.mate is None
    assert abs(line.cp or 0) < 150
