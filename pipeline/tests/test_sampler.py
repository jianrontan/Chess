"""Sampler tests use synthetic puzzles — sampling logic doesn't need real
chess, only metadata. Legality of sampled output is covered by
sample_puzzles.puzzle_record(), tested in test_sample_cli.py."""

import chess

from pipeline.puzzles import Puzzle
from pipeline.sampler import RATING_BANDS, band_of, flatten, stratified_sample


def make_puzzle(
    puzzle_id: str,
    rating: int = 1500,
    themes: tuple[str, ...] = ("fork",),
    popularity: int = 90,
    nb_plays: int = 1000,
    rating_deviation: int = 80,
) -> Puzzle:
    return Puzzle(
        puzzle_id=puzzle_id,
        fen=chess.STARTING_FEN,
        moves=("e2e4", "e7e5"),
        rating=rating,
        rating_deviation=rating_deviation,
        popularity=popularity,
        nb_plays=nb_plays,
        themes=frozenset(themes),
        game_url="",
        opening_tags=(),
    )


def test_band_of_edges():
    assert band_of(0) == "0-1199"
    assert band_of(1199) == "0-1199"
    assert band_of(1200) == "1200-1799"  # lo inclusive, hi exclusive
    assert band_of(2399) == "1800-2399"
    assert band_of(2400) == "2400-3999"
    assert band_of(4000) is None


def test_per_cell_cap_and_empty_cells_reported():
    puzzles = [make_puzzle(f"p{i}", rating=1500, themes=("fork",)) for i in range(50)]
    sample = stratified_sample(puzzles, per_cell=5, themes=["fork", "pin"])
    assert len(sample[("fork", "1200-1799")]) == 5
    # Every requested cell exists, even with zero candidates.
    assert sample[("pin", "1200-1799")] == []
    assert len(sample) == 2 * len(RATING_BANDS)


def test_deterministic_for_same_seed_and_order():
    puzzles = [make_puzzle(f"p{i}") for i in range(200)]
    ids1 = [p.puzzle_id for p in flatten(stratified_sample(puzzles, per_cell=3, seed=7))]
    ids2 = [p.puzzle_id for p in flatten(stratified_sample(puzzles, per_cell=3, seed=7))]
    ids3 = [p.puzzle_id for p in flatten(stratified_sample(puzzles, per_cell=3, seed=8))]
    assert ids1 == ids2
    assert ids1 != ids3  # 200-choose-3 collision odds are negligible


def test_quality_filters_exclude():
    puzzles = [
        make_puzzle("lowpop", popularity=10),
        make_puzzle("fewplays", nb_plays=5),
        make_puzzle("noisy", rating_deviation=200),
        make_puzzle("good"),
    ]
    sample = stratified_sample(puzzles, per_cell=10, themes=["fork"])
    assert [p.puzzle_id for p in sample[("fork", "1200-1799")]] == ["good"]


def test_multi_theme_puzzle_lands_in_both_cells_but_flattens_once():
    puzzles = [make_puzzle("both", themes=("fork", "pin"))]
    sample = stratified_sample(puzzles, per_cell=5, themes=["fork", "pin"])
    assert [p.puzzle_id for p in sample[("fork", "1200-1799")]] == ["both"]
    assert [p.puzzle_id for p in sample[("pin", "1200-1799")]] == ["both"]
    assert len(flatten(sample)) == 1


def test_unrequested_themes_are_ignored():
    puzzles = [make_puzzle("other", themes=("zugzwang",))]
    sample = stratified_sample(puzzles, per_cell=5, themes=["fork"])
    assert flatten(sample) == []
