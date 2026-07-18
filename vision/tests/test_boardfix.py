import numpy as np
import pytest

from vision.boardfix import BK, WK, enforce_kings


def uniform_probs(labels: list[int]) -> np.ndarray:
    """Probs peaked at the given label per square, mild elsewhere."""
    probs = np.full((64, 13), 0.01)
    for i, lab in enumerate(labels):
        probs[i, lab] = 0.9
    return probs


def test_passthrough_when_legal() -> None:
    labels = [0] * 64
    labels[10] = WK
    labels[50] = BK
    probs = uniform_probs(labels)
    assert list(enforce_kings(probs)) == labels


def test_duplicate_king_demoted_to_next_best() -> None:
    labels = [0] * 64
    labels[10] = WK
    labels[11] = WK  # impostor
    labels[50] = BK
    probs = uniform_probs(labels)
    probs[10, WK] = 0.95  # square 10 is the more confident king
    probs[11, 5] = 0.5  # impostor's next-best: wQ
    fixed = enforce_kings(probs)
    assert fixed[10] == WK
    assert fixed[11] == 5  # reassigned to wQ, not just erased
    assert (fixed == WK).sum() == 1


def test_missing_king_promoted_from_best_candidate() -> None:
    labels = [0] * 64
    labels[50] = BK  # black king present, white king missing
    probs = uniform_probs(labels)
    probs[20, WK] = 0.4  # square 20 quietly suspected of being the wK
    fixed = enforce_kings(probs)
    assert fixed[20] == WK
    assert fixed[50] == BK


def test_missing_king_never_steals_the_other_king() -> None:
    labels = [0] * 64
    labels[50] = BK
    probs = uniform_probs(labels)
    # The bK square also has the highest wK score — must not be taken.
    probs[50, WK] = 0.8
    probs[20, WK] = 0.3
    fixed = enforce_kings(probs)
    assert fixed[50] == BK
    assert fixed[20] == WK


def test_rejects_bad_shape() -> None:
    with pytest.raises(ValueError):
        enforce_kings(np.zeros((32, 13)))
