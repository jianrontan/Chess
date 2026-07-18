"""Random material-legal positions for dataset coverage.

Puzzle positions are realistic but skew tactical/middlegame; this generator
fills the gaps (sparse endgames, odd-but-legal armies) while honoring the
same promotion-accounting rules the web editor enforces: per side, pawns <= 8
and every piece beyond the starting set costs a missing pawn, with bishops
counted per square color.
"""

from __future__ import annotations

import random

import chess

_LIGHT_SQUARES = [
    sq for sq in chess.SQUARES if (chess.square_rank(sq) + chess.square_file(sq)) % 2 == 1
]
_DARK_SQUARES = [
    sq for sq in chess.SQUARES if (chess.square_rank(sq) + chess.square_file(sq)) % 2 == 0
]


def _sample_army(rng: random.Random, max_pieces: int) -> list[tuple[int, bool]]:
    """One side's non-king pieces as (piece_type, wants_light_square) pairs.

    wants_light_square is only meaningful for bishops; other pieces ignore it.
    """
    pawns = rng.randint(0, 8)
    budget = 8 - pawns  # promotions available
    army: list[tuple[int, bool]] = [(chess.PAWN, False)] * pawns

    def take(initial: int) -> int:
        nonlocal budget
        count = rng.randint(0, initial + budget)
        budget -= max(0, count - initial)
        return count

    army += [(chess.QUEEN, False)] * take(1)
    army += [(chess.ROOK, False)] * take(2)
    army += [(chess.KNIGHT, False)] * take(2)
    # Bishops per square color: one original each, extras cost budget.
    for light in (True, False):
        army += [(chess.BISHOP, light)] * take(1)

    rng.shuffle(army)
    del army[max_pieces:]
    return army


def random_position(rng: random.Random, max_pieces: int = 30) -> str:
    """A material-legal, chess.js/python-chess-valid FEN (White to move).

    max_pieces caps the NON-KING pieces per side — low values produce the
    sparse endgames the classifier must not get lazy on.
    """
    for _ in range(200):  # rejection sampling; failures are rare
        board = chess.Board(None)
        squares = list(chess.SQUARES)
        rng.shuffle(squares)

        wk = squares.pop()
        bk = next(
            (sq for sq in squares if chess.square_distance(sq, wk) > 1),
            None,
        )
        if bk is None:
            continue
        squares.remove(bk)
        board.set_piece_at(wk, chess.Piece(chess.KING, chess.WHITE))
        board.set_piece_at(bk, chess.Piece(chess.KING, chess.BLACK))

        ok = True
        for color in (chess.WHITE, chess.BLACK):
            for piece_type, wants_light in _sample_army(rng, max_pieces):
                pool = squares
                if piece_type == chess.PAWN:
                    pool = [sq for sq in squares if 0 < chess.square_rank(sq) < 7]
                elif piece_type == chess.BISHOP:
                    wanted = _LIGHT_SQUARES if wants_light else _DARK_SQUARES
                    pool = [sq for sq in squares if sq in wanted]
                if not pool:
                    ok = False
                    break
                sq = rng.choice(pool)
                squares.remove(sq)
                board.set_piece_at(sq, chess.Piece(piece_type, color))
            if not ok:
                break
        if not ok:
            continue

        board.turn = chess.WHITE
        # is_valid() covers kings, pawn ranks, and the side-not-to-move-in-
        # check rule — the same class of checks the web editor applies.
        if board.is_valid():
            return board.fen()
    raise RuntimeError("could not generate a valid position")
