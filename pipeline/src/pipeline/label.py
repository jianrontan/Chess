"""Hand-labeling CLI for the judge validation gate.

Usage:
    uv run python -m pipeline.label --run data/eval_runs/gate.jsonl [--target 150]

You are the ground truth here. This tool shows one explanation at a time
beside everything needed to grade it — the board, the puzzle's theme tags,
the verified solution, and the engine lines the explainer was given — and
records your 0/1/2 score with the same rubric the LLM-judge uses.

Two deliberate design rules:

1. The judge's verdict is NEVER shown, even when a judged file exists.
   Seeing a machine score first anchors the human, and an anchored label
   set silently inflates the agreement number the whole gate depends on.
2. Labels are written immediately and the tool resumes, so this can be
   done in several short sittings — which is how it should be done, since
   grading attention degrades fast.

Output: <run>.labels.jsonl, consumed by pipeline.judge_gate.
"""

import argparse
import json
import sys
from pathlib import Path

import chess

from pipeline.judge_eval import _jobs_from_record, _side_name

RUBRIC = """  2 = right idea AND sound reasoning, nothing invented
  1 = right idea, but shaky/wrong reasoning or an invented detail
  0 = wrong idea
  b = walk the main line board by board (check the claims yourself)
  s = skip (unsure — excluded from the gate, not counted against it)
  q = save and quit"""

CATEGORIES = {
    "1": "wrong_theme",
    "2": "wrong_mechanism",
    "3": "hallucinated_line",
}


def _board_art(fen: str) -> str:
    """Plain-text board, White at the bottom, with file/rank labels."""
    board = chess.Board(fen)
    rows = []
    for rank in range(7, -1, -1):
        cells = []
        for file in range(8):
            piece = board.piece_at(chess.square(file, rank))
            cells.append(piece.symbol() if piece else ".")
        rows.append(f" {rank + 1}  " + " ".join(cells))
    rows.append("\n    a b c d e f g h")
    return "\n".join(rows)


def walk_line(fen: str, ucis: list[str]) -> str:
    """Board after each move of the main line, ending with the real result.

    You do not need to be strong enough to FIND the tactic to grade the
    explanation of it — but you do need to check claims like "this is
    checkmate" or "the rook is trapped". Rather than making the labeler
    hold six plies in their head, show the position after each move and
    state the terminal status from python-chess, which cannot be fooled.
    """
    board = chess.Board(fen)
    out: list[str] = []
    for uci in ucis:
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            out.append(f"  (line breaks at {uci} — illegal here)")
            break
        san = board.san(move)
        number = board.fullmove_number
        dots = "." if board.turn == chess.WHITE else "..."
        board.push(move)
        out.append(f"\nafter {number}{dots} {san}:")
        out.append(_board_art(board.fen()))
    if board.is_checkmate():
        winner = "White" if board.turn == chess.BLACK else "Black"
        out.append(f"\n>>> CHECKMATE — {winner} wins. <<<")
    elif board.is_stalemate():
        out.append("\n>>> STALEMATE — draw. <<<")
    elif board.is_check():
        out.append("\n>>> check (not mate) <<<")
    else:
        out.append("\n>>> no forced mate at the end of this line <<<")
    return "\n".join(out)


def _prompt(text: str) -> str:
    try:
        return input(text).strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return "q"


def label_one(job: dict, index: int, total: int) -> dict | None:
    """Show one item and collect a label. None means skip; 'q' raises SystemExit."""
    print("\n" + "=" * 72)
    print(f"[{index}/{total}]  puzzle {job['puzzle_id']}  ({job['arm']} arm)")
    print("=" * 72)
    print(_board_art(job["fen"]))
    print(f"\n{_side_name(job['fen'])} to move")
    print(f"Themes:   {' '.join(sorted(job['themes']))}")
    # In the grade arm the board is the position BEFORE the blunder, so the
    # puzzle solution is the opponent's punishment, not a move for the side
    # to move — naming it accordingly avoids mislabeling on that confusion.
    if job["arm"] == "grade":
        print(f"Refutation the opponent gets: {job['solution_san']}")
        print("(grading an explanation of why the played move was a mistake)")
    else:
        print(f"Solution: {job['solution_san']}")
    print(f"\nEngine lines shown to the explainer:\n{job['engine_lines']}")
    print("\n--- EXPLANATION " + "-" * 56)
    print(job["explanation"].strip())
    print("-" * 72)
    print(RUBRIC)

    while True:
        answer = _prompt("score> ")
        if answer == "q":
            raise SystemExit(0)
        if answer == "s":
            return None
        if answer == "b":
            print(walk_line(job["fen"], job.get("line_ucis") or []))
            continue
        if answer in ("0", "1", "2"):
            score = int(answer)
            break
        print("  enter 0, 1, 2, b, s, or q")

    category = "ok"
    if score < 2:
        print("  category:  1=wrong_theme  2=wrong_mechanism  3=hallucinated_line")
        while True:
            choice = _prompt("category> ")
            if choice in CATEGORIES:
                category = CATEGORIES[choice]
                break
            print("  enter 1, 2, or 3")
    note = _prompt("note (optional, enter to skip)> ")
    return {
        "puzzle_id": job["puzzle_id"],
        "arm": job["arm"],
        "score": score,
        "category": category,
        "note": note,
    }


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, help="a completed run JSONL")
    parser.add_argument(
        "--target",
        type=int,
        default=150,
        help="stop after this many labels exist. 150 not 100: at 100 an "
        "observed 85%% agreement carries a CI near [77%%, 91%%], straddling "
        "the 80%% gate bar so it cannot decide it. Precision is driven by the "
        "count of MINORITY labels (0s and 1s) — if most scores are 2s, more.",
    )
    args = parser.parse_args(argv)

    run_path = Path(args.run)
    labels_path = run_path.with_suffix(".labels.jsonl")

    jobs: list[dict] = []
    with run_path.open(encoding="utf-8") as f:
        for raw in f:
            if raw.strip():
                jobs.extend(_jobs_from_record(json.loads(raw)))

    done: set[tuple[str, str]] = set()
    if labels_path.exists():
        with labels_path.open(encoding="utf-8") as f:
            for raw in f:
                if raw.strip():
                    obj = json.loads(raw)
                    done.add((obj["puzzle_id"], obj["arm"]))

    todo = [j for j in jobs if (j["puzzle_id"], j["arm"]) not in done]
    remaining = max(0, args.target - len(done))
    if not remaining:
        print(f"{len(done)} labels already in {labels_path.name} — target met.")
        return 0
    todo = todo[:remaining]
    print(
        f"{len(done)} labeled, {len(todo)} to go (target {args.target}). "
        "Judge verdicts are hidden on purpose. 'q' saves and quits."
    )

    written = 0
    try:
        with labels_path.open("a", encoding="utf-8") as out:
            for i, job in enumerate(todo, 1):
                row = label_one(job, len(done) + i, args.target)
                if row is None:
                    continue
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.flush()
                written += 1
    except SystemExit:
        pass
    print(f"\nSaved {written} label(s) to {labels_path}  ({len(done) + written} total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
