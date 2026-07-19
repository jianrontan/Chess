"""Judge pass: grade a completed eval run with the LLM-judge.

Usage:
    uv run python -m pipeline.judge_eval --run data/eval_runs/haiku-d14.jsonl \
        [--llm anthropic] [--model claude-sonnet-5] [--limit N]

Reads the runner's JSONL, judges each explanation (both arms) against the
puzzle's ground truth, and appends to <run>.judged.jsonl — one line per
(puzzle_id, arm), resume-safe. Judge model defaults to Sonnet: it must
differ from the synthesizer (Haiku), no self-grading.

Judge failures (unparseable replies) are recorded as {"error": ...} lines,
never silently dropped — the report counts them.
"""

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from pipeline.judge import (
    DEFAULT_JUDGE_MODEL,
    JUDGE_MAX_TOKENS,
    build_judge_prompt,
    load_judge_template,
    parse_judgment,
)
from pipeline.llm import make_llm


def _side_name(fen: str) -> str:
    return "White" if fen.split(" ")[1] == "w" else "Black"


def _jobs_from_record(rec: dict) -> list[dict]:
    """Judge jobs for one runner record: candidates arm + grade arm (if run)."""
    jobs = [
        {
            "puzzle_id": rec["puzzle_id"],
            "arm": "candidates",
            "fen": rec["fen"],
            "themes": rec["themes"],
            "solution_san": rec["solution_san"],
            "engine_lines": rec["candidates"]["lines_text"],
            "explanation": rec["candidates"]["explanation"],
            # The main line in UCI, so the labeling tool can walk the human
            # through it board by board. Unused by the judge.
            "line_ucis": list(rec["solution"]),
        }
    ]
    grade = rec.get("grade") or {}
    if grade.get("explained"):
        # The grade arm explains the position BEFORE the setup move.
        jobs.append(
            {
                "puzzle_id": rec["puzzle_id"],
                "arm": "grade",
                "fen": rec["csv_fen"],
                "themes": rec["themes"],
                "solution_san": rec["solution_san"],
                "engine_lines": grade["lines_text"],
                "explanation": grade["explanation"],
                "line_ucis": list(grade["played_line"]["pv"]),
            }
        )
    return jobs


def _done_keys(path: Path) -> set[tuple[str, str]]:
    if not path.exists():
        return set()
    done: set[tuple[str, str]] = set()
    with path.open(encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if raw:
                obj = json.loads(raw)
                done.add((obj["puzzle_id"], obj["arm"]))
    return done


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--llm", choices=["fake", "anthropic"], default="anthropic")
    parser.add_argument("--model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument(
        "--effort",
        choices=["low", "medium", "high", "max"],
        default=None,
        help="reasoning effort; the dominant judge cost lever (low is ~4.7x "
        "cheaper than high). Validate any choice against hand labels first.",
    )
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args(argv)

    run_path = Path(args.run)
    out_path = run_path.with_suffix(".judged.jsonl")
    template = load_judge_template()
    llm = make_llm(args.llm, args.model, effort=args.effort)

    jobs: list[dict] = []
    with run_path.open(encoding="utf-8") as f:
        for raw in f:
            if raw.strip():
                jobs.extend(_jobs_from_record(json.loads(raw)))

    done = _done_keys(out_path)
    todo = [j for j in jobs if (j["puzzle_id"], j["arm"]) not in done]
    if args.limit is not None:
        todo = todo[: args.limit]
    print(f"{len(jobs)} explanations, {len(done)} judged, judging {len(todo)} with {llm.name}")

    with out_path.open("a", encoding="utf-8") as out:
        for i, job in enumerate(todo, 1):
            system, user, version = build_judge_prompt(
                job["fen"],
                _side_name(job["fen"]),
                job["themes"],
                job["solution_san"],
                job["engine_lines"],
                job["explanation"],
                template,
            )
            reply = llm.complete(system, user, max_tokens=JUDGE_MAX_TOKENS)
            row = {
                "puzzle_id": job["puzzle_id"],
                "arm": job["arm"],
                "judge_model": llm.name,
                "judge_version": version,
            }
            try:
                row |= asdict(parse_judgment(reply))
            except ValueError as e:
                row["error"] = str(e)
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            if i % 10 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
