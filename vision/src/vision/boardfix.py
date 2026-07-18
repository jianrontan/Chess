"""Chess-aware post-processing of raw per-square predictions.

The classifier treats squares independently; chess doesn't. The hardest
constraint — exactly one king per side — is also where confident nonsense
shows up (a stylized queen misread as a king leaves the board with two).
Given the model's per-square class probabilities:

1. For each side, the KING claim with the highest confidence keeps it;
   every other square claiming that king is reassigned to its best
   non-that-king class.
2. If a side has NO king claim, the square with the highest king
   probability among all squares (that isn't the other side's king) is
   promoted to king.

This is deliberately minimal — material plausibility (9 pawns etc.) is NOT
enforced here, because the model can legitimately see positions our editor
would reject, and the confirm screen is still downstream.
"""

from __future__ import annotations

import numpy as np

WK = 6  # CLASSES.index("wK")
BK = 12  # CLASSES.index("bK")


def enforce_kings(probs: np.ndarray) -> np.ndarray:
    """probs: (64, 13) softmax/logit scores. Returns fixed class ids (64,).

    Works on scores, not argmax labels — reassignments pick each square's
    next-best legal class instead of guessing.
    """
    if probs.shape != (64, 13):
        raise ValueError(f"expected (64, 13), got {probs.shape}")
    pred = probs.argmax(1).copy()

    for king in (WK, BK):
        claimants = np.flatnonzero(pred == king)
        if len(claimants) > 1:
            keeper = claimants[np.argmax(probs[claimants, king])]
            for sq in claimants:
                if sq == keeper:
                    continue
                masked = probs[sq].copy()
                masked[king] = -np.inf
                pred[sq] = int(masked.argmax())
        elif len(claimants) == 0:
            other_king = BK if king == WK else WK
            candidates = np.flatnonzero(pred != other_king)
            sq = candidates[np.argmax(probs[candidates, king])]
            pred[sq] = king
    return pred
