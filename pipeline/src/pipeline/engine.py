"""Native Stockfish wrapper for batch ground-truth generation.

This is the pipeline-side engine (docs: the WASM build belongs to /web).
The binary is git-ignored and downloaded per machine into
pipeline/engines/; point STOCKFISH_PATH at it to override discovery.

Eval perspective: cp/mate on EngineLine are from the SIDE TO MOVE of the
analyzed position (UCI convention) — the same convention the web engine
client uses, so grading.py works identically on both.
"""

import os
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

import chess
import chess.engine

ENGINES_DIR = Path(__file__).resolve().parents[2] / "engines"


@dataclass(frozen=True, slots=True)
class EngineLine:
    multipv: int
    depth: int
    pv: tuple[str, ...]
    cp: int | None
    mate: int | None


def find_stockfish() -> Path:
    """Locate the native binary: $STOCKFISH_PATH, else pipeline/engines/."""
    env = os.environ.get("STOCKFISH_PATH")
    if env:
        path = Path(env)
        if not path.is_file():
            raise FileNotFoundError(f"STOCKFISH_PATH does not exist: {env}")
        return path
    candidates = [
        p
        for p in ENGINES_DIR.rglob("stockfish*")
        if p.is_file() and p.suffix in (".exe", "") and not p.name.endswith(".zip")
    ]
    if not candidates:
        raise FileNotFoundError(
            f"no Stockfish binary under {ENGINES_DIR} — download a release "
            "from github.com/official-stockfish/Stockfish or set STOCKFISH_PATH"
        )
    return sorted(candidates)[0]


def _to_line(info: chess.engine.InfoDict, board: chess.Board, multipv: int) -> EngineLine:
    score = info["score"].pov(board.turn)
    return EngineLine(
        multipv=multipv,
        depth=info.get("depth", 0),
        pv=tuple(m.uci() for m in info.get("pv", [])),
        cp=None if score.is_mate() else score.score(),
        mate=score.mate() if score.is_mate() else None,
    )


class Engine:
    """Context-managed UCI session around one native Stockfish process."""

    def __init__(self, path: Path | None = None, threads: int = 2, hash_mb: int = 256):
        self.path = path or find_stockfish()
        self._engine = chess.engine.SimpleEngine.popen_uci(str(self.path))
        self._engine.configure({"Threads": threads, "Hash": hash_mb})
        self.id_name: str = self._engine.id.get("name", "unknown")

    def analyse(self, fen: str, *, depth: int, multipv: int = 1) -> list[EngineLine]:
        """Top-k lines for a position at fixed depth."""
        board = chess.Board(fen)
        infos = self._engine.analyse(board, chess.engine.Limit(depth=depth), multipv=multipv)
        return [_to_line(info, board, i + 1) for i, info in enumerate(infos)]

    def analyse_move(self, fen: str, uci: str, *, depth: int) -> EngineLine:
        """Analyse one forced root move (the searchmoves equivalent)."""
        board = chess.Board(fen)
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {uci} in position {fen}")
        info = self._engine.analyse(board, chess.engine.Limit(depth=depth), root_moves=[move])
        line = _to_line(info, board, 1)
        # Guarantee the pv starts with the forced move even if the engine
        # returns an empty pv at very low depth.
        if not line.pv:
            line = EngineLine(multipv=1, depth=line.depth, pv=(uci,), cp=line.cp, mate=line.mate)
        return line

    def close(self) -> None:
        self._engine.quit()

    def __enter__(self) -> "Engine":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()
