"""Puzzle parsing tests. The fixture is the contract: every row must survive
a full legality replay (setup + solution), or the fixture itself is corrupt."""

from pathlib import Path

import chess
import pytest
import zstandard

from pipeline.puzzles import Puzzle, iter_puzzles, parse_row, validate_puzzle

FIXTURE = Path(__file__).parent / "fixtures" / "puzzles_sample.csv"


def load_fixture() -> list[Puzzle]:
    return list(iter_puzzles(FIXTURE))


def test_fixture_parses_all_rows():
    puzzles = load_fixture()
    assert len(puzzles) == 6
    assert puzzles[0].puzzle_id == "fx001"
    assert puzzles[0].rating == 600
    assert "mateIn1" in puzzles[0].themes
    assert puzzles[0].opening_tags == ("Italian_Game",)
    assert puzzles[1].opening_tags == ()


def test_every_fixture_puzzle_is_fully_legal():
    """Setup move AND the whole solution replay without an illegal move."""
    for puzzle in load_fixture():
        validate_puzzle(puzzle)


def test_puzzle_fen_is_after_the_setup_move():
    """THE Lichess trap: the CSV FEN is before the opponent's setup move."""
    scholars = load_fixture()[0]
    board = chess.Board(scholars.puzzle_fen())
    # After the setup move g8f6 the knight stands on f6 and White is to move.
    assert board.piece_at(chess.F6) == chess.Piece(chess.KNIGHT, chess.BLACK)
    assert board.turn == chess.WHITE
    # The raw CSV FEN still has the knight at home — never analyze that one.
    assert chess.Board(scholars.fen).piece_at(chess.F6) is None


def test_solution_excludes_the_setup_move():
    scholars = load_fixture()[0]
    assert scholars.setup_move == "g8f6"
    assert scholars.solution == ("h5f7",)


def test_solver_color():
    puzzles = load_fixture()
    assert puzzles[0].solver_color() == chess.WHITE  # Black blundered, White mates
    assert puzzles[4].solver_color() == chess.BLACK  # White blundered g4, Black mates


def test_solution_mates_where_the_themes_say_so():
    for puzzle in load_fixture():
        if "mateIn1" in puzzle.themes:
            board = chess.Board(puzzle.puzzle_fen())
            board.push(chess.Move.from_uci(puzzle.solution[0]))
            assert board.is_checkmate(), f"{puzzle.puzzle_id} solution does not mate"


def test_parse_row_rejects_solutionless_puzzle():
    row = {
        "PuzzleId": "bad",
        "FEN": chess.STARTING_FEN,
        "Moves": "e2e4",  # setup move only, no solution
        "Rating": "1000",
        "RatingDeviation": "80",
        "Popularity": "90",
        "NbPlays": "100",
        "Themes": "opening",
        "GameUrl": "",
        "OpeningTags": "",
    }
    with pytest.raises(ValueError):
        parse_row(row)


def test_validate_puzzle_fails_loudly_on_illegal_solution():
    puzzle = parse_row(
        {
            "PuzzleId": "bad",
            "FEN": chess.STARTING_FEN,
            "Moves": "e2e4 e7e6 e4e6",  # e4e6 is not a legal move
            "Rating": "1000",
            "RatingDeviation": "80",
            "Popularity": "90",
            "NbPlays": "100",
            "Themes": "opening",
            "GameUrl": "",
            "OpeningTags": "",
        }
    )
    with pytest.raises(ValueError, match="illegal move"):
        validate_puzzle(puzzle)


def test_iter_puzzles_reads_zst(tmp_path: Path):
    """The real dump is .csv.zst — compress the fixture and stream it back."""
    compressed = tmp_path / "sample.csv.zst"
    compressed.write_bytes(zstandard.ZstdCompressor().compress(FIXTURE.read_bytes()))
    assert [p.puzzle_id for p in iter_puzzles(compressed)] == [p.puzzle_id for p in load_fixture()]


def test_iter_puzzles_rejects_wrong_columns(tmp_path: Path):
    bad = tmp_path / "bad.csv"
    bad.write_text("Id,Fen\nx,y\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unexpected columns"):
        list(iter_puzzles(bad))
