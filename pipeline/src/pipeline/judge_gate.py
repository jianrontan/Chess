"""Judge validation gate: does a judge config agree with the human?

Usage:
    uv run python -m pipeline.judge_gate --run data/eval_runs/gate.jsonl \
        [--configs sonnet-high,sonnet-low,haiku] [--holdout 0.4]

Every number the harness reports downstream rests on this. It scores each
candidate judge configuration against YOUR hand labels and reports:

  - exact agreement (the gate metric, bar = 80%)
  - within-1 agreement (0/1/2 is ordinal — a 2-vs-0 miss is worse than 2-vs-1)
  - per-category agreement, because a judge can be fine at "did it name the
    theme" and useless at "is the mechanism sound", and only the breakdown
    shows that
  - measured cost per judgment, so you can buy the cheapest config that passes

Held-out split: the rubric may be revised ONCE if the gate fails (roadmap
Phase 3). Revising against the same items you then report on is fitting to
the test set, so items are split by a hash of the item key — tune on the
tune split, report the gate verdict on the holdout.

Chance-corrected: raw agreement flatters a judge when scores are skewed
(if 70% of labels are "2", a judge that always says "2" scores 70%).
Cohen's kappa is reported alongside; near 0 means "no better than guessing
the distribution" no matter how good the raw number looks.
"""

import argparse
import json
import sys
import zlib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from pipeline.judge import JUDGE_MAX_TOKENS, build_judge_prompt, load_judge_template, parse_judgment
from pipeline.judge_eval import _jobs_from_record, _side_name
from pipeline.llm import AnthropicLLM

GATE_BAR = 0.80

# $/1M tokens (input, output). Sonnet 5 intro pricing through 2026-08-31.
PRICES = {"claude-sonnet-5": (2.0, 10.0), "claude-haiku-4-5": (1.0, 5.0)}

CONFIGS: dict[str, tuple[str, str | None]] = {
    "sonnet-high": ("claude-sonnet-5", "high"),
    "sonnet-medium": ("claude-sonnet-5", "medium"),
    "sonnet-low": ("claude-sonnet-5", "low"),
    "haiku": ("claude-haiku-4-5", None),
}


def _split(key: tuple[str, str], holdout: float) -> str:
    """Deterministic per-item split (no RNG — stable across reruns)."""
    h = zlib.crc32("|".join(key).encode("utf-8")) / 2**32
    return "holdout" if h < holdout else "tune"


def _kappa(pairs: list[tuple[int, int]]) -> float:
    """Cohen's kappa for two raters over the 0/1/2 scale."""
    if not pairs:
        return 0.0
    n = len(pairs)
    observed = sum(1 for a, b in pairs if a == b) / n
    human = defaultdict(int)
    judge = defaultdict(int)
    for a, b in pairs:
        human[a] += 1
        judge[b] += 1
    expected = sum((human[s] / n) * (judge[s] / n) for s in (0, 1, 2))
    return 1.0 if expected == 1 else (observed - expected) / (1 - expected)


@dataclass
class ConfigResult:
    name: str
    model: str
    effort: str | None
    pairs: dict[str, list[tuple[int, int]]]
    by_category: dict[str, list[tuple[int, int]]]
    errors: int
    in_tokens: int
    out_tokens: int
    judged: int

    def cost_per_judgment(self) -> float:
        if not self.judged:
            return 0.0
        pin, pout = PRICES[self.model]
        return (self.in_tokens / self.judged * pin + self.out_tokens / self.judged * pout) / 1e6


def _agreement(pairs: list[tuple[int, int]]) -> tuple[float, float]:
    if not pairs:
        return 0.0, 0.0
    exact = sum(1 for a, b in pairs if a == b) / len(pairs)
    within1 = sum(1 for a, b in pairs if abs(a - b) <= 1) / len(pairs)
    return exact, within1


def run_config(name: str, jobs: list[dict], labels: dict, template: dict, holdout: float):
    model, effort = CONFIGS[name]
    llm = AnthropicLLM(model=model, effort=effort)
    result = ConfigResult(
        name=name,
        model=model,
        effort=effort,
        pairs={"tune": [], "holdout": []},
        by_category=defaultdict(list),
        errors=0,
        in_tokens=0,
        out_tokens=0,
        judged=0,
    )
    for i, job in enumerate(jobs, 1):
        key = (job["puzzle_id"], job["arm"])
        human = labels[key]
        system, user, _ = build_judge_prompt(
            job["fen"],
            _side_name(job["fen"]),
            job["themes"],
            job["solution_san"],
            job["engine_lines"],
            job["explanation"],
            template,
        )
        text, (in_tok, out_tok) = llm.complete_with_usage(system, user, max_tokens=JUDGE_MAX_TOKENS)
        result.in_tokens += in_tok
        result.out_tokens += out_tok
        result.judged += 1
        try:
            verdict = parse_judgment(text)
        except ValueError:
            result.errors += 1
            continue
        pair = (human["score"], verdict.score)
        result.pairs[_split(key, holdout)].append(pair)
        result.by_category[human["category"]].append(pair)
        if i % 20 == 0:
            print(f"    {name}: {i}/{len(jobs)}")
            sys.stdout.flush()
    return result


