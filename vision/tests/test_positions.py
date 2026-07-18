"""The random-position generator must honor the same material rules the web
editor enforces (promotion accounting, bishops per square color)."""

import random

import chess
import pytest

from vision.positions import random_position


def material_ok(board: chess.Board) -> bool:
    for color in (chess.WHITE, chess.BLACK):
        pawns = len(board.pieces(chess.PAWN, color))
        if pawns > 8:
            return False
        extras = max(0, len(board.pieces(chess.QUEEN, color)) - 1)
        extras += max(0, len(board.pieces(chess.ROOK, color)) - 2)
        extras += max(0, len(board.pieces(chess.KNIGHT, color)) - 2)
        light = dark = 0
        for sq in board.pieces(chess.BISHOP, color):
            if (chess.square_rank(sq) + chess.square_file(sq)) % 2 == 1:
                light += 1
            else:
                dark += 1
        extras += max(0, light - 1) + max(0, dark - 1)
        if extras > 8 - pawns:
            return False
    return True


@pytest.mark.parametrize("max_pieces", [2, 6, 15, 30])
def test_positions_valid_and_material_legal(max_pieces: int) -> None:
    rng = random.Random(max_pieces)
    for _ in range(50):
        fen = random_position(rng, max_pieces=max_pieces)
        board = chess.Board(fen)
        assert board.is_valid(), fen
        assert material_ok(board), fen


def test_sparse_cap_respected() -> None:
    rng = random.Random(1)
    for _ in range(50):
        board = chess.Board(random_position(rng, max_pieces=3))
        non_kings = sum(
            len(board.pieces(t, c))
            for c in (chess.WHITE, chess.BLACK)
            for t in (chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
        )
        assert non_kings <= 6  # 3 per side


def test_deterministic() -> None:
    assert random_position(random.Random(9)) == random_position(random.Random(9))
