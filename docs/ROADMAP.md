# Roadmap

Each phase is independently shippable and each later phase is measured by the one
before it. Check items off as they land. Revised after the design review — see
DECISIONS.md for the reasoning behind the starred (*) items.

## Phase 0 — Foundations (done)

- [x] Repo, docs (README, ARCHITECTURE), git conventions
- [x] pnpm workspace: `web/` (Next.js 16, Tailwind 4, shadcn/ui)
- [x] `pipeline/` (uv, python-chess, ruff, pytest) with board helpers + smoke tests
- [x] Design decisions recorded: Cloudflare Workers + Vectorize, MultiPV, two
      interaction modes, no-training rationale
- [x] Design review (3 agents); decisions logged in DECISIONS.md
- [x] Dev env: hooks (ruff/eslint per edit, pytest/tsc per turn), project
      settings.json, /run-eval + /add-puzzle-fixture commands, eval-runner agent

## Phase 1 — Board + engine in the browser

The demo becomes real: a position on screen, analyzed locally.

- [x] *Hello-world stack proven LOCALLY (wrangler dev + Playwright):
      static export + `_headers` COOP/COEP → crossOriginIsolated=true, threaded
      lite engine (8 threads) reached depth 23 in 5s MultiPV 3, same-origin
      /api/health OK. Production deploy pending `wrangler login`.
- [x] *CI: GitHub Actions running ruff+pytest (pipeline) and lint+tsc+build (web)
- [x] Board UI (`react-chessboard` v5 + chess.js): play legal moves, paste FEN
      with validation, undo/reset/flip, auto-analysis on position change
      (debounced, stale-result guarded), White-centric eval display.
      Deferred: piece-editor mode (needed anyway for image-to-FEN confirm),
      promotion picker (auto-queen for now)
- [x] *Stockfish WASM (`stockfish` npm, SF 18 lite ~7MB; full NNUE build is
      108MB > the 25MiB asset limit, not shipped): typed client (init,
      `analyze(fen, {multipv})`, `gradeMove(fen, move)` via searchmoves),
      crossOriginIsolated feature-detect with single-thread lite fallback
      (mobile UI budgets: k=3, fixed movetime, show reached depth — applied
      when the board UI lands)
- [x] Analysis panel: top-k candidates with evals + PVs, progressive display
- [x] *Mode 2: win%-based classification (Lichess formula; grading.ts is
      pure + vitest-tested), instant verdict when the move is in the top k,
      searchmoves at matched movetime otherwise; verdict card with
      refutation line + better alternative
- Done when: any legal position can be analyzed in the browser on the deployed
  site, threaded on desktop, with a working single-thread fallback.

## Phase 2 — Explanations, ungrounded (LLM, no RAG yet)

- [ ] Cloudflare Worker: `/api/explain` endpoint, provider-agnostic LLM client,
      API key in Worker env (`.dev.vars` locally), same-origin route under the
      app's domain
- [ ] *Abuse protection BEFORE the endpoint is public: Turnstile + per-IP rate
      limit + payload caps (k≤5, PV length, image size) + `max_tokens` cap +
      provider-side monthly spend limit
- [ ] *Worker validates client input: replay candidate/PV moves for legality
      (chessops), clamp evals, treat evals as "client-reported"
- [ ] *Prompt v1 as a versioned template file consumed by BOTH the Worker and the
      (future) eval harness — never two copies
- [ ] Streaming response into the UI (pipe the SSE body through; don't buffer)
- [ ] Image-to-FEN v1: vision-LLM call via the Worker; confirm screen shows the
      transcribed board BESIDE the uploaded image with click-to-fix squares,
      one-click orientation flip, and explicit side-to-move + castling inputs
      (an image cannot supply those). Client-side ONNX CV model is the designed
      v2 upgrade (zero cost, zero abuse surface, privacy win).
- [ ] Deploy: static export + Worker, wired to the domain
- Done when: the full user experience works end to end on the public site with
  abuse protection on.

## Phase 3 — Eval harness (pipeline)

The differentiator. Build it before RAG so RAG has a scoreboard on arrival.

- [ ] Download + parse Lichess puzzle CSV; stratified sampler (theme x rating band)
- [ ] Runner: apply the setup move first (CSV FEN is BEFORE the opponent's move),
      then run the serve pipeline per puzzle (native Stockfish, not WASM);
      record prompt version + model ID + engine depth/movetime in every sweep
- [ ] *Automatic checks: legality; move-match scored as "solution move OR
      eval-equivalent move" (engine may pick a different equally-winning move)
- [ ] *LLM-judge from a DIFFERENT model family than the synthesizer (0/1/2 rubric)
- [ ] *Judge validation with a gate: hand-label ~100 explanations (timeboxed, one
      rubric revision); done only if judge-human agreement ≥ 80% on held-out
      labels; report agreement per failure category
- [ ] Report: per-theme accuracy + failure categories (wrong theme / right theme
      wrong reasoning / hallucinated line); theme tags are noisy — note the floor
- [ ] Use Batch API + prompt caching; define sweep N and budget up front
- Done when: `/run-eval` produces a per-theme scorecard for the deployed prompt,
  and the judge has passed its agreement gate.

## Phase 4 — Feature extraction + RAG

- [ ] *Feature vocabulary as a versioned JSON spec at repo root — single source
      of truth for both languages; cross-language golden fixtures (same FENs →
      identical feature sets) tested in pytest AND vitest
- [ ] Feature extractor in `pipeline/` (python-chess) + TS mirror in the Worker,
      both conforming to the spec
- [ ] *GAMEKNOT licensing/provenance spike + fallback corpus identified (e.g.
      permissively licensed annotated PGNs, Lichess studies) BEFORE cleaning code
- [ ] GAMEKNOT corpus: download, clean, filter categories, position-key each
      comment (replay games), chunk
- [ ] *Symmetric retrieval: embed the feature-summary string per chunk (prose as
      metadata payload); Vectorize metadata tag pre-filter + vector re-rank
- [ ] *Pin ONE embedding model available in both planes (bge-base-en-v1.5 768d /
      `@cf/baai/bge-base-en-v1.5`); stamp model+dims into the index name
- [ ] *Vectorize sizing (constrained by the $5/mo budget NFR — Workers Paid is
      ruled out): free tier, either ~13k chunks @ 384d (bge-small) or ~6k
      curated chunks @ 768d (bge-base); pick when corpus quality is visible
- [ ] *Retrieval quality gate BEFORE full embed: ~50-position golden set with
      hand-picked relevant comments; define the recall bar that justifies RAG
- [ ] Worker: feature-based retrieval, inject top matches into the prompt
- Done when: retrieval passes the golden-set gate and eval runs with RAG on.

## Phase 5 — The result

- [ ] *Full eval sweep, three arms on the same stratified sample:
      (1) engine facts only, (2) engine + features (retrieval off),
      (3) engine + features + RAG — so the RAG delta is not confounded with the
      feature delta
- [ ] Write up: per-theme deltas, judge agreement rate, failure analysis, honest
      limitations (corpus level cap, theme-tag noise, judge bias)
- [ ] Polish demo UX (explanation formatting, line playback on the board)
- Done when: the headline number exists and the demo is shareable.

## Later / out of scope for v1

- Client-side ONNX board-recognition model replacing the vision-LLM scan
- Fine-tune a small model on GAMEKNOT and eval it against RAG
- Full-game review mode (annotate every move of a PGN, chess.com game report)
- Opening-theory corpus; user accounts; explanation history
