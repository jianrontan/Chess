# Roadmap

Each phase is independently shippable and each later phase is measured by the one
before it. Check items off as they land.

## Phase 0 — Foundations (done)

- [x] Repo, docs (README, ARCHITECTURE), git conventions
- [x] pnpm workspace: `web/` (Next.js 16, Tailwind 4, shadcn/ui)
- [x] `pipeline/` (uv, python-chess, ruff, pytest) with board helpers + smoke tests
- [x] Design decisions recorded: Cloudflare Workers + Vectorize, MultiPV, two
      interaction modes, no-training rationale

## Phase 1 — Board + engine in the browser

The demo becomes real: a position on screen, analyzed locally.

- [ ] Board UI with `react-chessboard`: set up pieces, paste FEN, play moves
- [ ] Stockfish WASM in a Web Worker, wrapped in a typed client
      (init, `analyze(fen, {multipv: k})`, `gradeMove(fen, move)` via searchmoves)
- [ ] Analysis panel: top-k candidates with evals + PVs, shown as raw lines first
- [ ] Mode 2 skeleton: user plays a move → delta classification
      (good/inaccuracy/mistake/blunder) with the refutation line shown
- Done when: any legal position can be analyzed entirely offline in the browser.

## Phase 2 — Explanations, ungrounded (LLM, no RAG yet)

- [ ] Cloudflare Worker: `/api/explain` endpoint, provider-agnostic LLM client,
      API key in Worker env (`.dev.vars` locally)
- [ ] Prompt v1: position + candidates + PVs + userMove → structured explanation
      (best-move rationale, per-alternative comparison, line walkthroughs)
- [ ] Streaming response into the UI
- [ ] Deploy: Pages (frontend) + Worker, wired to the domain
- Done when: the full user experience works end to end — this is the "with vs
  without RAG" baseline the eval will measure against.

## Phase 3 — Eval harness (pipeline)

The differentiator. Build it before RAG so RAG has a scoreboard on arrival.

- [ ] Download + parse Lichess puzzle CSV; stratified sampler (theme x rating band)
- [ ] Runner: replay setup moves, run the serve pipeline per puzzle
      (native Stockfish here, not WASM)
- [ ] Automatic checks: legality, move-match
- [ ] LLM-judge for explanation/theme correctness (0/1/2 rubric)
- [ ] Hand-label 100-200 explanations; measure judge agreement; report it
- [ ] Report: per-theme accuracy + failure categories (wrong theme / right theme
      wrong reasoning / hallucinated line)
- [ ] Use Batch API + prompt caching to keep sweep cost down
- Done when: one command produces a per-theme scorecard for the current system.

## Phase 4 — Feature extraction + RAG

- [ ] Feature extractor in `pipeline/` (python-chess): checks, forks, pins,
      open files, king safety, material — the shared vocabulary
- [ ] GAMEKNOT corpus: download, clean, filter categories, position-key each
      comment (replay games), chunk to ~20-50k entries
- [ ] Embed + upload to Vectorize
- [ ] Worker: feature-based retrieval, inject top matches into the prompt
- [ ] Mirror the feature extractor in the Worker (TS) or precompute client-side
- Done when: explanations cite retrieved commentary and eval runs with RAG on.

## Phase 5 — The result

- [ ] Full eval sweep: with-RAG vs without-RAG, same stratified sample
- [ ] Write up the delta (per-theme), judge agreement rate, failure analysis,
      and honest limitations
- [ ] Polish demo UX (explanation formatting, line playback on the board)
- Done when: the headline number exists and the demo is shareable.

## Later / out of scope for v1

- Fine-tune a small model on GAMEKNOT and eval it against RAG
- Full-game review mode (annotate every move of a PGN, chess.com game report)
- Opening-theory corpus; user accounts; explanation history
