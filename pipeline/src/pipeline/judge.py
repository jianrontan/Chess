"""LLM-judge: grades explanations against ground truth (0/1/2 rubric).

The real eval signal (CLAUDE.md: legality and move-match are plumbing).
The judge compares prose to three verified artifacts — theme tags,
solution line, engine analysis — and never analyzes chess itself.

Trust rules:
- The judge model must DIFFER from the synthesizer model (no self-grading;
  prod synthesizes with Haiku, so the judge defaults to Sonnet).
- Judge scores are not trusted until the validation gate passes: >=80%
  agreement with ~100 hand-labeled explanations (roadmap Phase 3).
- The rubric is versioned in prompts/judge.v1.json; sweeps record it.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

from pipeline.prompts import REPO_ROOT, fill

JUDGE_TEMPLATE_PATH = REPO_ROOT / "prompts" / "judge.v1.json"

# Different family than the synthesizer (claude-haiku-4-5) by design.
DEFAULT_JUDGE_MODEL = "claude-sonnet-5"

# Sonnet 5 spends output tokens on (useful) thinking before the JSON —
# measured 2.3-2.7k thinking tokens on hard grade-arm jobs; 512 and 2500
# caps both truncated replies. Cost note for full-sweep budgeting: ~2.5k
# output tokens/judgment is the dominant sweep cost (mitigate: Batch API).
JUDGE_MAX_TOKENS = 8000

VALID_CATEGORIES = frozenset(["ok", "wrong_theme", "wrong_mechanism", "hallucinated_line"])


def load_judge_template(path: Path = JUDGE_TEMPLATE_PATH) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


@dataclass(frozen=True, slots=True)
class Judgment:
    idea: bool
    mechanism: bool
    hallucination: bool
    score: int
    category: str
    reason: str


def build_judge_prompt(
    fen: str,
    side_to_move_name: str,
    themes: list[str],
    solution_san: str,
    engine_lines: str,
    explanation: str,
    template: dict | None = None,
) -> tuple[str, str, str]:
    """Returns (system, user, judge_version)."""
    tpl = template or load_judge_template()
    user = fill(
        tpl["user"],
        {
            "fen": fen,
            "side_to_move": side_to_move_name,
            "themes": " ".join(sorted(themes)),
            "solution_san": solution_san,
            "engine_lines": engine_lines,
            "explanation": explanation,
        },
    )
    return tpl["system"], user, tpl["version"]


def parse_judgment(text: str) -> Judgment:
    """Parse the judge's JSON reply. Raises ValueError on garbage —
    a judge failure is recorded, never silently scored."""
    # Tolerate accidental markdown fences despite the instruction.
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if not match:
        raise ValueError(f"no JSON object in judge reply: {text[:200]!r}")
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError as e:
        raise ValueError(f"unparseable judge JSON: {text[:200]!r}") from e
    try:
        score = int(obj["score"])
        category = str(obj["category"])
        judgment = Judgment(
            idea=bool(obj["idea"]),
            mechanism=bool(obj["mechanism"]),
            hallucination=bool(obj["hallucination"]),
            score=score,
            category=category,
            reason=str(obj.get("reason", "")),
        )
    except KeyError as e:
        raise ValueError(f"judge JSON missing field {e}: {text[:200]!r}") from e
    if judgment.score not in (0, 1, 2):
        raise ValueError(f"judge score out of range: {judgment.score}")
    if judgment.category not in VALID_CATEGORIES:
        raise ValueError(f"unknown judge category: {judgment.category!r}")
    return judgment
