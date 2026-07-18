"""Compose labeled board images from FEN + PNG sprites.

The core of the free-training-data trick: because we draw the board
ourselves, every image comes with a perfect per-square label grid. The
renderer aims at DIGITAL SCREENSHOT realism (axis-aligned grid, flat theme
colors, optional coordinates and last-move highlights) — physical boards are
out of scope by design.

Labels: 13 classes, row-major from a8..h1 (rank 8 first, like FEN):
index 0 = empty, 1-6 = white P N B R Q K, 7-12 = black P N B R Q K.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from pathlib import Path

import chess
from PIL import Image, ImageDraw

CLASSES = ["empty", "wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"]
CLASS_INDEX = {name: i for i, name in enumerate(CLASSES)}

PIECE_TO_CLASS = {
    (chess.WHITE, chess.PAWN): "wP",
    (chess.WHITE, chess.KNIGHT): "wN",
    (chess.WHITE, chess.BISHOP): "wB",
    (chess.WHITE, chess.ROOK): "wR",
    (chess.WHITE, chess.QUEEN): "wQ",
    (chess.WHITE, chess.KING): "wK",
    (chess.BLACK, chess.PAWN): "bP",
    (chess.BLACK, chess.KNIGHT): "bN",
    (chess.BLACK, chess.BISHOP): "bB",
    (chess.BLACK, chess.ROOK): "bR",
    (chess.BLACK, chess.QUEEN): "bQ",
    (chess.BLACK, chess.KING): "bK",
}

# (name, light, dark) — flat color pairs in the style of the big chess sites.
THEMES: list[tuple[str, str, str]] = [
    ("lichess-brown", "#f0d9b5", "#b58863"),
    ("lichess-blue", "#dee3e6", "#8ca2ad"),
    ("lichess-green", "#ffffdd", "#86a666"),
    ("club-green", "#eeeed2", "#769656"),
    ("walnut", "#e0c48c", "#9e6b3f"),
    ("ic-gray", "#dcdcdc", "#a8a8a8"),
    ("purple", "#e8e0ec", "#9f90b0"),
    ("winter-blue", "#e8edf9", "#b7c0d8"),
]

HIGHLIGHT = "#f7ec5e"  # last-move tint, blended over the square color


@dataclass
class RenderSpec:
    """Everything that determines one rendered board image."""

    fen: str
    piece_set: str
    theme: str = "lichess-brown"
    square_px: int = 60
    orientation_white: bool = True
    coordinates: bool = False
    highlight_squares: tuple[int, ...] = field(default_factory=tuple)  # chess.Square ints


def _blend(hex_color: str, tint: str, alpha: float = 0.5) -> tuple[int, int, int]:
    c = tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5))
    t = tuple(int(tint[i : i + 2], 16) for i in (1, 3, 5))
    return tuple(round(c[i] * (1 - alpha) + t[i] * alpha) for i in range(3))  # type: ignore[return-value]


class BoardRenderer:
    def __init__(self, sprites_dir: Path) -> None:
        self.sprites_dir = sprites_dir
        self._cache: dict[tuple[str, str, int], Image.Image] = {}

    def piece_sets(self) -> list[str]:
        return sorted(p.name for p in self.sprites_dir.iterdir() if p.is_dir())

    def _sprite(self, piece_set: str, code: str, size: int) -> Image.Image:
        key = (piece_set, code, size)
        if key not in self._cache:
            img = Image.open(self.sprites_dir / piece_set / f"{code}.png").convert("RGBA")
            self._cache[key] = img.resize((size, size), Image.LANCZOS)
        return self._cache[key]

    def render(self, spec: RenderSpec) -> tuple[Image.Image, list[list[int]]]:
        """Render one board -> (RGB image, 8x8 label grid).

        labels[iy][ix] describes the square drawn at IMAGE row iy, column ix
        (top-left origin) — i.e. exactly what a crop at that grid cell
        contains, regardless of orientation. Training crops and labels can
        therefore never disagree about orientation.
        """
        theme = next(t for t in THEMES if t[0] == spec.theme)
        board = chess.Board(spec.fen)
        px = spec.square_px
        img = Image.new("RGB", (8 * px, 8 * px))
        draw = ImageDraw.Draw(img)

        labels = [[0] * 8 for _ in range(8)]
        for rank_row in range(8):  # 0 = rank 8 (top of the label grid)
            for file_col in range(8):
                square = chess.square(file_col, 7 - rank_row)
                # Where this square lands in the IMAGE depends on orientation.
                if spec.orientation_white:
                    ix, iy = file_col, rank_row
                else:
                    ix, iy = 7 - file_col, 7 - rank_row
                is_light = (file_col + (7 - rank_row)) % 2 == 1
                color: str | tuple[int, int, int] = theme[1] if is_light else theme[2]
                if square in spec.highlight_squares:
                    color = _blend(theme[1] if is_light else theme[2], HIGHLIGHT)
                draw.rectangle((ix * px, iy * px, ix * px + px - 1, iy * px + px - 1), fill=color)
                piece = board.piece_at(square)
                if piece is not None:
                    code = PIECE_TO_CLASS[(piece.color, piece.piece_type)]
                    labels[iy][ix] = CLASS_INDEX[code]
                    sprite = self._sprite(spec.piece_set, code, px)
                    img.paste(sprite, (ix * px, iy * px), sprite)

        if spec.coordinates:
            self._draw_coordinates(draw, px, spec.orientation_white, theme)
        return img, labels

    def _draw_coordinates(
        self,
        draw: ImageDraw.ImageDraw,
        px: int,
        white_pov: bool,
        theme: tuple[str, str, str],
    ) -> None:
        files = "abcdefgh" if white_pov else "hgfedcba"
        ranks = "87654321" if white_pov else "12345678"
        for i, f in enumerate(files):
            # File letters along the bottom edge, on the square's contrast color.
            is_light = (i + 0) % 2 == 0  # bottom row alternates starting dark at a1-ish
            color = theme[2] if not is_light else theme[1]
            draw.text((i * px + 2, 8 * px - 12), f, fill=color)
        for i, r in enumerate(ranks):
            is_light = i % 2 == 0
            color = theme[1] if is_light else theme[2]
            draw.text((2, i * px + 2), r, fill=color)


def random_spec(fen: str, renderer: BoardRenderer, rng: random.Random) -> RenderSpec:
    """Sample a plausible-screenshot rendering of the given position."""
    board = chess.Board(fen)
    highlights: tuple[int, ...] = ()
    if rng.random() < 0.4:
        # Fake a "last move" pair of highlighted squares.
        squares = [sq for sq in chess.SQUARES if board.piece_at(sq) is None]
        occupied = [sq for sq in chess.SQUARES if board.piece_at(sq) is not None]
        if squares and occupied:
            highlights = (rng.choice(squares), rng.choice(occupied))
    return RenderSpec(
        fen=fen,
        piece_set=rng.choice(renderer.piece_sets()),
        theme=rng.choice(THEMES)[0],
        square_px=rng.randint(24, 80),
        orientation_white=rng.random() < 0.8,
        coordinates=rng.random() < 0.5,
        highlight_squares=highlights,
    )
