"""Deterministic explanation metrics — the free tier of the eval.

These need no LLM and no API spend, so they can run on every sweep and on
every prompt tweak. Each one approximates one dimension the LLM-judge
scores, using ground truth we already hold:

  theme_coverage      ~ judge dimension 1 (right idea)      <- theme tags
  piece_reference_errors ~ judge dimension 3 (hallucination) <- the board
  mate_consistency    ~ judge dimension 3 (hallucination)   <- engine line

They are PROXIES, not replacements. An explanation can print the word
"fork" without understanding the position (theme_coverage is gameable and
its precision is unknown), and none of these can score REASONING — whether
the causal story is right — which is exactly what the judge exists for and
what the RAG headline claims. Use these for fast iteration and regression
alarms; use the validated judge for any published number.

False-positive discipline: claims are checked against the root position AND
every position along the lines the explainer was shown, because "the rook
lands on f8" is legitimately about a future position in the line.
"""

import re
from dataclasses import dataclass

import chess

# Tactical themes worth checking, mapped to the vocabulary an explanation
# would plausibly use. Deliberately EXCLUDES context tags (middlegame,
# short, crushing, master...) which describe the puzzle, not an idea, and
# mateInN, which mate_consistency covers precisely.
THEME_VOCAB: dict[str, tuple[str, ...]] = {
    "fork": ("fork", "forks", "forking", "double attack", "two pieces at once"),
    "pin": ("pin", "pins", "pinned", "pinning"),
    "skewer": ("skewer", "skewers", "skewered", "x-ray", "through the"),
    "discoveredAttack": ("discover", "discovered attack", "unleash", "battery"),
    "discoveredCheck": ("discovered check", "discover", "unleash"),
    "doubleCheck": ("double check", "both pieces check", "two checks"),
    "backRankMate": ("back rank", "back-rank", "backrank", "first rank", "eighth rank"),
    "hangingPiece": ("hanging", "undefended", "unprotected", "loose piece", "en prise"),
    "trappedPiece": ("trapped", "no escape squares", "nowhere to go", "cornered"),
    "deflection": ("deflect", "deflection", "lure away", "drag away", "overloaded"),
    "attraction": ("attract", "lure", "draw the king", "decoy", "force the king"),
    "clearance": ("clear", "clearance", "vacate", "get out of the way", "open the line"),
    "interference": ("interference", "block the", "cut the", "interpose"),
    "sacrifice": ("sacrifice", "sacrifices", "sacrificing", "sac", "give up the", "offer"),
    "exposedKing": ("exposed king", "king is exposed", "airy", "no shelter", "vulnerable king"),
    "advancedPawn": ("advanced pawn", "passed pawn", "far advanced", "close to promoting"),
    "promotion": ("promot", "queening", "new queen"),
    "zugzwang": ("zugzwang", "must move", "any move loses", "running out of moves"),
    "xRayAttack": ("x-ray", "xray", "through the", "behind the"),
    "quietMove": ("quiet move", "quiet", "no check", "unhurried", "subtle"),
    "defensiveMove": ("defen", "hold", "resource", "save"),
    "capturingDefender": ("defender", "remove the guard", "removing the defender", "eliminat"),
    "kingsideAttack": ("kingside", "king side"),
    "queensideAttack": ("queenside", "queen side"),
    "attackingF2F7": ("f2", "f7", "weakest square", "weak square"),
    "operaMate": ("opera mate", "back rank", "mate with the rook"),
    "pillsburysMate": ("pillsbury", "mate with the rook"),
}

# Themes this module does not attempt (context, or covered elsewhere).
UNSCORED_THEMES = frozenset(
    [
        "middlegame",
        "endgame",
        "opening",
        "short",
        "long",
        "veryLong",
        "oneMove",
        "master",
        "masterVsMaster",
        "superGM",
        "crushing",
        "advantage",
        "equality",
        "mate",
        "mateIn1",
        "mateIn2",
        "mateIn3",
        "mateIn4",
        "mateIn5",
        "rookEndgame",
        "queenEndgame",
        "pawnEndgame",
        "bishopEndgame",
        "knightEndgame",
        "underPromotion",
        "intermezzo",
        "skewer2",
    ]
)

