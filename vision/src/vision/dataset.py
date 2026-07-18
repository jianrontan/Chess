"""Build sharded, augmented training data from FENs.

Each board is rendered (render.py), damaged the way real screenshots are
damaged (JPEG artifacts, rescaling, grid misalignment), then sliced into 64
crops resized to CROP px. Shards are .npz files of uint8 arrays.

SPLIT DISCIPLINE lives here, not in training: entire piece sets and themes
are reserved for the heldout split and never appear in train shards — the
generalization exam is baked into the data layout so a later training script
cannot accidentally cheat.
"""

from __future__ import annotations

import io
import json
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from vision.render import THEMES, BoardRenderer, RenderSpec, random_spec

CROP = 32

# Styles the model must NEVER train on — the generalization exam.
HOLDOUT_SETS = ["staunty", "fantasy", "kiwen-suwi"]
HOLDOUT_THEMES = ["walnut", "purple"]


@dataclass
class Augment:
    """Screenshot-realistic damage + color variation for a rendered board.

    Color jitter is the generalization lever: unseen piece sets differ most
    in PALETTE, and the model must learn that shape carries the class, not
    color. Hue rotation leaves white/black piece identity intact (grays are
    hue-invariant) while scrambling everything colored.
    """

    jpeg_quality: int | None  # None = keep lossless
    rescale: float  # whole-image resize factor before slicing
    jitter_x: int  # grid misalignment in pixels
    jitter_y: int
    hue_shift: int = 0  # 0-255 (PIL HSV wheel)
    saturation: float = 1.0
    brightness: float = 1.0
    contrast: float = 1.0
    grayscale: bool = False

    @staticmethod
    def sample(rng: random.Random, color_jitter: bool = True) -> Augment:
        """color_jitter is for TRAINING data only — the heldout exam must
        stay screenshot-realistic or its number stops meaning anything."""
        return Augment(
            jpeg_quality=rng.randint(40, 95) if rng.random() < 0.7 else None,
            rescale=rng.uniform(0.7, 1.3) if rng.random() < 0.5 else 1.0,
            jitter_x=rng.randint(-3, 3),
            jitter_y=rng.randint(-3, 3),
            hue_shift=rng.randint(0, 255) if color_jitter and rng.random() < 0.5 else 0,
            saturation=rng.uniform(0.5, 1.5) if color_jitter and rng.random() < 0.5 else 1.0,
            brightness=rng.uniform(0.8, 1.2) if color_jitter and rng.random() < 0.5 else 1.0,
            contrast=rng.uniform(0.85, 1.15) if color_jitter and rng.random() < 0.5 else 1.0,
            grayscale=color_jitter and rng.random() < 0.05,
        )


def apply_damage(img: Image.Image, aug: Augment) -> Image.Image:
    from PIL import ImageEnhance

    if aug.grayscale:
        img = img.convert("L").convert("RGB")
    elif aug.hue_shift:
        hsv = np.asarray(img.convert("HSV")).copy()
        hsv[..., 0] = (hsv[..., 0].astype(np.int16) + aug.hue_shift) % 256
        img = Image.fromarray(hsv, "HSV").convert("RGB")
    if aug.saturation != 1.0:
        img = ImageEnhance.Color(img).enhance(aug.saturation)
    if aug.brightness != 1.0:
        img = ImageEnhance.Brightness(img).enhance(aug.brightness)
    if aug.contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(aug.contrast)
    if aug.rescale != 1.0:
        w, h = img.size
        img = img.resize((max(8, round(w * aug.rescale)), max(8, round(h * aug.rescale))))
    if aug.jpeg_quality is not None:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=aug.jpeg_quality)
        buf.seek(0)
        img = Image.open(buf).convert("RGB")
    return img


def slice_crops(img: Image.Image, aug: Augment) -> np.ndarray:
    """Cut the (possibly damaged) board into 64 CROP x CROP crops."""
    w, h = img.size
    sq_w, sq_h = w / 8, h / 8
    out = np.empty((64, CROP, CROP, 3), dtype=np.uint8)
    for iy in range(8):
        for ix in range(8):
            x0 = round(ix * sq_w) + aug.jitter_x
            y0 = round(iy * sq_h) + aug.jitter_y
            x1 = round((ix + 1) * sq_w) + aug.jitter_x
            y1 = round((iy + 1) * sq_h) + aug.jitter_y
            crop = img.crop((max(0, x0), max(0, y0), min(w, x1), min(h, y1)))
            out[iy * 8 + ix] = np.asarray(crop.resize((CROP, CROP), Image.BILINEAR), dtype=np.uint8)
    return out


def _constrained_spec(
    fen: str, renderer: BoardRenderer, rng: random.Random, split: str
) -> RenderSpec:
    """random_spec restricted to the split's allowed piece sets / themes."""
    if split == "heldout":
        allowed_sets = [s for s in renderer.piece_sets() if s in HOLDOUT_SETS]
        allowed_themes = HOLDOUT_THEMES
    else:
        allowed_sets = [s for s in renderer.piece_sets() if s not in HOLDOUT_SETS]
        allowed_themes = [t[0] for t in THEMES if t[0] not in HOLDOUT_THEMES]
    for _ in range(50):
        spec = random_spec(fen, renderer, rng)
        if spec.piece_set in allowed_sets and spec.theme in allowed_themes:
            return spec
    # Force-fix the style; keep the rest of the sampled spec.
    spec = random_spec(fen, renderer, rng)
    return RenderSpec(
        fen=spec.fen,
        piece_set=rng.choice(allowed_sets),
        theme=rng.choice(allowed_themes),
        square_px=spec.square_px,
        orientation_white=spec.orientation_white,
        coordinates=spec.coordinates,
        highlight_squares=spec.highlight_squares,
    )


def build_split(
    fens: list[str],
    renderer: BoardRenderer,
    out_dir: Path,
    split: str,
    seed: int,
    boards_per_shard: int = 500,
) -> dict:
    """Render every FEN once and write shards. Returns the split manifest."""
    rng = random.Random(seed)
    out_dir.mkdir(parents=True, exist_ok=True)
    shard_images: list[np.ndarray] = []
    shard_labels: list[np.ndarray] = []
    shard_idx = 0
    written = 0

    def flush() -> None:
        nonlocal shard_idx, shard_images, shard_labels, written
        if not shard_images:
            return
        images = np.concatenate(shard_images)
        labels = np.concatenate(shard_labels)
        np.savez_compressed(out_dir / f"{split}-{shard_idx:04d}.npz", images=images, labels=labels)
        written += len(labels)
        shard_idx += 1
        shard_images, shard_labels = [], []
        print(f"{split}: shard {shard_idx} written ({written} squares)", flush=True)

    for i, fen in enumerate(fens):
        spec = _constrained_spec(fen, renderer, rng, split)
        img, labels = renderer.render(spec)
        aug = Augment.sample(rng, color_jitter=split == "train")
        crops = slice_crops(apply_damage(img, aug), aug)
        shard_images.append(crops)
        shard_labels.append(np.asarray(labels, dtype=np.uint8).reshape(64))
        if (i + 1) % boards_per_shard == 0:
            flush()
    flush()

    manifest = {
        "split": split,
        "boards": len(fens),
        "squares": written,
        "seed": seed,
        "crop": CROP,
        "holdout_sets": HOLDOUT_SETS,
        "holdout_themes": HOLDOUT_THEMES,
        "shards": shard_idx,
    }
    (out_dir / f"{split}-manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest
