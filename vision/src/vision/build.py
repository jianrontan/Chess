"""CLI: build the full sharded dataset.

FEN sources are mixed deliberately:
- puzzle FENs (realistic tactical positions) from a text file, one per line
- random material-legal positions, half of them sparse (max 6 non-king
  pieces per side) — endgames are oversampled on purpose, they're where
  square classifiers get lazy and where scans matter most
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

from vision.dataset import build_split
from vision.positions import random_position
from vision.render import BoardRenderer


def gather_fens(puzzle_file: Path | None, boards: int, rng: random.Random) -> list[str]:
    fens: list[str] = []
    if puzzle_file and puzzle_file.is_file():
        pool = [line.strip() for line in puzzle_file.read_text().splitlines() if line.strip()]
        rng.shuffle(pool)
        fens += pool[: boards // 2]
    while len(fens) < boards:
        sparse = rng.random() < 0.5
        fens.append(random_position(rng, max_pieces=rng.randint(2, 6) if sparse else 30))
    rng.shuffle(fens)
    return fens[:boards]


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Build the vision training dataset")
    parser.add_argument("--puzzle-fens", type=Path, default=None, help="text file, one FEN/line")
    parser.add_argument("--out", type=Path, default=root / "data")
    parser.add_argument("--train-boards", type=int, default=40_000)
    parser.add_argument("--heldout-boards", type=int, default=4_000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    renderer = BoardRenderer(root / "assets" / "sprites")
    rng = random.Random(args.seed)

    # Fixed per-split offsets: hash() is salted per interpreter run and would
    # silently break reproducibility.
    for offset, (split, boards) in enumerate(
        (("train", args.train_boards), ("heldout", args.heldout_boards))
    ):
        fens = gather_fens(args.puzzle_fens, boards, rng)
        manifest = build_split(fens, renderer, args.out, split, seed=args.seed + offset)
        print(
            f"{split}: {manifest['boards']} boards, {manifest['squares']} squares, "
            f"{manifest['shards']} shards"
        )


if __name__ == "__main__":
    main()
