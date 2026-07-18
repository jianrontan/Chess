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

- [x] *Hello-world stack proven locally AND in production
      (https://chess.jianrontan.com, custom domain on the jianrontan.com zone):
      COOP/COEP headers live → crossOriginIsolated=true, threaded lite engine
      (8 threads), same-origin /api/health OK, rate limit + daily budget
      verified against the deployed Worker.
- [x] *CI: GitHub Actions running ruff+pytest (pipeline) and lint+tsc+build (web)
- [x] Board UI (`react-chessboard` v5 + chess.js): play legal moves, paste FEN
      with validation, undo/reset/flip, auto-analysis on position change
      (debounced, stale-result guarded), White-centric eval display.
      Deferred: promotion picker (auto-queen for now)
- [x] Board editor mode: spare-piece palette, free placement, drag-off to
      remove, side-to-move toggle, castling derived from placement, validated
      apply (rejects missing kings / impossible checks). Reusable for the
      image-to-FEN confirm screen in Phase 2.
- [x] *Stockfish WASM (`stockfish` npm, SF 18 lite ~7MB; full NNUE build is
      108MB > the 25MiB asset limit, not shipped): typed client (init,
      `analyze(fen, {multipv})`, `gradeMove(fen, move)` via searchmoves),
      crossOriginIsolated feature-detect with single-thread lite fallback
      (mobile UI budgets: k=3, fixed movetime, show reached depth — applied
      when the board UI lands)
- [x] Analysis panel: top-k candidates with evals + PVs, progressive display
- [x] *Mode 2: win%-based classification (Lichess formula; grading.ts is
      pure + vitest-tested), instant verdict when the move is in the top k,
      searchmoves at the baseline's reached DEPTH otherwise (matched depth,
      not movetime — users move before analysis finishes); verdict card with
      refutation line + better alternative; explicit "not graded" state;
      baselines fen-tagged so a stale position can never grade a move
- Done when: any legal position can be analyzed in the browser on the deployed
  site, threaded on desktop, with a working single-thread fallback.

## Phase 2 — Explanations, ungrounded (LLM, no RAG yet)

- [x] Cloudflare Worker: `/api/explain` endpoint, provider-agnostic LLM client
      (Anthropic + deterministic fake; fake runs until a key exists), API key in
      Worker env (`.dev.vars` locally), same-origin route under the app's domain
- [x] *Abuse protection: payload caps, `max_tokens` cap, per-IP rate limit
      (10/min), global daily budget (Durable Object, `DAILY_BUDGET`/day),
      invisible Turnstile on every LLM endpoint (credentialless-iframe host
      page — Turnstile can't run under the engine's COEP). Non-Chromium
      browsers: one-time top-level pre-clearance -> HMAC-signed 1h cookie
      (/api/verify). Provider-side monthly spend limit: user-managed.
- [x] *Worker validates client input: replay candidate/PV moves for legality
      (chess.js), clamp evals, payload caps (k≤5, PV≤12, 16KB body), treat
      evals as "client-reported"; prompt built only from our re-serialization
- [x] *Prompt v1 as a versioned template file consumed by BOTH the Worker and the
      (future) eval harness — never two copies (`prompts/explain.v1.json`)
- [x] Streaming response into the UI (provider chunks → chunked text response →
      streamed into the explanation card; "Explain position" + "Explain this
      move" buttons)
- [x] Image-to-FEN v1: /api/scan (Haiku vision behind the same gates as
      explain; model output validated by chess.js, never trusted); client
      downscales to 1024px; confirm screen = board editor beside the photo,
      side-to-move set by the user. Verified e2e (screenshot of our own board
      -> exact FEN). Client-side ONNX CV model is the designed v2 upgrade
      (zero cost, zero abuse surface, privacy win).
- [x] Deploy: static export + Worker, wired to chess.jianrontan.com; live
      Haiku explanations (API key as Worker secret, real request verified)
- Done when: the full user experience works end to end on the public site with
  abuse protection on. ✅ 2026-07-18 — live Haiku explanations confirmed by a
  human in prod, all gates active, non-Chromium fallback verified e2e.

## Phase 3 — Eval harness (pipeline)

The differentiator. Build it before RAG so RAG has a scoreboard on arrival.

- [x] Parse Lichess puzzle CSV (zst streaming, FEN-before-setup-move handled,
      legality replay on everything sampled) + stratified sampler (theme x
      rating band, per-cell reservoir, quality filters, seeded/deterministic);
      `python -m pipeline.sample_puzzles` writes a validated JSONL sample.
      Remaining: run it against the full ~6M-row dump (homelab download).
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
- [x] *GAMEKNOT licensing/provenance spike DONE — outcome: GAMEKNOT is
      unusable for the public index (no license, EULA owns all comments;
      offline-eval-only at most). See DECISIONS.md 2026-07-16.
- [ ] Corpus (swap signed off, DECISIONS.md 2026-07-17): Chess Stack Exchange dump
      (CC BY-SA, quotable with attribution) + public-domain annotated classics
      (+ optional Wikibooks openings); Lichess studies via API export under a
      retrieve-and-ground/never-quote policy. Download, clean, position-key,
      chunk.
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
- Fine-tune a small model on an annotated-commentary corpus and eval it against RAG
- Full-game review mode (annotate every move of a PGN, chess.com game report)
- Opening-theory corpus; user accounts; explanation history
