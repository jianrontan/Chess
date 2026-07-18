"""The real-screenshot exam: score a trained model on genuine site captures.

Input: a directory with <name>.png board screenshots + manifest.json of
{file, fen} pairs (captured by a browser harness at KNOWN positions — real
renders, labels still free). Boards are assumed White-at-bottom (the
harness's viewpoint). Scores raw predictions AND the king-constraint fix.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import chess
import numpy as np
import torch
from PIL import Image

from vision.boardfix import enforce_kings
from vision.dataset import CROP
from vision.render import CLASS_INDEX, CLASSES, PIECE_TO_CLASS
from vision.train import SquareNet


def fen_to_labels(fen: str, white_bottom: bool = True) -> np.ndarray:
    """Image-ordered labels: row 0 is the TOP of the screenshot.

    The Lichess analysis page orients the board with the SIDE TO MOVE at the
    bottom — black-to-move captures are from Black's viewpoint (this exam
    initially mislabeled exactly those boards as 'wrong', a live rehearsal
    of the product's orientation problem).
    """
    board = chess.Board(fen)
    labels = np.zeros(64, dtype=np.int64)
    for rank_row in range(8):
        for file_col in range(8):
            piece = board.piece_at(chess.square(file_col, 7 - rank_row))
            if piece is not None:
                if white_bottom:
                    idx = rank_row * 8 + file_col
                else:
                    idx = (7 - rank_row) * 8 + (7 - file_col)
                labels[idx] = CLASS_INDEX[PIECE_TO_CLASS[(piece.color, piece.piece_type)]]
    return labels


def board_crops(png: Path) -> torch.Tensor:
    img = Image.open(png).convert("RGB")
    w, h = img.size
    crops = np.empty((64, CROP, CROP, 3), dtype=np.uint8)
    for iy in range(8):
        for ix in range(8):
            box = (
                round(ix * w / 8),
                round(iy * h / 8),
                round((ix + 1) * w / 8),
                round((iy + 1) * h / 8),
            )
            crops[iy * 8 + ix] = np.asarray(
                img.crop(box).resize((CROP, CROP), Image.BILINEAR), dtype=np.uint8
            )
    return torch.from_numpy(crops).permute(0, 3, 1, 2).float() / 255.0


def main() -> None:
    parser = argparse.ArgumentParser(description="Score a model on real screenshots")
    parser.add_argument("shots_dir", type=Path)
    parser.add_argument("--model", type=Path, required=True, help="model.pt checkpoint")
    args = parser.parse_args()

    model = SquareNet()
    model.load_state_dict(torch.load(args.model, weights_only=True))
    model.eval()

    manifest = json.loads((args.shots_dir / "manifest.json").read_text())
    total = raw_correct = fixed_correct = 0
    raw_exact = fixed_exact = 0
    misses: dict[str, int] = {}
    for entry in manifest:
        white_bottom = entry["fen"].split()[1] != "b"
        labels = fen_to_labels(entry["fen"], white_bottom=white_bottom)
        x = board_crops(args.shots_dir / Path(entry["file"]).name)
        with torch.no_grad():
            probs = torch.softmax(model(x), 1).numpy()
        raw = probs.argmax(1)
        fixed = enforce_kings(probs)
        total += 64
        raw_correct += int((raw == labels).sum())
        fixed_correct += int((fixed == labels).sum())
        raw_exact += int((raw == labels).all())
        fixed_exact += int((fixed == labels).all())
        for i in np.flatnonzero(fixed != labels):
            key = f"{CLASSES[labels[i]]}->{CLASSES[fixed[i]]}"
            misses[key] = misses.get(key, 0) + 1

    n = len(manifest)
    report = {
        "boards": n,
        "square_accuracy_raw": raw_correct / total,
        "square_accuracy_kingfix": fixed_correct / total,
        "board_exact_raw": raw_exact / n,
        "board_exact_kingfix": fixed_exact / n,
        "misses_after_fix": dict(sorted(misses.items(), key=lambda kv: -kv[1])),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
