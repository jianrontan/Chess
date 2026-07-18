# Chess Explanation Engine

## What this is
Given a chess position, produce a plain-English explanation of what's going on and
what to play. The core design principle: **the LLM never reasons about chess unaided —
it only *translates* trustworthy inputs (engine facts + retrieved human commentary)
into prose.** That grounding is what suppresses hallucination.

**The bar ("why not just ChatGPT?"):** a raw LLM plays illegal moves and invents
reasoning. The value here is *grounded, verifiable* explanations — every claim
traceable to Stockfish's evaluation or to retrieved commentary, and measured by an
automated eval harness. Don't drift toward generic-LLM shortcuts that break that chain.

## Why this project is unusual: it's verifiable
Move legality (python-chess) and move-match (UCI compare vs Lichess puzzle solutions)
are deterministically checkable. The agent can be handed ground truth to check itself
against — the single biggest lever on quality. Lean into this everywhere (tests, hooks,
fixtures).

## The pipeline (5 stages)
1. **Input** — a position as FEN.
2. **Engine** — Stockfish returns best move + evaluation (this is ground truth; never override it).
3. **Feature extraction** — convert the board into describable facts (open files, exposed
   king, forks) via python-chess + light LLM tagging. The bridge that makes retrieval possible.
4. **Retrieval (RAG)** — use those features to fetch matching human commentary
   (Chess Stack Exchange, public-domain annotated classics, Lichess studies) from Vectorize.
5. **Synthesis** — LLM weaves position + engine facts + retrieved commentary into plain English.

Off to the side: the **eval harness** grades output on Lichess puzzles. Legality and
move-match are *plumbing* checks (near-100% by construction if the move comes from
Stockfish). The real signal is **theme/explanation correctness**, graded by a validated
LLM-judge. Headline result = explanation accuracy **with vs without RAG**.

## Repo structure (monorepo)
- `/pipeline` — Python. Offline data parsing, feature extraction, embeddings, eval.
  Runs on the homelab, never in production.
- `/web` — TypeScript. The live app.
- `/vision` — Python (separate uv project; isolates heavy ML deps from
  `/pipeline`). Board-recognition subproject: generated training data,
  per-square CNN, ONNX export for the in-browser screenshot scan.
- `/docs` — design docs; `docs/ARCHITECTURE.md` is the definitive system design.
  Two interaction modes: "what should I play?" (MultiPV top-k candidates + PVs)
  and "let me try a move" (chess.com-style grading: eval delta classification +
  refutation line, via `searchmoves` when the move isn't in the top k).
  `docs/private/` is git-ignored personal notes.

Per-directory `CLAUDE.md` files should be added to each as they're built, so Python and
TS conventions don't bleed into each other. This root file is the shared context.

## Stack (decided)
**Web (live):**
- **Next.js (App Router)** + React, **shadcn/ui** + **Tailwind**, `react-chessboard`.
- **Stockfish compiled to WebAssembly**, in a Web Worker — the engine runs client-side
  on the visitor's machine (free compute; this is the key cost insight).
- **Cloudflare Worker** = thin backend holding the LLM API key + doing retrieval.
  **Cloudflare Vectorize** = vector store. Frontend = **Next.js static export
  (`output: 'export'`) on Workers Static Assets** — NOT Pages (next-on-pages is
  deprecated); COOP/COEP headers via `_headers` for threaded Stockfish WASM.
  Standing infra cost ~$0.

**Pipeline (offline):** Python + `uv`, `ruff`, `pytest`, python-chess, and a **native
Stockfish binary** (not the WASM build) for batch ground-truth generation.

**LLM:** default **Claude Haiku 4.5** for explanations and eval grading (step up to
Sonnet 5 where quality matters). Keep the Worker **provider-agnostic** so the model is
swappable. Use **prompt caching + Batch API** to cut eval-sweep cost. **Embeddings:**
local `sentence-transformers` or Cloudflare Workers AI (free, one-time). Open-source
models are a viable cost lever for eval sweeps later, but hosted Haiku is the default for
the live path. (See `claude-api` skill for current model IDs/pricing before coding LLM calls.)

## Build order (mirrors the project itself)
1. **Engine + LLM explainer** (zero corpus) — self-verifying from day one via a pytest
   legality check.
2. **Eval harness** against puzzle theme tags.
3. **RAG retrieval** (clean-licensed corpus) — then measure the with/without-RAG delta.

## Data (all git-ignored — see `.gitignore`)
- **Lichess puzzle DB** (~6M puzzles, CC0): positions + eval gold set (FEN, solution,
  themes). Both position source and eval answer key.
- **RAG corpus (clean-licensed only — DECISIONS.md 2026-07-16):** Chess Stack
  Exchange dumps (CC BY-SA 4.0; quotable verbatim WITH attribution + link) +
  public-domain annotated classics (Capablanca, Ed. Lasker; pre-1931 US rule —
  Chernev is NOT PD) + optional Wikibooks openings. **Lichess studies** (API
  export) are retrieve-and-ground only — never display their raw text.
  **GAMEKNOT is out**: its EULA owns all user comments; offline-eval benchmark
  at most, never in the public index.
- **PGN games:** Lichess Elite DB (avoid the 200GB/month raw dumps; pgnmentor
  dropped — no license statement).

Keep raw data out of git; commit only small test fixtures with `git add -f`.

## Dev environment
- Heavy offline work (parsing ~6M puzzles, native Stockfish, embeddings, eval batches) →
  run on the homelab PC, reach it over Tailscale.
- Web app → develop locally, deploy to the Cloudflare free tier.
- Consider a devcontainer pinning the Python toolchain + Stockfish binary for reproducibility.

## Git conventions
- **Commit often** — small, coherent commits that each leave the project working.
- Message style: `feat:` / `fix:` (also `chore:`, `refactor:`, `docs:` as needed).
  One line for small changes; for bigger ones add a body with bullet points explaining
  the *why*.
- **Do not** add "Co-authored-by", Claude attribution, or tool footers. Keep messages light.
- Solo project: work on `main`; branch only for risky/experimental work.