_PIECE_WORDS = {
    "king": chess.KING,
    "queen": chess.QUEEN,
    "rook": chess.ROOK,
    "bishop": chess.BISHOP,
    "knight": chess.KNIGHT,
    "pawn": chess.PAWN,
}

# "the rook on a8", "knight at f6" — a concrete, checkable placement claim.
_PLACEMENT_RE = re.compile(
    r"\b(king|queen|rook|bishop|knight|pawn)s?\s+(?:on|at)\s+([a-h][1-8])\b",
    re.IGNORECASE,
)

_MATE_CLAIM_RE = re.compile(r"\b(checkmate|mate in \w+|mated|#)\b", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class ThemeCoverage:
    scored: tuple[str, ...]
    """Tagged themes this module knows how to look for."""
    named: tuple[str, ...]
    """Of those, the ones whose vocabulary appears in the prose."""

    @property
    def applicable(self) -> bool:
        return bool(self.scored)

    @property
    def rate(self) -> float | None:
        return len(self.named) / len(self.scored) if self.scored else None


def check_theme_coverage(text: str, themes: list[str]) -> ThemeCoverage:
    """Does the prose use vocabulary matching the puzzle's tactical tags?

    A recall proxy only: presence of the word is necessary for a correct
    explanation, not sufficient. Themes with no lexicon are not scored, so
    a puzzle tagged only with context tags reports applicable=False rather
    than a misleading 0%.
    """
    lowered = text.lower()
    scored = tuple(t for t in themes if t in THEME_VOCAB)
    named = tuple(t for t in scored if any(w in lowered for w in THEME_VOCAB[t]))
    return ThemeCoverage(scored=scored, named=named)


def _reachable_placements(fen: str, pvs: list[list[str]]) -> set[tuple[int, int]]:
    """(piece_type, square) pairs true in the root or anywhere along a line."""
    seen: set[tuple[int, int]] = set()

    def snapshot(board: chess.Board) -> None:
        for square, piece in board.piece_map().items():
            seen.add((piece.piece_type, square))

    root = chess.Board(fen)
    snapshot(root)
    for pv in pvs:
        board = chess.Board(fen)
        for uci in pv:
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                raise ValueError(f"illegal move {uci} in position {board.fen()}")
            board.push(move)
            snapshot(board)
    return seen


@dataclass(frozen=True, slots=True)
class PlacementResult:
    claims: tuple[str, ...]
    errors: tuple[str, ...]
    """Claims like "rook on a8" true in no position along the given lines."""

    @property
    def clean(self) -> bool:
        return not self.errors


def check_piece_references(text: str, fen: str, pvs: list[list[str]]) -> PlacementResult:
    """Verify concrete "<piece> on <square>" claims against the real board.

    Catches the hallucination class the judge flagged by hand ("wins the
    rook on a8" when the rook is on c8) — deterministically and for free.
    """
    reachable = _reachable_placements(fen, pvs)
    claims: list[str] = []
    errors: list[str] = []
    for match in _PLACEMENT_RE.finditer(text):
        word, square_name = match.group(1).lower(), match.group(2).lower()
        claims.append(f"{word} on {square_name}")
        key = (_PIECE_WORDS[word], chess.parse_square(square_name))
        if key not in reachable:
            errors.append(f"{word} on {square_name}")
    return PlacementResult(claims=tuple(claims), errors=tuple(errors))


@dataclass(frozen=True, slots=True)
class MateConsistency:
    claimed: bool
    actual: bool

    @property
    def consistent(self) -> bool:
        return self.claimed == self.actual


def check_mate_consistency(text: str, lines) -> MateConsistency:
    """Prose should claim mate exactly when the engine found one.

    Both directions matter: inventing a mate is a hallucination, and
    missing a forced mate the engine handed over is a failure to explain
    the single most important fact in the position.
    """
    claimed = bool(_MATE_CLAIM_RE.search(text))
    actual = any(getattr(line, "mate", None) is not None for line in lines)
    return MateConsistency(claimed=claimed, actual=actual)
