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
from torch.utils.data import DataLoader, TensorDataset

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


def load_split(data_dir: Path, split: str) -> TensorDataset:
    images_list, labels_list = [], []
    shards = sorted(data_dir.glob(f"{split}-*.npz"))
    if not shards:
        raise SystemExit(f"no {split} shards in {data_dir} — run vision.build first")
    for shard in shards:
        with np.load(shard) as d:
            images_list.append(d["images"])
            labels_list.append(d["labels"])
    images = torch.from_numpy(np.concatenate(images_list)).permute(0, 3, 1, 2).float() / 255.0
    labels = torch.from_numpy(np.concatenate(labels_list)).long()
    return TensorDataset(images, labels)


def class_weights(labels: torch.Tensor) -> torch.Tensor:
    counts = torch.bincount(labels, minlength=len(CLASSES)).float().clamp(min=1)
    weights = counts.sum() / (len(CLASSES) * counts)
    return weights


@torch.no_grad()
def evaluate(model: nn.Module, loader: DataLoader) -> tuple[float, dict[str, float]]:
    model.eval()
    correct = torch.zeros(len(CLASSES))
    total = torch.zeros(len(CLASSES))
    for x, y in loader:
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


def quantized_accuracy(onnx_path: Path, loader: DataLoader) -> float:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    correct = 0
    total = 0
    for x, y in loader:
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
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    run_dir = root / "runs" / args.run
    run_dir.mkdir(parents=True, exist_ok=True)

    train_ds = load_split(args.data, "train")
    heldout_ds = load_split(args.data, "heldout")
    print(f"train: {len(train_ds)} squares | heldout: {len(heldout_ds)} squares")

    train_loader = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=0)
    heldout_loader = DataLoader(heldout_ds, batch_size=1024, num_workers=0)

    model = SquareNet()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"model params: {n_params}")
    weights = class_weights(train_ds.tensors[1])
    criterion = nn.CrossEntropyLoss(weight=weights)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    history = []
    best = 0.0
    for epoch in range(args.epochs):
        model.train()
        t0 = time.time()
        running = 0.0
        for step, (x, y) in enumerate(train_loader):
            optimizer.zero_grad()
            loss = criterion(model(x), y)
            loss.backward()
            optimizer.step()
            running += loss.item()
            if step % 200 == 0:
                print(f"epoch {epoch} step {step} loss {loss.item():.4f}", flush=True)
        overall, per_class = evaluate(model, heldout_loader)
        history.append({"epoch": epoch, "loss": running / len(train_loader), "heldout": overall})
        print(
            f"epoch {epoch}: loss {running / len(train_loader):.4f} "
            f"heldout {overall:.5f} ({time.time() - t0:.0f}s)",
            flush=True,
        )
        if overall > best:
            best = overall
            torch.save(model.state_dict(), run_dir / "model.pt")

    # Reload the best checkpoint for export.
    model.load_state_dict(torch.load(run_dir / "model.pt", weights_only=True))
    overall, per_class = evaluate(model, heldout_loader)

    onnx_path = run_dir / "model.onnx"
    export_onnx(model, onnx_path)
    sample = heldout_ds.tensors[0][:2048]
    parity = onnx_parity(onnx_path, model, sample)

    int8_path = run_dir / "model.int8.onnx"
    quantize(onnx_path, int8_path)
    q_acc = quantized_accuracy(int8_path, heldout_loader)

    metrics = {
        "params": n_params,
        "history": history,
        "heldout_overall": overall,
        "heldout_per_class": per_class,
        "onnx_parity": parity,
        "quantized_heldout_overall": q_acc,
        "onnx_bytes": onnx_path.stat().st_size,
        "int8_bytes": int8_path.stat().st_size,
    }
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps({k: v for k, v in metrics.items() if k != "history"}, indent=2))


if __name__ == "__main__":
    main()
