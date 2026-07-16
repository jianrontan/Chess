"""CLI: draw a stratified eval sample from the Lichess puzzle dump.

Usage (from pipeline/):
    uv run python -m pipeline.sample_puzzles \\
        --input data/lichess_db_puzzle.csv.zst \\
        --out data/eval_sample.jsonl --per-cell 5 --seed 0

Get the dump first (~250MB, CC0):
    curl -L -o data/lichess_db_puzzle.csv.zst \\
        https://database.lichess.org/lichess_db_puzzle.csv.zst

Every sampled puzzle is legality-validated (setup + full solution replayed)
before it is written — a corrupt row aborts the run. Output is JSONL with
`fen` being the position AFTER the setup move (what the solver faces); the
raw pre-setup FEN is kept as `csv_fen` for provenance.
"""

import argparse
import json
import sys
from pathlib import Path

import chess

from pipeline.puzzles import Puzzle, iter_puzzles, validate_puzzle
from pipeline.sampler import DEFAULT_THEMES, band_of, flatten, stratified_sample


def puzzle_record(puzzle: Puzzle) -> dict[str, object]:
    """JSON-serializable record for one validated puzzle."""
    validate_puzzle(puzzle)
    return {
        "puzzle_id": puzzle.puzzle_id,
        "fen": puzzle.puzzle_fen(),
        "csv_fen": puzzle.fen,
        "setup_move": puzzle.setup_move,
        "solution": list(puzzle.solution),
        "solver_color": "w" if puzzle.solver_color() == chess.WHITE else "b",
        "rating": puzzle.rating,
        "rating_band": band_of(puzzle.rating),
        "themes": sorted(puzzle.themes),
        "game_url": puzzle.game_url,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", type=Path, default=Path("data/lichess_db_puzzle.csv.zst"))
    parser.add_argument("--out", type=Path, default=Path("data/eval_sample.jsonl"))
    parser.add_argument("--per-cell", type=int, default=5)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--themes", nargs="+", default=list(DEFAULT_THEMES))
    parser.add_argument("--min-popularity", type=int, default=50)
    parser.add_argument("--min-nb-plays", type=int, default=100)
    parser.add_argument("--max-rating-deviation", type=int, default=110)
    args = parser.parse_args(argv)

    if not args.input.exists():
        print(
            f"{args.input} not found. Download the dump first:\n"
            "  curl -L -o data/lichess_db_puzzle.csv.zst "
            "https://database.lichess.org/lichess_db_puzzle.csv.zst",
            file=sys.stderr,
        )
        return 1

    sample = stratified_sample(
        iter_puzzles(args.input),
        per_cell=args.per_cell,
        themes=args.themes,
        seed=args.seed,
        min_popularity=args.min_popularity,
        min_nb_plays=args.min_nb_plays,
        max_rating_deviation=args.max_rating_deviation,
    )

    puzzles = flatten(sample)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for p in puzzles:
            f.write(json.dumps(puzzle_record(p)) + "\n")

    # Coverage report — empty cells are a finding, not something to hide.
    print(f"wrote {len(puzzles)} unique puzzles to {args.out}")
    empty = []
    for (theme, band), cell_puzzles in sorted(sample.items()):
        if cell_puzzles:
            print(f"  {theme:>18} {band:>9}: {len(cell_puzzles)}")
        else:
            empty.append(f"{theme}/{band}")
    if empty:
        print(f"  EMPTY cells ({len(empty)}): {', '.join(empty)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
