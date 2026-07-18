"""Train the per-square classifier and export it for the browser.

Small CNN (~250k params) on 32x32 crops -> 13 classes. Class imbalance is
real (roughly half of all squares are empty; kings are 1-per-side rare), so
the loss is weighted by inverse class frequency.

Outputs under runs/<name>/:
- model.pt            best checkpoint (heldout accuracy)
- model.onnx          exported graph
- model.int8.onnx     quantized (what the browser will load)
- metrics.json        per-epoch + final per-class heldout accuracy,
                      ONNX/torch parity, quantized parity
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from vision.render import CLASSES

CROP = 32


class SquareNet(nn.Module):
    def __init__(self, num_classes: int = 13) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 32, 3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),  # 16
            nn.Conv2d(32, 64, 3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),  # 8
            nn.Conv2d(64, 128, 3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Linear(128, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(x).flatten(1))


def iter_batches(shards: list[Path], batch: int, shuffle: bool, seed: int = 0, epoch: int = 0):
    """Stream (x, y) BATCHES shard by shard.

    Memory stays ~one shard, and conversion to float is one vectorized op per
    batch — a per-item IterableDataset spent minutes of pure Python overhead
    per step (looked hung at step 0). Shuffling: shard order by epoch + full
    permutation within each shard (crc32-seeded — hash() is salted per run
    and would make epochs irreproducible).
    """
    import zlib

    order = list(shards)
    if shuffle:
        np.random.default_rng(seed + epoch).shuffle(order)
    for shard in order:
        with np.load(shard) as d:
            images, labels = d["images"], d["labels"]
        idx = np.arange(len(labels))
        if shuffle:
            np.random.default_rng(seed + epoch + zlib.crc32(shard.name.encode()) % 10_000).shuffle(
                idx
            )
        for start in range(0, len(idx), batch):
            chunk = idx[start : start + batch]
            x = torch.from_numpy(images[chunk]).permute(0, 3, 1, 2).float() / 255.0
            y = torch.from_numpy(labels[chunk].astype(np.int64))
            yield x, y


def split_shards(data_dir: Path, split: str) -> list[Path]:
    shards = sorted(data_dir.glob(f"{split}-*.npz"))
    if not shards:
        raise SystemExit(f"no {split} shards in {data_dir} — run vision.build first")
    return shards


def split_label_counts(shards: list[Path]) -> tuple[int, torch.Tensor]:
    total = 0
    counts = torch.zeros(len(CLASSES), dtype=torch.long)
    for shard in shards:
        with np.load(shard) as d:
            labels = d["labels"]
        total += len(labels)
        counts += torch.bincount(torch.from_numpy(labels).long(), minlength=len(CLASSES))
    return total, counts


def class_weights(counts: torch.Tensor) -> torch.Tensor:
    c = counts.float().clamp(min=1)
    return c.sum() / (len(CLASSES) * c)


@torch.no_grad()
def evaluate(model: nn.Module, batches) -> tuple[float, dict[str, float]]:
    model.eval()
    correct = torch.zeros(len(CLASSES))
    total = torch.zeros(len(CLASSES))
    for x, y in batches:
        pred = model(x).argmax(1)
        for c in range(len(CLASSES)):
            mask = y == c
            total[c] += mask.sum()
            correct[c] += (pred[mask] == c).sum()
    per_class = {
        CLASSES[c]: (correct[c] / total[c]).item() if total[c] > 0 else float("nan")
        for c in range(len(CLASSES))
    }
    overall = (correct.sum() / total.sum()).item()
    return overall, per_class


def export_onnx(model: nn.Module, out: Path) -> None:
    model.eval()
    dummy = torch.zeros(1, 3, CROP, CROP)
    torch.onnx.export(
        model,
        (dummy,),
        str(out),
        input_names=["squares"],
        output_names=["logits"],
        dynamic_axes={"squares": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
        # The dynamo exporter mis-handles dynamic_axes here (broken graph,
        # shape-inference errors). The legacy exporter is fine for this
        # tiny static CNN.
        dynamo=False,
    )


def onnx_parity(onnx_path: Path, model: nn.Module, sample: torch.Tensor) -> float:
    """Fraction of predictions where ONNX agrees with the torch model."""
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    with torch.no_grad():
        torch_pred = model(sample).argmax(1).numpy()
    ort_pred = sess.run(None, {"squares": sample.numpy()})[0].argmax(1)
    return float((torch_pred == ort_pred).mean())


def quantize(src: Path, dst: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(str(src), str(dst), weight_type=QuantType.QUInt8)


def quantized_accuracy(onnx_path: Path, batches) -> float:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    correct = 0
    total = 0
    for x, y in batches:
        pred = sess.run(None, {"squares": x.numpy()})[0].argmax(1)
        correct += int((pred == y.numpy()).sum())
        total += len(y)
    return correct / total


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Train the square classifier")
    parser.add_argument("--data", type=Path, default=root / "data")
    parser.add_argument("--run", type=str, default="squarenet")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--limit-shards",
        type=int,
        default=0,
        help="train on only the first N shards (0 = all) — faster runs on a busy machine",
    )
    parser.add_argument(
        "--shards-per-epoch",
        type=int,
        default=0,
        help="rotate a window of N shards per epoch (0 = all): short epochs, full coverage",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="continue from last.pt — training runs as short kill-proof slices",
    )
    parser.add_argument(
        "--quick-eval",
        action="store_true",
        help="evaluate on one heldout shard per epoch (full eval at the end)",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=2,
        help="torch CPU threads; default 2 keeps the machine usable while training",
    )
    args = parser.parse_args()

    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    run_dir = root / "runs" / args.run
    run_dir.mkdir(parents=True, exist_ok=True)

    train_shards = split_shards(args.data, "train")
    if args.limit_shards > 0:
        train_shards = train_shards[: args.limit_shards]
    heldout_shards = split_shards(args.data, "heldout")
    n_train, train_counts = split_label_counts(train_shards)
    n_heldout, _ = split_label_counts(heldout_shards)
    print(f"train: {n_train} squares | heldout: {n_heldout} squares")

    def train_batches(epoch: int):
        shards = train_shards
        if args.shards_per_epoch > 0:
            k = args.shards_per_epoch
            start = (epoch * k) % len(train_shards)
            shards = [train_shards[(start + i) % len(train_shards)] for i in range(k)]
        return iter_batches(shards, args.batch, shuffle=True, seed=args.seed, epoch=epoch)

    def heldout_batches(quick: bool = False):
        shards = heldout_shards[:1] if quick else heldout_shards
        return iter_batches(shards, 1024, shuffle=False)

    per_epoch = args.shards_per_epoch or len(train_shards)
    steps_per_epoch = max(1, (n_train * per_epoch // len(train_shards)) // args.batch)

    model = SquareNet()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"model params: {n_params}")
    criterion = nn.CrossEntropyLoss(weight=class_weights(train_counts))
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    history = []
    best = 0.0
    start_epoch = 0
    last_path = run_dir / "last.pt"
    if args.resume and last_path.exists():
        state = torch.load(last_path, weights_only=False)
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        # The checkpoint carries the old lr — the flag must win on resume so
        # later slices can anneal.
        for group in optimizer.param_groups:
            group["lr"] = args.lr
        start_epoch = state["epoch"] + 1
        best = state["best"]
        history = state["history"]
        print(f"resumed after epoch {state['epoch']} (best {best:.5f})", flush=True)
    if start_epoch >= args.epochs:
        print("already trained to the requested epochs", flush=True)
    for epoch in range(start_epoch, args.epochs):
        model.train()
        t0 = time.time()
        running = 0.0
        steps = 0
        for step, (x, y) in enumerate(train_batches(epoch)):
            optimizer.zero_grad()
            loss = criterion(model(x), y)
            loss.backward()
            optimizer.step()
            running += loss.item()
            steps += 1
            if step % 100 == 0:
                print(
                    f"epoch {epoch} step {step}/{steps_per_epoch} loss {loss.item():.4f}",
                    flush=True,
                )
        overall, per_class = evaluate(model, heldout_batches(quick=args.quick_eval))
        history.append({"epoch": epoch, "loss": running / max(1, steps), "heldout": overall})
        print(
            f"epoch {epoch}: loss {running / max(1, steps):.4f} "
            f"heldout {overall:.5f} ({time.time() - t0:.0f}s)",
            flush=True,
        )
        if overall > best:
            best = overall
            torch.save(model.state_dict(), run_dir / "model.pt")
        torch.save(
            {
                "model": model.state_dict(),
                "optimizer": optimizer.state_dict(),
                "epoch": epoch,
                "best": best,
                "history": history,
            },
            last_path,
        )

    # Reload the best checkpoint for export.
    model.load_state_dict(torch.load(run_dir / "model.pt", weights_only=True))
    overall, per_class = evaluate(model, heldout_batches())

    # Persist training metrics BEFORE the export steps — an export crash
    # must not lose the training results (it did once: missing onnxscript).
    metrics: dict = {
        "params": n_params,
        "history": history,
        "heldout_overall": overall,
        "heldout_per_class": per_class,
    }
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    onnx_path = run_dir / "model.onnx"
    export_onnx(model, onnx_path)
    sample = next(iter(heldout_batches()))[0]  # one heldout batch (1024 crops)
    parity = onnx_parity(onnx_path, model, sample)

    int8_path = run_dir / "model.int8.onnx"
    quantize(onnx_path, int8_path)
    q_acc = quantized_accuracy(int8_path, heldout_batches())

    metrics.update(
        {
            "onnx_parity": parity,
            "quantized_heldout_overall": q_acc,
            "onnx_bytes": onnx_path.stat().st_size,
            "int8_bytes": int8_path.stat().st_size,
        }
    )
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps({k: v for k, v in metrics.items() if k != "history"}, indent=2))


if __name__ == "__main__":
    main()
