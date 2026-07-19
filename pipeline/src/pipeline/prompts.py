"""Builds the explanation prompt from engine output.

Python port of web/worker/lib/prompt.ts. Both consume the SAME template
file (prompts/explain.v1.json at the repo root) so the deployed prompt and
the evaluated prompt can never drift; this module must serialize engine
lines exactly the way the Worker does (SAN move lists, eval phrases) so an
eval sweep measures the prompt that prod actually sends.

Eval perspective: cp/mate on a line are from the side to move of the
analyzed position (UCI convention); eval_phrase converts to White-centric
prose the same way the Worker does.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

import chess

REPO_ROOT = Path(__file__).resolve().parents[3]
TEMPLATE_PATH = REPO_ROOT / "prompts" / "explain.v2.json"

# Piece-list order. Must match pieceList() in web/worker/lib/prompt.ts —
# the two are pinned to the same golden strings on both sides, because a
# prompt that differs between prod and the harness means the eval is not
# measuring the deployed system.
_PIECE_ORDER: tuple[tuple[int, str], ...] = (
    (chess.KING, "K"),
    (chess.QUEEN, "Q"),
    (chess.ROOK, "R"),
    (chess.BISHOP, "B"),
    (chess.KNIGHT, "N"),
)

_CLASS_PHRASES = {
    "best": "the best move",
    "good": "a good move",
    "inaccuracy": "an inaccuracy",
    "mistake": "a mistake",
    "blunder": "a blunder",
}


def load_template(path: Path = TEMPLATE_PATH) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def fill(template: str, variables: dict[str, str]) -> str:
    """Replace {{name}} placeholders; raise on any missing variable."""

    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in variables:
            raise KeyError(f"missing template variable: {name}")
        return variables[name]

    return re.sub(r"\{\{(\w+)\}\}", sub, template)


def piece_list(fen: str) -> str:
    """Exactly where every piece stands, one line per colour.

    Exists because the model demonstrably misreads raw FEN: 8.1% of v1
    explanations asserted a placement that was not on the board. Pieces
    are listed in K/Q/R/B/N order then pawns, each group sorted by square,
    so the string is deterministic and diffable.
    """
    board = chess.Board(fen)
    lines: list[str] = []
    for color, name in ((chess.WHITE, "White"), (chess.BLACK, "Black")):
        parts: list[str] = []
        for piece_type, letter in _PIECE_ORDER:
            squares = sorted(chess.square_name(s) for s in board.pieces(piece_type, color))
            parts.extend(f"{letter}{square}" for square in squares)
        pawns = sorted(chess.square_name(s) for s in board.pieces(chess.PAWN, color))
        if pawns:
            parts.append("pawns " + " ".join(pawns))
        lines.append(f"{name}: {', '.join(parts) if parts else '(none)'}")
    return "\n".join(lines)


def pv_to_san(fen: str, pv: list[str]) -> str:
    """Replay a PV from `fen`, returning "23. Qc8+ Kxc8 24. Rf8#" style SAN.

    Raises ValueError on an illegal move — engine output that fails here is
    a harness bug, never something to skip silently.
    """
    board = chess.Board(fen)
    parts: list[str] = []
    for uci in pv:
        move_no = board.fullmove_number
        is_white = board.turn == chess.WHITE
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {uci} in position {board.fen()}")
        san = board.san(move)
        board.push(move)
        if is_white:
            parts.append(f"{move_no}. {san}")
        elif not parts:
            parts.append(f"{move_no}... {san}")
        else:
            parts.append(san)
    return " ".join(parts)


def _fmt_pawns(pawns: float) -> str:
    sign = "+" if pawns > 0 else ""
    return f"{sign}{pawns:.1f}"


def eval_phrase(cp: int | None, mate: int | None, side_to_move: str) -> str:
    """Human phrase for a line's eval, White-centric (port of evalPhrase)."""
    sign = 1 if side_to_move == "w" else -1
    if mate is not None:
        m = mate * sign
        return f"White mates in {abs(m)}" if m > 0 else f"Black mates in {abs(m)}"
    pawns = (cp or 0) * sign / 100
    abs_pawns = abs(pawns)
    who = "White" if pawns >= 0 else "Black"
    if abs_pawns < 0.3:
        return "roughly equal"
    if abs_pawns < 0.9:
        return f"slightly better for {who} ({_fmt_pawns(pawns)})"
    if abs_pawns < 2.0:
        return f"clearly better for {who} ({_fmt_pawns(pawns)})"
    return f"winning for {who} ({_fmt_pawns(pawns)})"


@dataclass(frozen=True, slots=True)
class BuiltPrompt:
    system: str
    user: str
    prompt_version: str


def _side_to_move(fen: str) -> str:
    field = fen.split(" ")[1]
    if field not in ("w", "b"):
        raise ValueError(f"invalid FEN side-to-move field: {fen}")
    return field


def build_candidates_prompt(
    fen: str,
    lines: list,  # EngineLine-like: .multipv .depth .pv .cp .mate
    template: dict | None = None,
) -> BuiltPrompt:
    """Port of buildPrompt (mode "candidates") in prompt.ts."""
    tpl = template or load_template()
    stm = _side_to_move(fen)
    side_name = "White" if stm == "w" else "Black"
    rows: list[str] = []
    max_depth = 0
    for line in lines:
        san = pv_to_san(fen, list(line.pv))
        max_depth = max(max_depth, line.depth)
        rows.append(f"{line.multipv}. {san} — {eval_phrase(line.cp, line.mate, stm)}")
    user = fill(
        tpl["user"]["candidates"],
        {
            "fen": fen,
            "side_to_move": side_name,
            "pieces": piece_list(fen),
            "depth": str(max_depth),
            "candidates": "\n".join(rows),
            "retrieval": "",
        },
    )
    return BuiltPrompt(system=tpl["system"], user=user, prompt_version=tpl["version"])


def build_grade_prompt(
    fen: str,
    played_move_uci: str,
    move_class: str,
    win_pct_before: float,
    win_pct_after: float,
    played_line,  # EngineLine-like (pv starts with the played move)
    best_line,  # EngineLine-like
    template: dict | None = None,
) -> BuiltPrompt:
    """Port of buildPrompt (mode "grade") in prompt.ts."""
    tpl = template or load_template()
    stm = _side_to_move(fen)
    side_name = "White" if stm == "w" else "Black"
    played_san = pv_to_san(fen, list(played_line.pv))
    best_san = pv_to_san(fen, list(best_line.pv))
    played_move_san = pv_to_san(fen, [played_move_uci])
    user = fill(
        tpl["user"]["grade"],
        {
            "fen": fen,
            "side_to_move": side_name,
            "pieces": piece_list(fen),
            "played_move": played_move_san,
            "move_class_phrase": _CLASS_PHRASES[move_class],
            "win_before": f"{win_pct_before:.0f}",
            "win_after": f"{win_pct_after:.0f}",
            "played_line": f"{played_san} — {eval_phrase(played_line.cp, played_line.mate, stm)}",
            "best_line": f"{best_san} — {eval_phrase(best_line.cp, best_line.mate, stm)}",
            "retrieval": "",
        },
    )
    return BuiltPrompt(system=tpl["system"], user=user, prompt_version=tpl["version"])
