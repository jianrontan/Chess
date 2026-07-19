"""Judge prompt building and reply parsing."""

import pytest

from pipeline.judge import build_judge_prompt, load_judge_template, parse_judgment

GOOD_REPLY = (
    '{"idea": true, "mechanism": true, "hallucination": false, '
    '"score": 2, "category": "ok", "reason": "identifies the back-rank mate"}'
)


def test_template_loads_and_fills():
    tpl = load_judge_template()
    assert tpl["version"] == "judge-v1"
    system, user, version = build_judge_prompt(
        "8/8/8/8/8/8/8/K6k w - - 0 1",
        "White",
        ["backRankMate", "mate", "short"],
        "24. Qxc8+ Bxc8 25. Rf8#",
        "1. 24. Qxc8+ ... — White mates in 2",
        "Sac the queen, mate follows.",
    )
    assert version == "judge-v1"
    assert "backRankMate mate short" in user
    assert "Sac the queen, mate follows." in user
    assert "score" in system


def test_parse_good_reply():
    j = parse_judgment(GOOD_REPLY)
    assert j.score == 2 and j.category == "ok" and j.idea and not j.hallucination


def test_parse_tolerates_markdown_fences():
    j = parse_judgment(f"```json\n{GOOD_REPLY}\n```")
    assert j.score == 2


def test_parse_rejects_garbage_and_bad_values():
    with pytest.raises(ValueError):
        parse_judgment("I think this explanation is quite good!")
    with pytest.raises(ValueError):
        parse_judgment(GOOD_REPLY.replace('"score": 2', '"score": 5'))
    with pytest.raises(ValueError):
        parse_judgment(GOOD_REPLY.replace('"ok"', '"excellent"'))
