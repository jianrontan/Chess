"""Renderer round-trip: the label grid must reconstruct the FEN exactly."""

import random
from pathlib import Path

import chess
import pytest

from vision.render import CLASSES, THEMES, BoardRenderer, RenderSpec, random_spec

SPRITES = Path(__file__).resolve().parents[1] / "assets" / "sprites"

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
# An asymmetric middlegame-ish position so orientation errors can't hide.
MIDGAME = "r1bq1rk1/pp2npbp/2np2p1/2p1p3/2P1P3/2NP1NP1/PP3PBP/R1BQ1RK1 w - - 0 9"

pytestmark = pytest.mark.skipif(
    not SPRITES.is_dir(), reason="sprites not rasterized (run vision.sprites first)"
)


@pytest.fixture(scope="module")
def renderer() -> BoardRenderer:
    return BoardRenderer(SPRITES)


def labels_to_board_fen(labels: list[list[int]], orientation_white: bool) -> str:
    """Reconstruct the FEN board field from an image-ordered label grid."""
    board = chess.Board(None)
    for iy in range(8):
        for ix in range(8):
            cls = CLASSES[labels[iy][ix]]
            if cls == "empty":
                continue
            if orientation_white:
                file_col, rank_row = ix, iy
            else:
                file_col, rank_row = 7 - ix, 7 - iy
            square = chess.square(file_col, 7 - rank_row)
            color = chess.WHITE if cls[0] == "w" else chess.BLACK
            piece_type = {"P": 1, "N": 2, "B": 3, "R": 4, "Q": 5, "K": 6}[cls[1]]
            board.set_piece_at(square, chess.Piece(piece_type, color))
    return board.board_fen()


def test_roundtrip_white_pov(renderer: BoardRenderer) -> None:
    img, labels = renderer.render(RenderSpec(fen=MIDGAME, piece_set="cburnett"))
    assert img.size == (480, 480)
    assert labels_to_board_fen(labels, True) == chess.Board(MIDGAME).board_fen()


def test_roundtrip_black_pov(renderer: BoardRenderer) -> None:
    _, labels = renderer.render(
        RenderSpec(fen=MIDGAME, piece_set="merida", orientation_white=False)
    )
    assert labels_to_board_fen(labels, False) == chess.Board(MIDGAME).board_fen()


def test_piece_squares_differ_from_empty_render(renderer: BoardRenderer) -> None:
    """Sprites must actually land on the image: rendering the start position
    differs from rendering an empty board on every occupied square."""
    spec = RenderSpec(fen=START, piece_set="cburnett", square_px=40)
    empty_spec = RenderSpec(fen="8/8/8/8/8/8/8/8 w - - 0 1", piece_set="cburnett", square_px=40)
    img, labels = renderer.render(spec)
    empty_img, _ = renderer.render(empty_spec)
    for iy in range(8):
        for ix in range(8):
            a = img.crop((ix * 40, iy * 40, ix * 40 + 40, iy * 40 + 40))
            b = empty_img.crop((ix * 40, iy * 40, ix * 40 + 40, iy * 40 + 40))
            occupied = labels[iy][ix] != 0
            assert (a.tobytes() != b.tobytes()) == occupied, f"square image ({ix},{iy})"


def test_every_piece_set_renders(renderer: BoardRenderer) -> None:
    sets = renderer.piece_sets()
    assert len(sets) >= 30
    for name in sets:
        img, labels = renderer.render(RenderSpec(fen=START, piece_set=name, square_px=32))
        assert img.size == (256, 256)
        assert sum(1 for row in labels for v in row if v != 0) == 32


def test_all_themes_and_options_render(renderer: BoardRenderer) -> None:
    for theme, _, _ in THEMES:
        img, _ = renderer.render(
            RenderSpec(
                fen=MIDGAME,
                piece_set="staunty",
                theme=theme,
                coordinates=True,
                highlight_squares=(chess.E4, chess.E5),
                square_px=48,
            )
        )
        assert img.size == (384, 384)


def test_random_spec_deterministic(renderer: BoardRenderer) -> None:
    a = random_spec(START, renderer, random.Random(7))
    b = random_spec(START, renderer, random.Random(7))
    assert a == b
