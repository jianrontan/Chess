"""Core board utilities: FEN handling and move legality.

Legality checking is the project's ground-truth lever — every downstream
component (feature extraction, eval harness) leans on these helpers.
"""

import chess


def board_from_fen(fen: str) -> chess.Board:
    """Parse a FEN string into a board. Raises ValueError on invalid FEN."""
    return chess.Board(fen)


def is_legal_move(fen: str, uci: str) -> bool:
    """Check whether a UCI move string is legal in the given position."""
    board = board_from_fen(fen)
    try:
        move = chess.Move.from_uci(uci)
    except chess.InvalidMoveError:
        return False
    return move in board.legal_moves


def apply_moves(fen: str, ucis: list[str]) -> chess.Board:
    """Apply a sequence of UCI moves to a position, validating each.

    Used to replay Lichess puzzle setup moves. Raises ValueError on an
    illegal move so bad fixtures fail loudly.
    """
    board = board_from_fen(fen)
    for uci in ucis:
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {uci} in position {board.fen()}")
        board.push(move)
    return board
