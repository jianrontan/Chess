"""Browser-based hand-labeling UI for the judge validation gate.

    uv run python -m pipeline.label_web --run data/eval_runs/gate-v2.jsonl

Opens a local page at http://127.0.0.1:8765 with a properly rendered
board. Same job order (seeded shuffle), same labels file, same rubric as
pipeline.label — the two are interchangeable mid-session.

Why this is NOT a page in web/: it must write label files to disk, which
a static-exported Next page cannot do, and living outside the app means
it can never be deployed to production by accident. Python stdlib only —
no new dependencies, no build step.

The judge's verdict is never sent to the browser. Anchoring the human to
a machine score inflates the agreement number the gate depends on.
"""

import argparse
import json
import random
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import chess

from pipeline.judge_eval import _jobs_from_record, _side_name

PAGE_PATH = Path(__file__).with_name("label_page.html")


def build_steps(fen: str, ucis: list[str]) -> tuple[list[dict], str]:
    """Positions along the main line, plus the real terminal status.

    Same purpose as walk_line() in pipeline.label: the labeler must be
    able to check "this is checkmate" against python-chess rather than
    against the explanation being graded.
    """
    board = chess.Board(fen)
    steps = [{"san": "", "fen": board.fen()}]
    for uci in ucis:
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            break
        san = board.san(move)
        number = board.fullmove_number
        dots = "." if board.turn == chess.WHITE else "..."
        board.push(move)
        steps.append({"san": f"{number}{dots} {san}", "fen": board.fen()})
    if board.is_checkmate():
        winner = "White" if board.turn == chess.BLACK else "Black"
        terminal = f"CHECKMATE — {winner} wins."
    elif board.is_stalemate():
        terminal = "STALEMATE — draw."
    elif board.is_check():
        terminal = "check (not mate)"
    else:
        terminal = "no forced mate at the end of this line"
    return steps, terminal


class State:
    def __init__(self, run_path: Path, target: int, seed: int):
        self.labels_path = run_path.with_suffix(".labels.jsonl")
        self.target = target
        jobs: list[dict] = []
        with run_path.open(encoding="utf-8") as f:
            for raw in f:
                if raw.strip():
                    jobs.extend(_jobs_from_record(json.loads(raw)))
        # Same seeded shuffle as the CLI, so the two tools agree on order
        # and a session can move between them. See pipeline.label for why
        # the order must not follow the file (same-puzzle anchoring).
        random.Random(seed).shuffle(jobs)
        self.jobs = jobs
        self.done: set[tuple[str, str]] = set()
        # Skips are session-only and never written to the labels file: an
        # item you could not judge is absent evidence, not a score, and
        # writing it would corrupt the gate. But it must be remembered for
        # THIS session or next_job hands back the same item forever.
        self.skipped: set[tuple[str, str]] = set()
        self.scores: dict[int, int] = {0: 0, 1: 0, 2: 0}
        if self.labels_path.exists():
            with self.labels_path.open(encoding="utf-8") as f:
                for raw in f:
                    if raw.strip():
                        obj = json.loads(raw)
                        self.done.add((obj["puzzle_id"], obj["arm"]))
                        self.scores[obj["score"]] = self.scores.get(obj["score"], 0) + 1

    def next_job(self) -> dict | None:
        if len(self.done) >= self.target:
            return None
        for job in self.jobs:
            key = (job["puzzle_id"], job["arm"])
            if key not in self.done and key not in self.skipped:
                return job
        return None

    def save(self, row: dict) -> None:
        with self.labels_path.open("a", encoding="utf-8") as out:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.done.add((row["puzzle_id"], row["arm"]))
        self.scores[row["score"]] = self.scores.get(row["score"], 0) + 1


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep the console clean
            pass

        def _json(self, obj: dict) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if self.path == "/":
                # Read per request so edits to the page show on refresh.
                body = PAGE_PATH.read_text(encoding="utf-8").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/api/next":
                job = state.next_job()
                if job is None:
                    minority = state.scores[0] + state.scores[1]
                    self._json(
                        {
                            "done": True,
                            "count": len(state.done),
                            "path": str(state.labels_path),
                            "dist": state.scores,
                            "minority": minority,
                        }
                    )
                    return
                steps, terminal = build_steps(job["fen"], job.get("line_ucis") or [])
                # NOTE: the judge's verdict is deliberately not included.
                self._json(
                    {
                        "done": False,
                        "puzzle_id": job["puzzle_id"],
                        "arm": job["arm"],
                        "fen": job["fen"],
                        "side": _side_name(job["fen"]),
                        "themes": sorted(job["themes"]),
                        "solution_san": job["solution_san"],
                        "engine_lines": job["engine_lines"],
                        "explanation": job["explanation"],
                        "steps": steps,
                        "terminal": terminal,
                        "index": len(state.done) + 1,
                        "target": state.target,
                        "done_count": len(state.done),
                        "remaining": state.target - len(state.done),
                    }
                )
                return
            self.send_error(404)

        def do_POST(self) -> None:
            if self.path not in ("/api/label", "/api/skip"):
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", 0))
            row = json.loads(self.rfile.read(length))
            if self.path == "/api/skip":
                state.skipped.add((row["puzzle_id"], row["arm"]))
                self._json({"ok": True})
                return
            state.save(
                {
                    "puzzle_id": row["puzzle_id"],
                    "arm": row["arm"],
                    "score": int(row["score"]),
                    "category": row.get("category", "ok"),
                    "note": row.get("note", ""),
                }
            )
            self._json({"ok": True})

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--target", type=int, default=250)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args(argv)

    state = State(Path(args.run), args.target, args.seed)
    url = f"http://127.0.0.1:{args.port}"
    print(f"{len(state.done)} labeled, target {args.target}")
    print(f"labeling at {url}   (ctrl-c to stop; progress is saved per label)")
    if not args.no_open:
        webbrowser.open(url)
    server = HTTPServer(("127.0.0.1", args.port), make_handler(state))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{len(state.done)} labels in {state.labels_path}")
        dist = state.scores
        print(f"score distribution — 0: {dist[0]}  1: {dist[1]}  2: {dist[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