def report(results: list[ConfigResult], n_labels: int, holdout: float) -> str:
    out: list[str] = []
    out.append("# Judge validation gate")
    out.append("")
    out.append(
        f"{n_labels} human labels | holdout {holdout:.0%} | bar = {GATE_BAR:.0%} "
        "exact agreement on holdout"
    )
    out.append("")
    out.append(
        "| config | cost/judgment | tune exact | holdout exact | within-1 | "
        "kappa | errors | verdict |"
    )
    out.append("|---|---|---|---|---|---|---|---|")
    for r in sorted(results, key=lambda x: x.cost_per_judgment()):
        tune_exact, _ = _agreement(r.pairs["tune"])
        hold_exact, hold_within1 = _agreement(r.pairs["holdout"])
        kappa = _kappa(r.pairs["holdout"])
        verdict = "**PASS**" if hold_exact >= GATE_BAR else "fail"
        out.append(
            f"| {r.name} | ${r.cost_per_judgment():.5f} | {tune_exact:.0%} | "
            f"{hold_exact:.0%} | {hold_within1:.0%} | {kappa:.2f} | {r.errors} | {verdict} |"
        )
    out.append("")

    out.append("## Per-category agreement (where each judge is weak)")
    out.append("")
    cats = sorted({c for r in results for c in r.by_category})
    out.append("| config | " + " | ".join(f"{c} (n)" for c in cats) + " |")
    out.append("|---" * (len(cats) + 1) + "|")
    for r in sorted(results, key=lambda x: x.cost_per_judgment()):
        cells = []
        for c in cats:
            pairs = r.by_category.get(c, [])
            exact, _ = _agreement(pairs)
            cells.append(f"{exact:.0%} ({len(pairs)})" if pairs else "—")
        out.append(f"| {r.name} | " + " | ".join(cells) + " |")
    out.append("")

    passing = [r for r in results if _agreement(r.pairs["holdout"])[0] >= GATE_BAR]
    if passing:
        best = min(passing, key=lambda r: r.cost_per_judgment())
        out.append(
            f"**Recommendation:** `{best.name}` — cheapest config clearing the "
            f"{GATE_BAR:.0%} bar at ${best.cost_per_judgment():.5f}/judgment."
        )
    else:
        out.append(
            "**No config passed.** The roadmap allows ONE rubric revision: edit "
            "prompts/judge.v1.json (bump to v2), then re-run. Tune against the "
            "tune split and keep the holdout verdict honest. If nothing passes "
            "after that, report the judge as unvalidated rather than shipping "
            "numbers it cannot support."
        )
    out.append("")
    out.append(
        "_Kappa near 0 means the judge is only matching the label distribution — "
        "treat a high raw agreement with low kappa as a failed gate._"
    )
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--configs", default="sonnet-high,sonnet-low,haiku")
    parser.add_argument("--holdout", type=float, default=0.4)
    parser.add_argument("--out", default=None, help="write the report here too")
    args = parser.parse_args(argv)

    run_path = Path(args.run)
    labels_path = run_path.with_suffix(".labels.jsonl")
    if not labels_path.exists():
        raise SystemExit(
            f"no labels at {labels_path} — run `python -m pipeline.label --run {args.run}` first"
        )

    labels = {}
    with labels_path.open(encoding="utf-8") as f:
        for raw in f:
            if raw.strip():
                obj = json.loads(raw)
                labels[(obj["puzzle_id"], obj["arm"])] = obj

    jobs = []
    with run_path.open(encoding="utf-8") as f:
        for raw in f:
            if raw.strip():
                jobs.extend(_jobs_from_record(json.loads(raw)))
    jobs = [j for j in jobs if (j["puzzle_id"], j["arm"]) in labels]
    if not jobs:
        raise SystemExit("labels exist but match no items in the run file")

    names = [n.strip() for n in args.configs.split(",") if n.strip()]
    unknown = [n for n in names if n not in CONFIGS]
    if unknown:
        raise SystemExit(f"unknown config(s) {unknown}; known: {sorted(CONFIGS)}")

    template = load_judge_template()
    print(f"scoring {len(names)} config(s) against {len(jobs)} labeled items")
    results = [run_config(n, jobs, labels, template, args.holdout) for n in names]

    text = report(results, len(jobs), args.holdout)
    print("\n" + text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"\nwritten to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
