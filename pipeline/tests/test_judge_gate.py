"""Gate arithmetic: agreement, chance correction, and the split.

If these are wrong the gate rubber-stamps a bad judge, so they are pinned
against hand-computed values.
"""

import pytest

from pipeline.judge_gate import ConfigResult, _agreement, _kappa, _split, report


def test_agreement_exact_and_within_one():
    pairs = [(2, 2), (2, 1), (0, 2), (1, 1)]
    exact, within1 = _agreement(pairs)
    assert exact == 0.5  # two exact matches of four
    assert within1 == 0.75  # (0,2) is the only miss by more than one


def test_agreement_empty_is_zero_not_crash():
    assert _agreement([]) == (0.0, 0.0)


def test_kappa_perfect_and_chance():
    assert _kappa([(2, 2), (1, 1), (0, 0)]) == pytest.approx(1.0)

    # A judge that always says "2" against labels that are mostly "2":
    # high raw agreement, but kappa must expose it as chance-level.
    lazy = [(2, 2)] * 8 + [(0, 2), (1, 2)]
    exact, _ = _agreement(lazy)
    assert exact == 0.8  # would PASS the raw bar
    assert _kappa(lazy) == pytest.approx(0.0, abs=1e-9)  # ...but is worthless


def test_kappa_beats_chance_when_judge_tracks_disagreement():
    pairs = [(2, 2)] * 5 + [(0, 0)] * 3 + [(1, 1)] * 2
    assert _kappa(pairs) == pytest.approx(1.0)


def test_split_is_deterministic_and_partitions():
    keys = [(f"p{i}", "candidates") for i in range(400)]
    first = [_split(k, 0.4) for k in keys]
    assert first == [_split(k, 0.4) for k in keys]  # stable across calls
    assert set(first) == {"tune", "holdout"}
    holdout_share = first.count("holdout") / len(first)
    assert 0.3 < holdout_share < 0.5  # roughly the requested fraction


def _result(name, model, pairs, cost_tokens=(1000, 200)):
    r = ConfigResult(
        name=name,
        model=model,
        effort=None,
        pairs={"tune": [], "holdout": pairs},
        by_category={"ok": pairs},
        errors=0,
        in_tokens=cost_tokens[0],
        out_tokens=cost_tokens[1],
        judged=1,
    )
    return r


def test_report_recommends_cheapest_passing_config():
    passing = [(2, 2)] * 9 + [(1, 1)]
    failing = [(2, 0)] * 10
    results = [
        _result("sonnet-high", "claude-sonnet-5", passing, (1400, 2000)),
        _result("haiku", "claude-haiku-4-5", failing, (1000, 120)),
    ]
    text = report(results, n_labels=10, holdout=0.4)
    assert "**PASS**" in text
    assert "Recommendation:" in text
    assert "sonnet-high" in text.split("Recommendation:")[1]


def test_report_refuses_to_recommend_when_nothing_passes():
    results = [_result("haiku", "claude-haiku-4-5", [(2, 0)] * 10)]
    text = report(results, n_labels=10, holdout=0.4)
    assert "No config passed" in text
    assert "unvalidated" in text
    assert "Recommendation:" not in text
