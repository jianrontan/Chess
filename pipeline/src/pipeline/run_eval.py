"""Eval-harness runner: sweep the stratified sample through the serve pipeline.

Usage:
    uv run python -m pipeline.run_eval --out data/eval_runs/dev.jsonl \
        --llm fake --limit 5
    uv run python -m pipeline.run_eval --out data/eval_runs/haiku-d14.jsonl \
        --llm anthropic --depth 14

Per puzzle, two arms:
- candidates ("what should I play?"): engine MultiPV on the post-setup
  position -> explain.v1 candidates prompt -> LLM.
- grade ("why was that a mistake?"): the SETUP MOVE is a real move played
  in a real game, graded exactly like prod Mode 2 (win%-drop, same
  thresholds); the arm runs only when it grades inaccuracy-or-worse —
  puzzles whose setup move lost nothing are not labeled mistakes.

Deterministic checks (groundedness, move-match) are computed inline; the
LLM-judge pass is separate (pipeline.judge_eval) so sweeps and judging can
use different models/batching.

Reproducibility: every run writes <out>.meta.json (engine id + depth +
multipv, model, prompt version, sample path). Output is append-only JSONL,
flushed per record; rerunning with the same --out resumes, skipping
already-done puzzle ids — a killed sweep loses at most one puzzle.
"""

import argparse
import json
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from pathlib import Path

from pipeline.checks import check_groundedness, check_move_match
from pipeline.engine import Engine, EngineLine
from pipeline.grading import grade_played_move
from pipeline.llm import DEFAULT_MODEL, make_llm
from pipeline.metrics import (
    check_mate_consistency,
    check_piece_references,
    check_theme_coverage,
)
from pipeline.prompts import build_candidates_prompt, build_grade_prompt, load_template, pv_to_san

PIPELINE_ROOT = Path(__file__).resolve().parents[2]

# Grade arm runs only for real mistakes (inaccuracy or worse).
GRADE_ARM_CLASSES = frozenset(["inaccuracy", "mistake", "blunder"])


def _line_dict(line: EngineLine) -> dict:
    return asdict(line) | {"pv": list(line.pv)}


