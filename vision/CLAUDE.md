# vision/ — board recognition (Python)

Separate uv project from `/pipeline` on purpose: it isolates the heavy ML deps
(torch, onnx) so the pipeline stays lean. Trains the per-square CNN behind the
in-browser screenshot scan (ROADMAP Phase 2.5). Digital screenshots only.

## Toolchain
- **uv** with dependency groups: `uv sync` for the core, `--group raster` for
  cairo-based SVG rasterization (sprites), `--group ml` for torch/ONNX
  (build/train). Never `pip install` into system Python.
- ruff + pytest, same conventions as `/pipeline` (see `pipeline/CLAUDE.md`).

## Conventions
- **Heldout split discipline lives in the data, not the trainer:** certain
  piece sets and board themes appear ONLY in the heldout shards
  (`dataset.py`). Never let a training run touch them; the Phase 2.5 accuracy
  gate is meaningless otherwise.
- **Deterministic seeding:** Python's `hash()` is salted per process — use
  `zlib.crc32` or fixed seeds for anything that must reproduce across runs.
- `assets/` (SVGs, sprites), `data/` (shards), and `runs/` (checkpoints,
  ONNX, metrics) are git-ignored and regenerable. Commit only
  `PIECE_LICENSES.json` and code.
- `PIECE_LICENSES.json` must stay in sync with every imported piece source —
  only openly-licensed sets ship.
- Training is long-running and must be kill-proof: checkpoint resume is the
  norm (`train.py`), never assume a run finishes in one sitting.
