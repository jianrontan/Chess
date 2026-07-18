"""Dataset builder: shards must pair crops with correct labels, and the
holdout split discipline must be enforced in the data itself."""

import json
import random
from pathlib import Path

import numpy as np
import pytest

from vision.dataset import (
    CROP,
    HOLDOUT_SETS,
    HOLDOUT_THEMES,
    Augment,
    _constrained_spec,
    apply_damage,
    build_split,
    slice_crops,
)
from vision.render import BoardRenderer, RenderSpec

SPRITES = Path(__file__).resolve().parents[1] / "assets" / "sprites"
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

pytestmark = pytest.mark.skipif(
    not SPRITES.is_dir(), reason="sprites not rasterized (run vision.sprites first)"
)


@pytest.fixture(scope="module")
def renderer() -> BoardRenderer:
    return BoardRenderer(SPRITES)


def test_slice_matches_labels_without_damage(renderer: BoardRenderer) -> None:
    """With no augmentation, crop (iy,ix) must be exactly the rendered square."""
    img, labels = renderer.render(RenderSpec(fen=START, piece_set="cburnett", square_px=CROP))
    crops = slice_crops(img, Augment(jpeg_quality=None, rescale=1.0, jitter_x=0, jitter_y=0))
    flat = np.asarray(labels).reshape(64)
    assert crops.shape == (64, CROP, CROP, 3)
    # Occupied squares differ from their empty-render counterpart.
    empty_img, _ = renderer.render(
        RenderSpec(fen="8/8/8/8/8/8/8/8 w - - 0 1", piece_set="cburnett", square_px=CROP)
    )
    empty_crops = slice_crops(
        empty_img, Augment(jpeg_quality=None, rescale=1.0, jitter_x=0, jitter_y=0)
    )
    for i in range(64):
        differs = not np.array_equal(crops[i], empty_crops[i])
        assert differs == (flat[i] != 0)


def test_damage_keeps_shapes(renderer: BoardRenderer) -> None:
    img, _ = renderer.render(RenderSpec(fen=START, piece_set="merida", square_px=40))
    for seed in range(5):
        aug = Augment.sample(random.Random(seed))
        crops = slice_crops(apply_damage(img, aug), aug)
        assert crops.shape == (64, CROP, CROP, 3)
        assert crops.dtype == np.uint8


def test_constrained_spec_respects_split(renderer: BoardRenderer) -> None:
    rng = random.Random(3)
    for _ in range(40):
        spec = _constrained_spec(START, renderer, rng, "train")
        assert spec.piece_set not in HOLDOUT_SETS
        assert spec.theme not in HOLDOUT_THEMES
    for _ in range(40):
        spec = _constrained_spec(START, renderer, rng, "heldout")
        assert spec.piece_set in HOLDOUT_SETS
        assert spec.theme in HOLDOUT_THEMES


def test_build_split_writes_consistent_shards(renderer: BoardRenderer, tmp_path: Path) -> None:
    fens = [START] * 7
    manifest = build_split(fens, renderer, tmp_path, "train", seed=1, boards_per_shard=3)
    assert manifest["boards"] == 7
    assert manifest["squares"] == 7 * 64
    assert manifest["shards"] == 3  # 3 + 3 + 1
    total = 0
    for shard in sorted(tmp_path.glob("train-*.npz")):
        data = np.load(shard)
        assert data["images"].shape[1:] == (CROP, CROP, 3)
        assert data["images"].shape[0] == data["labels"].shape[0]
        # Start position: exactly half the squares are occupied.
        assert (data["labels"] != 0).sum() == 32 * (data["labels"].shape[0] // 64)
        total += data["labels"].shape[0]
    assert total == 7 * 64
    saved = json.loads((tmp_path / "train-manifest.json").read_text())
    assert saved["holdout_sets"] == HOLDOUT_SETS
