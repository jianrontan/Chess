"""Gate arithmetic: agreement, chance correction, and the split.

If these are wrong the gate rubber-stamps a bad judge, so they are pinned
against hand-computed values.
"""

import pytest

from pipeline.judge_gate import (
    KAPPA_BAR,
    ConfigResult,
    _agreement,
    _kappa,
    _split,
    _verdict,
    report,
    wilson_interval,
)


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


def test_wilson_interval_brackets_and_widens_when_small():
    lo, hi = wilson_interval(85, 100)
    assert lo < 0.85 < hi
    assert lo < 0.80  # the whole point: 85/100 does NOT clear an 80% bar
    lo40, hi40 = wilson_interval(34, 40)  # same 85%, fewer items
    assert (hi40 - lo40) > (hi - lo)  # smaller n must be less certain


def _spread_pairs(reps: int = 1) -> list[tuple[int, int]]:
    """85% agreement over a realistically spread label distribution.

    Skewed fixtures (nearly all 2s) trip the kappa condition before the CI
    condition, which hides the behaviour under test — real label sets have
    a mix, so the fixture must too. Kappa here is ~0.77.
    """
    pairs = (
        [(2, 2)] * 40 + [(1, 1)] * 30 + [(0, 0)] * 15 + [(2, 1)] * 5 + [(1, 0)] * 5 + [(0, 1)] * 5
    )
    return pairs * reps


def test_verdict_passes_a_good_judge_at_a_realistic_label_count():
    # 85% agreement over 100 well-spread labels: the interval clears the
    # usable floor, so this passes. Requiring the interval to clear the
    # 80% BAR instead would need ~275 labels for the same judge, and
    # ~1550 if it were 82% — see USABLE_FLOOR.
    good = _spread_pairs()
    assert _agreement(good)[0] == pytest.approx(0.85)
    assert _kappa(good) > KAPPA_BAR
    assert _verdict(good) == "**PASS**"


def test_verdict_is_inconclusive_when_too_few_labels():
    # Same 85% rate on a tenth of the data: interval now reaches below
    # the usable floor, so it must not claim a pass.
    thin = [(2, 2)] * 4 + [(1, 1)] * 3 + [(0, 0)] * 1 + [(2, 1)] * 1 + [(1, 0)] * 1
    assert _verdict(thin).startswith("inconclusive")


def test_verdict_fails_below_the_bar_regardless_of_precision():
    # 60% agreement measured very precisely is still a failing judge.
    poor = ([(2, 2)] * 6 + [(1, 0)] * 2 + [(0, 1)] * 1 + [(1, 2)] * 1) * 40
    assert _agreement(poor)[0] == pytest.approx(0.60)
    assert _verdict(poor).startswith("fail")  # may fail on kappa or on the bar


def test_verdict_fails_a_distribution_parroting_judge():
    # 80% raw agreement, kappa 0 — must fail on the kappa condition.
    lazy = [(2, 2)] * 80 + [(0, 2)] * 10 + [(1, 2)] * 10
    exact, _ = _agreement(lazy)
    assert exact == 0.8
    assert _verdict(lazy).startswith("fail (kappa")


def test_report_recommends_cheapest_passing_config():
    passing = ([(2, 2)] * 9 + [(0, 0)]) * 20
    failing = [(2, 0)] * 200
    results = [
        _result("sonnet-high", "claude-sonnet-5", passing, (1400, 2000)),
        _result("haiku", "claude-haiku-4-5", failing, (1000, 120)),
    ]
    text = report(results, n_labels=200, holdout=0.0)
    assert "**PASS**" in text
    assert "sonnet-high" in text.split("Recommendation:")[1]


def test_report_distinguishes_inconclusive_from_failed():
    thin = [(2, 2)] * 4 + [(1, 1)] * 3 + [(0, 0)] * 1 + [(2, 1)] * 1 + [(1, 0)] * 1
    text = report([_result("sonnet-low", "claude-sonnet-5", thin)], 10, 0.0)
    assert "Inconclusive, not failed" in text
    assert "do NOT revise the rubric" in text
    assert "Recommendation:" not in text


def test_report_refuses_to_recommend_when_nothing_passes():
    results = [_result("haiku", "claude-haiku-4-5", [(2, 0)] * 100)]
    text = report(results, n_labels=100, holdout=0.0)
    assert "No config passed" in text
    assert "unvalidated" in text
    assert "Recommendation:" not in text