def _done_ids(out_path: Path) -> set[str]:
    if not out_path.exists():
        return set()
    done: set[str] = set()
    with out_path.open(encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if raw:
                done.add(json.loads(raw)["puzzle_id"])
    return done


def _check_meta(meta_path: Path, meta: dict) -> None:
    """A resumed run must use identical settings or the sweep is incoherent."""
    if meta_path.exists():
        existing = json.loads(meta_path.read_text(encoding="utf-8"))
        for key in ("engine_depth", "multipv", "model", "prompt_version", "sample"):
            if existing.get(key) != meta.get(key):
                raise SystemExit(
                    f"resume mismatch on {key!r}: existing run used {existing.get(key)!r}, "
                    f"this invocation {meta.get(key)!r} — use a new --out for new settings"
                )
    else:
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def subsample(records: list[dict], size: int, *, seed: int = 42) -> list[dict]:
    """Take `size` records without destroying the sample's stratification.

    The parent sample is already stratified per theme x band cell, so a
    seeded uniform draw preserves those proportions.

    Measured, so the claim is honest: the file is sorted by puzzle_id and
    those ids are effectively random (mean rating per 300-row block 1776 /
    1727 / 1646 / 1707, band mix wobbling ~5pp with no trend), so a plain
    head-slice is not systematically biased either. This exists because a
    seeded draw is EXPLICIT and reproducible rather than relying on that
    property — not because --limit was corrupting results.

    Neither method fixes rare-theme coverage: at 300 of 1172 the tail
    themes are thin or absent whichever way you slice (56 vs 58 of 69
    themes present). Cover them by sweeping the full sample, not by
    subsampling more cleverly.
    """
    if size >= len(records):
        return records
    # Shuffle-then-prefix, NOT rng.sample: prefixes are NESTED, so raising
    # --sample-size later grows the same sweep instead of drawing a
    # different set. rng.sample(k=350) shares no structure with
    # rng.sample(k=150), which would silently turn a resumed run into a
    # union of two unrelated draws.
    shuffled = list(records)
    random.Random(seed).shuffle(shuffled)
    return sorted(shuffled[:size], key=lambda r: r["puzzle_id"])


def _explanation_metrics(
    text: str, fen: str, pvs: list[list[str]], themes: list[str], lines
) -> dict:
    """Free, deterministic proxies for judge dimensions (pipeline.metrics)."""
    coverage = check_theme_coverage(text, themes)
    placement = check_piece_references(text, fen, pvs)
    mate = check_mate_consistency(text, lines)
    return {
        "theme_scored": list(coverage.scored),
        "theme_named": list(coverage.named),
        "theme_rate": coverage.rate,
        "placement_claims": list(placement.claims),
        "placement_errors": list(placement.errors),
        "mate_claimed": mate.claimed,
        "mate_actual": mate.actual,
        "mate_consistent": mate.consistent,
    }


def run_puzzle(rec: dict, engine, llm, template: dict, *, depth: int, multipv: int) -> dict:
    fen = rec["fen"]  # post-setup: the position the solver faces
    solution = rec["solution"]

    candidates = engine.analyse(fen, depth=depth, multipv=multipv)
    prompt = build_candidates_prompt(fen, candidates, template)
    explanation = llm.complete(prompt.system, prompt.user)
    pvs = [list(line.pv) for line in candidates]
    grounded = check_groundedness(explanation, fen, pvs)
    move_match = check_move_match(engine, fen, candidates[0], solution[0], depth=depth)
    metrics = _explanation_metrics(explanation, fen, pvs, rec["themes"], candidates)
    # The engine-lines text as shown to the LLM — stored so the judge pass
    # needs no chess logic of its own.
    candidates_text = "\n".join(
        row for row in prompt.user.split("\n") if row[:1].isdigit() and ". " in row
    )

    result: dict = {
        "puzzle_id": rec["puzzle_id"],
        "fen": fen,
        "csv_fen": rec["csv_fen"],
        "setup_move": rec["setup_move"],
        "themes": rec["themes"],
        "rating": rec["rating"],
        "rating_band": rec["rating_band"],
        "solver_color": rec["solver_color"],
        "solution": solution,
        "solution_san": pv_to_san(fen, solution),
        "candidates": {
            "lines": [_line_dict(line) for line in candidates],
            "lines_text": candidates_text,
            "explanation": explanation,
            "grounded": grounded.grounded,
            "ground_violations": list(grounded.violations),
            "metrics": metrics,
            "move_match": {
                "matched": move_match.matched,
                "exact": move_match.exact,
                "engine_move": move_match.engine_move,
                "solution_move": move_match.solution_move,
                "engine_win_pct": round(move_match.engine_win_pct, 2),
                "solution_win_pct": round(move_match.solution_win_pct, 2),
            },
        },
    }

    # Grade arm: the setup move, graded from the pre-setup position.
    csv_fen = rec["csv_fen"]
    setup_move = rec["setup_move"]
    best = engine.analyse(csv_fen, depth=depth, multipv=1)[0]
    played = engine.analyse_move(csv_fen, setup_move, depth=depth)
    verdict = grade_played_move(
        (best.cp, best.mate, best.pv[0]), (played.cp, played.mate, played.pv[0])
    )
    grade: dict = {
        "setup_move": setup_move,
        "move_class": verdict.move_class,
        "win_pct_before": round(verdict.win_pct_before, 2),
        "win_pct_after": round(verdict.win_pct_after, 2),
        "win_pct_drop": round(verdict.win_pct_drop, 2),
        "explained": False,
    }
    if verdict.move_class in GRADE_ARM_CLASSES:
        gprompt = build_grade_prompt(
            csv_fen,
            setup_move,
            verdict.move_class,
            verdict.win_pct_before,
            verdict.win_pct_after,
            played,
            best,
            template,
        )
        gexplanation = llm.complete(gprompt.system, gprompt.user)
        gpvs = [list(played.pv), list(best.pv)]
        ggrounded = check_groundedness(gexplanation, csv_fen, gpvs)
        gmetrics = _explanation_metrics(gexplanation, csv_fen, gpvs, rec["themes"], [played, best])
        grade |= {
            "explained": True,
            "played_line": _line_dict(played),
            "best_line": _line_dict(best),
            # Everything the explainer was told, so the judge never flags a
            # legitimately-quoted fact (e.g. the win% delta) as invented.
            "lines_text": (
                f"Played move: {pv_to_san(csv_fen, [setup_move])} "
                f"(graded {verdict.move_class}; winning chances went from "
                f"{verdict.win_pct_before:.0f}% to {verdict.win_pct_after:.0f}%)\n"
                f"Line after the played move: {pv_to_san(csv_fen, list(played.pv))}\n"
                f"Engine's preferred line: {pv_to_san(csv_fen, list(best.pv))}"
            ),
            "explanation": gexplanation,
            "grounded": ggrounded.grounded,
            "ground_violations": list(ggrounded.violations),
            "metrics": gmetrics,
        }
    result["grade"] = grade
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", default=str(PIPELINE_ROOT / "data" / "eval_sample.jsonl"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--llm", choices=["fake", "anthropic"], default="fake")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--depth", type=int, default=14)
    parser.add_argument("--multipv", type=int, default=3)
    parser.add_argument(
        "--sample-size",
        type=int,
        default=None,
        help="stratification-preserving subsample of the sample file (seeded). "
        "Use this to size a sweep down — NOT --limit.",
    )
    parser.add_argument("--seed", type=int, default=42, help="seed for --sample-size")
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="head-slice for smoke tests only; biased (the sample is id-sorted)",
    )
    parser.add_argument("--threads", type=int, default=2, help="engine threads")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=6,
        help="puzzles in flight; the sweep is LLM-latency-bound, not CPU-bound",
    )
    args = parser.parse_args(argv)

    sample_path = Path(args.sample)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    template = load_template()
    llm = make_llm(args.llm, args.model)
    records = [
        json.loads(line)
        for line in sample_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if args.sample_size is not None:
        records = subsample(records, args.sample_size, seed=args.seed)
    done = _done_ids(out_path)

    with Engine(threads=args.threads) as engine:
        meta = {
            "sample": sample_path.name,
            "engine": engine.id_name,
            "engine_depth": args.depth,
            "multipv": args.multipv,
            "model": llm.name,
            "prompt_version": template["version"],
        }
        _check_meta(Path(str(out_path) + ".meta.json"), meta)

        todo = [r for r in records if r["puzzle_id"] not in done]
        if args.limit is not None:
            todo = todo[: args.limit]
        print(
            f"{len(records)} sampled, {len(done)} done, running {len(todo)} "
            f"with {args.concurrency} workers"
        )

        # Engine work is ~0.4s/puzzle and lock-serialized; LLM calls are
        # seconds each and are what concurrency actually buys. Results are
        # written as they complete (order is not meaningful — resume keys
        # on puzzle_id), each line flushed so a kill loses at most the
        # in-flight puzzles.
        write_lock = threading.Lock()
        failures: list[tuple[str, str]] = []
        started = time.monotonic()

        def work(rec: dict) -> str:
            return run_puzzle(rec, engine, llm, template, depth=args.depth, multipv=args.multipv)

        with (
            out_path.open("a", encoding="utf-8") as out,
            ThreadPoolExecutor(max_workers=args.concurrency) as pool,
        ):
            futures = {pool.submit(work, rec): rec for rec in todo}
            for i, future in enumerate(as_completed(futures), 1):
                rec = futures[future]
                try:
                    result = future.result()
                except Exception as e:  # one bad puzzle must not kill a sweep
                    failures.append((rec["puzzle_id"], f"{type(e).__name__}: {e}"))
                    continue
                with write_lock:
                    out.write(json.dumps(result, ensure_ascii=False) + "\n")
                    out.flush()
                if i % 25 == 0 or i == len(todo):
                    rate = i / max(time.monotonic() - started, 1e-9)
                    eta = (len(todo) - i) / rate / 60
                    print(f"  {i}/{len(todo)}  {rate * 60:.0f}/min  eta {eta:.0f}m")

    if failures:
        print(f"\n{len(failures)} puzzle(s) failed (rerun to retry — resume skips the rest):")
        for pid, err in failures[:10]:
            print(f"  {pid}: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
