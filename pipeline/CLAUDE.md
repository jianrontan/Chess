# pipeline/ — the offline pipeline (Python)

Data parsing, feature extraction, embeddings, and the eval harness. Runs on the homelab
(or locally), **never in production**. Its one shipped artifact is the vector index
uploaded to Cloudflare Vectorize.

## Toolchain
- **uv** manages everything: `.venv`, deps, running. Never `pip install` into system
  Python. Commands: `uv run pytest`, `uv run ruff check .`, `uv add <pkg>`.
- **ruff** for lint + format (config in `pyproject.toml`), **pytest** for tests
  (`tests/`, package code in `src/pipeline/`).
- Python 3.12+. The PyPI dep is `python-chess` but the import is `chess`.

## Conventions
- Board/legality logic goes through `src/pipeline/board.py` helpers — don't reinvent
  FEN parsing or move validation inline.
- Everything checkable should be checked: moves validated against `board.legal_moves`,
  bad fixtures fail loudly. Legality is this project's ground-truth lever.
- Use the **native Stockfish binary** here for batch ground-truth (git-ignored,
  downloaded per machine) — not the WASM build, which belongs to `/web`.
- Raw data (Lichess puzzle CSV, commentary corpora, PGNs) lives in `data/` and is git-ignored.
  Commit only small fixtures under `tests/fixtures/` (force-add: `git add -f`).

## Eval harness principles (when built)
- Stratify eval samples by theme and rating band; report per-theme accuracy.
- Legality + move-match are plumbing checks; explanation/theme correctness (LLM-judge,
  validated against a hand-labelled sample) is the real signal.
- Headline metric: explanation accuracy with vs without RAG.
