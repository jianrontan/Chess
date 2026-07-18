"""Rasterize the imported SVG piece sets to PNG sprites.

One-time preparation step: the board renderer (render.py) composes images
from these PNGs with Pillow only, so the cairo dependency is confined here.
Sprites are rendered at a generous base size and downscaled at compose time
(downscaling is cheap and clean; upscaling is blurry).
"""

from __future__ import annotations

from pathlib import Path

from vision.pieces import PIECE_CODES

BASE_SIZE = 128


def rasterize_all(pieces_dir: Path, sprites_dir: Path, size: int = BASE_SIZE) -> int:
    import cairosvg  # deferred: only this step needs cairo
    from PIL import Image

    count = 0
    for set_dir in sorted(p for p in pieces_dir.iterdir() if p.is_dir()):
        out = sprites_dir / set_dir.name
        out.mkdir(parents=True, exist_ok=True)
        for code in PIECE_CODES:
            png = out / f"{code}.png"
            if png.exists():
                continue
            svg = set_dir / f"{code}.svg"
            webp = set_dir / f"{code}.webp"
            if svg.is_file():
                cairosvg.svg2png(
                    url=str(svg),
                    write_to=str(png),
                    output_width=size,
                    output_height=size,
                )
            elif webp.is_file():
                Image.open(webp).convert("RGBA").resize((size, size)).save(png)
            else:
                continue
            count += 1
    return count


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Rasterize piece SVGs to PNG sprites")
    root = Path(__file__).resolve().parents[2] / "assets"
    parser.add_argument("--pieces", type=Path, default=root / "pieces")
    parser.add_argument("--dest", type=Path, default=root / "sprites")
    parser.add_argument("--size", type=int, default=BASE_SIZE)
    args = parser.parse_args()
    n = rasterize_all(args.pieces, args.dest, args.size)
    print(f"rasterized {n} sprites -> {args.dest}")


if __name__ == "__main__":
    main()
