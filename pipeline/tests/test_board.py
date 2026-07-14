"""Smoke tests: python-chess works and legality checking behaves."""

import chess
import pytest

from pipeline.board import apply_moves, board_from_fen, is_legal_move

START_FEN = chess.STARTING_FEN


def test_board_from_fen_roundtrip():
    board = board_from_fen(START_FEN)
    assert board.fen() == START_FEN


def test_invalid_fen_raises():
    with pytest.raises(ValueError):
        board_from_fen("not a fen")


def test_legal_move_accepted():
    assert is_legal_move(START_FEN, "e2e4")


def test_illegal_move_rejected():
    assert not is_legal_move(START_FEN, "e2e5")


def test_garbage_move_rejected():
    assert not is_legal_move(START_FEN, "zz9x")


def test_apply_moves_replays_a_line():
    # Scholar's mate: the board must track state across moves.
    board = apply_moves(START_FEN, ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"])
    assert board.is_checkmate()


def test_apply_moves_rejects_illegal_line():
    with pytest.raises(ValueError, match="illegal move"):
        apply_moves(START_FEN, ["e2e4", "e2e4"])
