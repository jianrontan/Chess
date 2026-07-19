"""Automatic (deterministic) checks on explanations.

Two of the three eval layers live here — the cheap ones that need no
judge:

1. Groundedness/legality: every move the prose mentions must come from
   the lines the LLM was actually given (the prompt's grounding rule
   "only mention moves that appear in the given lines"). Those lines were
   themselves replayed for legality, so groundedness implies legality.
   A violation = a hallucinated move, the hard failure mode.

2. Move-match: the engine's recommended move equals the puzzle solution
   OR is eval-equivalent to it (the engine may pick a different equally
   winning move). Near-100% by construction — a plumbing alarm for the
   trust chain, not a quality metric.

SAN-token caveat: a bare square like "e5" is ambiguous between the pawn
move e5 and prose about "the e5 pawn", so bare-square tokens are only
counted as move claims when written with a move number ("12. e4",
"3... e5"). Unambiguous move syntax (piece letter, capture, promotion,
castling) is always a claim.
"""

import re
from dataclasses import dataclass

import chess

from pipeline.grading import line_win_pct

# Unambiguous SAN move tokens: castling, piece moves, captures, promotions.
# The trailing (?!-[a-h][1-8]) rejects long-algebraic "Qb7-c8": there the
# leading token is the FROM square, not a move, and counting it as one
# reported a false hallucination on real output.
_DEFINITE_RE = re.compile(
    r"\b(O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?"
    r"|[a-h][18]=[QRBN])[+#]?(?!-[a-h][1-8])"
)
# Bare pawn pushes are claims only when numbered: "12. e4" / "3... e5".
# (?!\s*=) keeps "43. g8=Q+" from also matching as a bare push to g8 —
# the promotion itself is caught by _DEFINITE_RE, and double-counting it
# produced a false hallucination (g8 is not in the lines; g8=Q is).
_NUMBERED_PAWN_RE = re.compile(r"\b\d+\.(?:\.\.)?\s*([a-h][1-8])(?!\s*=)\b")

# Win% (mover perspective) within which two moves count as equally good.
EQUIV_WIN_PCT = 3.0


def normalize_san(san: str) -> str:
    """Strip check/mate suffixes so 'Qc8+' and 'Qc8' compare equal."""
    return san.rstrip("+#")


def extract_move_claims(text: str) -> list[str]:
    """All SAN tokens in prose that unambiguously claim a move."""
    claims = [m.group(1) for m in _DEFINITE_RE.finditer(text)]
    claims += [m.group(1) for m in _NUMBERED_PAWN_RE.finditer(text)]
    return [normalize_san(c) for c in claims]


def allowed_sans(fen: str, pvs: list[list[str]]) -> set[str]:
    """Every SAN that appears in the given lines (normalized).

    These are the only moves the prompt licenses the LLM to mention.
    """
    allowed: set[str] = set()
    for pv in pvs:
        board = chess.Board(fen)
        for uci in pv:
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                raise ValueError(f"illegal move {uci} in position {board.fen()}")
            allowed.add(normalize_san(board.san(move)))
            board.push(move)
    return allowed


@dataclass(frozen=True, slots=True)
class GroundednessResult:
    claims: tuple[str, ...]
    violations: tuple[str, ...]
    """Claimed moves that appear in none of the given lines."""

    @property
    def grounded(self) -> bool:
        return not self.violations


def check_groundedness(text: str, fen: str, pvs: list[list[str]]) -> GroundednessResult:
    allowed = allowed_sans(fen, pvs)
    claims = extract_move_claims(text)
    violations = tuple(c for c in claims if c not in allowed)
    return GroundednessResult(claims=tuple(claims), violations=violations)


@dataclass(frozen=True, slots=True)
class MoveMatchResult:
    engine_move: str
    solution_move: str
    exact: bool
    eval_equivalent: bool
    engine_win_pct: float
    solution_win_pct: float

    @property
    def matched(self) -> bool:
        return self.exact or self.eval_equivalent


def check_move_match(
    engine, fen: str, top_line, solution_uci: str, *, depth: int
) -> MoveMatchResult:
    """Engine top move vs puzzle solution, with eval-equivalence fallback.

    `engine` is an Engine (duck-typed for tests); `top_line` the multipv-1
    line already computed for `fen`. Win% is from the mover's perspective.
    """
    engine_move = top_line.pv[0]
    engine_win = line_win_pct(top_line.cp, top_line.mate)
    if engine_move == solution_uci:
        return MoveMatchResult(
            engine_move=engine_move,
            solution_move=solution_uci,
            exact=True,
            eval_equivalent=True,
            engine_win_pct=engine_win,
            solution_win_pct=engine_win,
        )
    solution_line = engine.analyse_move(fen, solution_uci, depth=depth)
    solution_win = line_win_pct(solution_line.cp, solution_line.mate)
    equivalent = abs(engine_win - solution_win) <= EQUIV_WIN_PCT
    return MoveMatchResult(
        engine_move=engine_move,
        solution_move=solution_uci,
        exact=False,
        eval_equivalent=equivalent,
        engine_win_pct=engine_win,
        solution_win_pct=solution_win,
    )
