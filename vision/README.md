# vision/ — client-side board recognition

Trains the small per-square CNN that replaces the vision-LLM screenshot scan
(ROADMAP Phase 2.5). Digital screenshots only — physical boards are out of
scope. The core idea: we control the renderer, so training data is generated,
never annotated — every image is born with a perfect per-square label grid.

## Layout

- `src/vision/pieces.py` — import piece sets from a lila sparse checkout
  (Lichess) plus Maurizio Monge's chess-art repo; 37 openly-licensed sets
  total, recorded in `PIECE_LICENSES.json` (committed). SVGs land in
  `assets/pieces/` (git-ignored, regenerable).
- `src/vision/sprites.py` — rasterize SVGs → PNG sprites (`assets/sprites/`).
  The only step needing cairo (`uv sync --group raster`).
- `src/vision/render.py` — compose labeled board images: piece sets ×
  themes × square sizes × orientation × coordinates × highlights.
  `labels[iy][ix]` always describes the image cell, regardless of orientation.
- `src/vision/positions.py` — random material-legal FENs (promotion-aware,
  sparse-endgame capable) to fill gaps puzzle positions don't cover.
- `src/vision/dataset.py` — augmented (JPEG artifacts, rescale, crop jitter),
  sharded `.npz` train/heldout split; certain piece sets/themes exist only in
  heldout so training can't cheat.
- `src/vision/build.py` — CLI: build the full sharded dataset.
- `src/vision/train.py` — SquareNet per-square CNN (13 classes, ~212k
  params), checkpoint resume, ONNX export + int8 quantization with parity
  checks (`uv sync --group ml`).
- `src/vision/boardfix.py` — post-processing: resolve duplicate/missing king
  claims across the 64-square prediction grid.
- Not yet built: the browser runtime (onnxruntime-web) and the held-out-style
  accuracy gate (latest run ~98.8% square-level, target ≥99.5%).

## Setup

```sh
uv sync --group raster
git clone --depth 1 --filter=blob:none --sparse https://github.com/lichess-org/lila /tmp/lila
git -C /tmp/lila sparse-checkout set public/piece
uv run python -m vision.pieces /tmp/lila/public/piece
uv run python -m vision.sprites
uv run pytest
```
