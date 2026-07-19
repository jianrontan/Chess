"""Scorecard: aggregate an eval run (+ its judge pass) per theme and band.

Usage:
    uv run python -m pipeline.eval_report --run data/eval_runs/haiku-d14.jsonl

Reads <run>.jsonl and, if present, <run>.judged.jsonl. Prints a markdown
scorecard: plumbing rates (move-match, groundedness), judge score
distribution, and per-theme / per-band breakdowns of the candidates arm.

Honesty notes baked into the output: theme tags are player-voted and
noisy (a floor on achievable agreement), and judge numbers are only
meaningful once the judge has passed its validation gate.
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

# Tags that describe context, not a tactical idea — excluded from the
# per-theme table so it stays readable (they still count in totals).
CONTEXT_TAGS = frozenset(
    [
        "short",
        "long",
        "veryLong",
        "oneMove",
        "middlegame",
        "endgame",
        "opening",
        "master",
        "masterVsMaster",
        "superGM",
        "crushing",
        "advantage",
        "equality",
        "mate",
    ]
)


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def _pct(num: int, den: int) -> str:
    return f"{100 * num / den:.1f}%" if den else "—"


def _mean(values: list[int]) -> str:
    return f"{sum(values) / len(values):.2f}" if values else "—"


def report(run_path: Path) -> str:
    records = _load_jsonl(run_path)
    judged = _load_jsonl(run_path.with_suffix(".judged.jsonl"))
    meta_path = Path(str(run_path) + ".meta.json")
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    if not records:
        return f"no records in {run_path}"

    scores: dict[tuple[str, str], dict] = {
        (j["puzzle_id"], j["arm"]): j for j in judged if "error" not in j
    }
    judge_errors = sum(1 for j in judged if "error" in j)

    lines: list[str] = []
    n = len(records)
    lines.append(f"# Eval scorecard — {run_path.name}")
    lines.append("")
    if meta:
        lines.append(
            f"{n} puzzles | engine {meta.get('engine')} depth {meta.get('engine_depth')} "
            f"multipv {meta.get('multipv')} | model {meta.get('model')} | "
            f"prompt {meta.get('prompt_version')}"
        )
        lines.append("")

    # Plumbing (near-100% by construction; a drop means the chain broke).
    matched = sum(1 for r in records if r["candidates"]["move_match"]["matched"])
    exact = sum(1 for r in records if r["candidates"]["move_match"]["exact"])
    grounded = sum(1 for r in records if r["candidates"]["grounded"])
    lines.append("## Plumbing checks (trust chain, expected ≈100%)")
    lines.append("")
    lines.append(
        f"- Move-match (solution or eval-equivalent): {_pct(matched, n)} (exact {_pct(exact, n)})"
    )
    lines.append(f"- Groundedness (no move mentioned outside given lines): {_pct(grounded, n)}")
    graded = [r for r in records if r["grade"]["explained"]]
    lines.append(
        f"- Grade arm ran on {len(graded)}/{n} puzzles (setup move graded inaccuracy or worse)"
    )
    if graded:
        g_grounded = sum(1 for r in graded if r["grade"]["grounded"])
        lines.append(f"- Grade-arm groundedness: {_pct(g_grounded, len(graded))}")
    lines.append("")

    # Deterministic proxies (free — run on every sweep, no API spend).
    with_metrics = [r for r in records if r["candidates"].get("metrics")]
    if with_metrics:
        lines.append("## Deterministic quality proxies (no LLM, free)")
        lines.append("")
        applicable = [
            r for r in with_metrics if r["candidates"]["metrics"]["theme_rate"] is not None
        ]
        if applicable:
            rates = [r["candidates"]["metrics"]["theme_rate"] for r in applicable]
            lines.append(
                f"- Theme vocabulary named: {100 * sum(rates) / len(rates):.1f}% "
                f"of tagged tactical themes (n={len(applicable)} puzzles with "
                "a scorable tag)"
            )
        clean = sum(1 for r in with_metrics if not r["candidates"]["metrics"]["placement_errors"])
        lines.append(
            f"- Piece placements all real: {_pct(clean, len(with_metrics))} "
            "(catches 'the rook on a8' when no rook is ever on a8)"
        )
        mate_ok = sum(1 for r in with_metrics if r["candidates"]["metrics"]["mate_consistent"])
        invented = sum(
            1
            for r in with_metrics
            if r["candidates"]["metrics"]["mate_claimed"]
            and not r["candidates"]["metrics"]["mate_actual"]
        )
        missed = sum(
            1
            for r in with_metrics
            if r["candidates"]["metrics"]["mate_actual"]
            and not r["candidates"]["metrics"]["mate_claimed"]
        )
        lines.append(
            f"- Mate claims consistent with the engine: {_pct(mate_ok, len(with_metrics))} "
            f"({invented} invented, {missed} missed a forced mate)"
        )
        lines.append("")
        lines.append(
            "_Proxies, not the metric: theme vocabulary is recall-only and "
            "gameable (naming 'fork' is necessary, not sufficient), and none "
            "of these score REASONING — that is what the judge measures._"
        )
        lines.append("")

    # Judge (the real signal).
    lines.append("## Explanation correctness (LLM-judge)")
    lines.append("")
    if not judged:
        lines.append("_No judge pass yet — run `python -m pipeline.judge_eval`._")
    else:
        for arm in ("candidates", "grade"):
            arm_scores = [s for (pid, a), s in scores.items() if a == arm]
            if not arm_scores:
                continue
            vals = [s["score"] for s in arm_scores]
            dist = {v: sum(1 for x in vals if x == v) for v in (0, 1, 2)}
            cats: dict[str, int] = defaultdict(int)
            for s in arm_scores:
                cats[s["category"]] += 1
            cat_text = ", ".join(f"{k}: {v}" for k, v in sorted(cats.items()))
            lines.append(
                f"- **{arm}** (n={len(vals)}): mean {_mean(vals)} | "
                f"0/1/2 = {dist[0]}/{dist[1]}/{dist[2]} | {cat_text}"
            )
        if judge_errors:
            lines.append(f"- Judge errors (unparseable replies): {judge_errors}")
        lines.append("")
        lines.append(
            "_Judge numbers are provisional until the validation gate passes "
            "(≥80% agreement with hand labels). Theme tags are player-voted "
            "and noisy — perfect agreement is not achievable._"
        )
    lines.append("")

    # Per-theme table (candidates arm; tactical tags only).
    by_theme: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        for t in r["themes"]:
            if t not in CONTEXT_TAGS:
                by_theme[t].append(r)
    lines.append("## Per-theme (candidates arm)")
    lines.append("")
    lines.append("| theme | n | move-match | grounded | named | judged | mean score | score 2 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for theme in sorted(by_theme, key=lambda t: -len(by_theme[t])):
        rs = by_theme[theme]
        tn = len(rs)
        mm = sum(1 for r in rs if r["candidates"]["move_match"]["matched"])
        gr = sum(1 for r in rs if r["candidates"]["grounded"])
        # Free proxy: did the prose name THIS theme's vocabulary?
        named_rs = [
            r for r in rs if theme in (r["candidates"].get("metrics") or {}).get("theme_scored", [])
        ]
        named = sum(1 for r in named_rs if theme in r["candidates"]["metrics"]["theme_named"])
        named_cell = _pct(named, len(named_rs)) if named_rs else "—"
        tscores = [
            scores[(r["puzzle_id"], "candidates")]["score"]
            for r in rs
            if (r["puzzle_id"], "candidates") in scores
        ]
        two = sum(1 for s in tscores if s == 2)
        lines.append(
            f"| {theme} | {tn} | {_pct(mm, tn)} | {_pct(gr, tn)} | {named_cell} | "
            f"{len(tscores)} | {_mean(tscores)} | {_pct(two, len(tscores))} |"
        )
    lines.append("")

    # Per-rating-band.
    by_band: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_band[r["rating_band"]].append(r)
    lines.append("## Per-rating-band (candidates arm)")
    lines.append("")
    lines.append("| band | n | move-match | grounded | judged | mean score |")
    lines.append("|---|---|---|---|---|---|")
    for band in sorted(by_band):
        rs = by_band[band]
        tn = len(rs)
        mm = sum(1 for r in rs if r["candidates"]["move_match"]["matched"])
        gr = sum(1 for r in rs if r["candidates"]["grounded"])
        bscores = [
            scores[(r["puzzle_id"], "candidates")]["score"]
            for r in rs
            if (r["puzzle_id"], "candidates") in scores
        ]
        lines.append(
            f"| {band} | {tn} | {_pct(mm, tn)} | {_pct(gr, tn)} | {len(bscores)} | "
            f"{_mean(bscores)} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to cp1252, which can't print ≥/≈/em-dashes.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    args = parser.parse_args(argv)
    print(report(Path(args.run)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
