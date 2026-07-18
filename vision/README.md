# vision/ — client-side board recognition

Trains the small per-square CNN that replaces the vision-LLM screenshot scan
(ROADMAP Phase 2.5). Digital screenshots only — physical boards are out of
scope. The core idea: we control the renderer, so training data is generated,
never annotated — every image is born with a perfect per-square label grid.

## Layout

- `src/vision/pieces.py` — import Lichess piece sets from a lila sparse
  checkout; only openly-licensed sets, recorded in `PIECE_LICENSES.json`
  (committed). SVGs land in `assets/pieces/` (git-ignored, regenerable).
- `src/vision/sprites.py` — rasterize SVGs → PNG sprites (`assets/sprites/`).
  The only step needing cairo (`uv sync --group raster`).
- `src/vision/render.py` — compose labeled board images: 32 piece sets ×
  themes × square sizes × orientation × coordinates × highlights.
  `labels[iy][ix]` always describes the image cell, regardless of orientation.
- Coming next: dataset builder (augmentation), training, ONNX export, and the
  held-out-style accuracy gate.

## Setup

```sh
uv sync --group raster
git clone --depth 1 --filter=blob:none --sparse https://github.com/lichess-org/lila /tmp/lila
git -C /tmp/lila sparse-checkout set public/piece
uv run python -m vision.pieces /tmp/lila/public/piece
uv run python -m vision.sprites
uv run pytest
```
