"""Stratified sampling of puzzles by theme x rating band.

Streaming (single pass, reservoir per cell) so the full 6M-row file can be
sampled on the homelab without loading it into memory. Deterministic for a
given seed AND input order — the Lichess dump is sorted by PuzzleId, so
re-running on the same file reproduces the same sample.

A puzzle with several requested themes is a candidate for each of those
cells; flatten() dedupes by puzzle_id at the end. Quality filters follow
Lichess community practice: popularity is -100..100, rating deviation
under ~110 means the rating has converged.
"""

import random
from collections.abc import Iterable
from dataclasses import dataclass, field

from pipeline.puzzles import Puzzle

RATING_BANDS: tuple[tuple[int, int], ...] = (
    (0, 1200),
    (1200, 1800),
    (1800, 2400),
    (2400, 4000),
)

# Curated eval themes: tactical motifs the explainer should be able to name,
# plus phase tags. Lichess theme tags are noisy — this is the error floor
# recorded in DECISIONS.md, not something sampling can fix.
DEFAULT_THEMES: tuple[str, ...] = (
    "mateIn1",
    "mateIn2",
    "fork",
    "pin",
    "skewer",
    "hangingPiece",
    "discoveredAttack",
    "backRankMate",
    "sacrifice",
    "endgame",
)


def band_label(lo: int, hi: int) -> str:
    return f"{lo}-{hi - 1}"


def band_of(rating: int, bands: tuple[tuple[int, int], ...] = RATING_BANDS) -> str | None:
    """Label of the band containing `rating` (lo inclusive, hi exclusive)."""
    for lo, hi in bands:
        if lo <= rating < hi:
            return band_label(lo, hi)
    return None


@dataclass
class _Reservoir:
    """Standard reservoir sample of size k (Algorithm R)."""

    k: int
    seen: int = 0
    items: list[Puzzle] = field(default_factory=list)

    def offer(self, puzzle: Puzzle, rng: random.Random) -> None:
        self.seen += 1
        if len(self.items) < self.k:
            self.items.append(puzzle)
            return
        j = rng.randrange(self.seen)
        if j < self.k:
            self.items[j] = puzzle


def stratified_sample(
    puzzles: Iterable[Puzzle],
    per_cell: int,
    themes: Iterable[str] = DEFAULT_THEMES,
    bands: tuple[tuple[int, int], ...] = RATING_BANDS,
    seed: int = 0,
    min_popularity: int = 50,
    min_nb_plays: int = 100,
    max_rating_deviation: int = 110,
) -> dict[tuple[str, str], list[Puzzle]]:
    """One streaming pass; returns {(theme, band_label): [puzzles]}.

    Cells that had no candidates are present with an empty list, so the
    caller can report coverage gaps instead of silently missing a stratum
    (the "no silent caps" rule).
    """
    theme_list = list(themes)
    rng = random.Random(seed)
    reservoirs: dict[tuple[str, str], _Reservoir] = {
        (t, band_label(lo, hi)): _Reservoir(per_cell) for t in theme_list for lo, hi in bands
    }

    for p in puzzles:
        if p.popularity < min_popularity:
            continue
        if p.nb_plays < min_nb_plays:
            continue
        if p.rating_deviation > max_rating_deviation:
            continue
        band = band_of(p.rating, bands)
        if band is None:
            continue
        for theme in p.themes:
            cell = (theme, band)
            reservoir = reservoirs.get(cell)
            if reservoir is not None:
                reservoir.offer(p, rng)

    return {cell: r.items for cell, r in reservoirs.items()}


def flatten(sample: dict[tuple[str, str], list[Puzzle]]) -> list[Puzzle]:
    """Unique puzzles across all cells, sorted by puzzle_id for stable output."""
    unique: dict[str, Puzzle] = {}
    for puzzles in sample.values():
        for p in puzzles:
            unique[p.puzzle_id] = p
    return sorted(unique.values(), key=lambda p: p.puzzle_id)
