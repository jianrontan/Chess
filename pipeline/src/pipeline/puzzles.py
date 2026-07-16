"""Lichess puzzle database parsing.

CSV columns: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,
Themes,GameUrl,OpeningTags

THE trap (docs/DECISIONS.md, review correction 11): the CSV `FEN` is the
position BEFORE the opponent's setup move. `Moves` is space-separated UCI
where moves[0] is that setup move and moves[1:] alternate solver/opponent —
the solver answers from the position AFTER the setup move. Always present
`puzzle_fen()` to downstream code, never the raw CSV FEN.

Download (~250MB zst, CC0): https://database.lichess.org/lichess_db_puzzle.csv.zst
"""

import csv
import io
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import chess
import zstandard

from pipeline.board import apply_moves

EXPECTED_COLUMNS = (
    "PuzzleId",
    "FEN",
    "Moves",
    "Rating",
    "RatingDeviation",
    "Popularity",
    "NbPlays",
    "Themes",
    "GameUrl",
    "OpeningTags",
)


@dataclass(frozen=True, slots=True)
class Puzzle:
    puzzle_id: str
    fen: str
    """Position BEFORE the setup move — raw CSV value, do not analyze this."""
    moves: tuple[str, ...]
    """UCI moves: moves[0] is the opponent's setup move, moves[1:] the solution."""
    rating: int
    rating_deviation: int
    popularity: int
    """Lichess popularity score, -100..100."""
    nb_plays: int
    themes: frozenset[str]
    game_url: str
    opening_tags: tuple[str, ...]

    @property
    def setup_move(self) -> str:
        return self.moves[0]

    @property
    def solution(self) -> tuple[str, ...]:
        """Moves the solver plays (odd plies are the opponent's replies)."""
        return self.moves[1:]

    def puzzle_fen(self) -> str:
        """The position the solver actually faces (after the setup move)."""
        return apply_moves(self.fen, [self.setup_move]).fen()

    def solver_color(self) -> chess.Color:
        """Side to move after the setup move — the side solving the puzzle."""
        return apply_moves(self.fen, [self.setup_move]).turn


def parse_row(row: dict[str, str]) -> Puzzle:
    """Parse one csv.DictReader row. Raises ValueError on malformed data.

    Structural validation only — move legality is checked separately by
    validate_puzzle(), because replaying 6M rows is batch work while parsing
    is needed on every pass over the file.
    """
    try:
        moves = tuple(row["Moves"].split())
        if len(moves) < 2:
            raise ValueError(f"puzzle {row.get('PuzzleId')}: needs a setup move + solution")
        return Puzzle(
            puzzle_id=row["PuzzleId"],
            fen=row["FEN"],
            moves=moves,
            rating=int(row["Rating"]),
            rating_deviation=int(row["RatingDeviation"]),
            popularity=int(row["Popularity"]),
            nb_plays=int(row["NbPlays"]),
            themes=frozenset(row["Themes"].split()),
            game_url=row["GameUrl"],
            opening_tags=tuple((row.get("OpeningTags") or "").split()),
        )
    except (KeyError, TypeError) as e:
        raise ValueError(f"malformed puzzle row: {row}") from e


def validate_puzzle(puzzle: Puzzle) -> None:
    """Replay ALL moves (setup + solution) for legality. Raises ValueError.

    This is the ground-truth lever: a fixture or sampled puzzle that fails
    here is corrupt and must fail loudly, never be silently skipped.
    """
    apply_moves(puzzle.fen, list(puzzle.moves))


def iter_puzzles(path: str | Path) -> Iterator[Puzzle]:
    """Stream puzzles from a Lichess CSV (.csv or .csv.zst), constant memory."""
    path = Path(path)
    if path.suffix == ".zst":
        with path.open("rb") as raw:
            reader = zstandard.ZstdDecompressor().stream_reader(raw)
            text = io.TextIOWrapper(reader, encoding="utf-8", newline="")
            yield from _iter_csv(text, path)
    else:
        with path.open(encoding="utf-8", newline="") as text:
            yield from _iter_csv(text, path)


def _iter_csv(text: io.TextIOBase, path: Path) -> Iterator[Puzzle]:
    reader = csv.DictReader(text)
    if reader.fieldnames is None or tuple(reader.fieldnames) != EXPECTED_COLUMNS:
        raise ValueError(
            f"{path}: unexpected columns {reader.fieldnames} — expected {EXPECTED_COLUMNS}"
        )
    for row in reader:
        yield parse_row(row)
