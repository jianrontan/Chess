# Decisions log

Running record of design decisions, the considerations behind them, and what was
deliberately deferred. Newest at the bottom. Keep entries short; ARCHITECTURE.md
holds the full design, this file holds the *why* and the rejected alternatives.

## 2026-07-14 — Initial stack

**Decided:** Cloudflare Workers + Vectorize backend; Next.js (App Router) + React +
shadcn/ui + Tailwind frontend; Stockfish WASM client-side; Claude Haiku default
behind a provider-agnostic proxy; Python (uv) offline pipeline; no training or
fine-tuning anywhere.

**Considerations:** the engine in the browser removes the need for any always-on
container (vs the poker bot's $10/mo); a thin Worker exists solely because the
LLM API key cannot live in browser JS. Open-source LLMs were considered for the
live path and rejected for v1 — hosting adds moving parts to save money that
isn't being spent; they remain a cost lever for eval sweeps and a legitimate
future eval axis.

## 2026-07-14 — MultiPV + two interaction modes

**Decided:** run the engine in MultiPV mode (top k = 3-5) and support both
"what should I play?" and chess.com-style "grade my move" (via `searchmoves`
when the tried move isn't in the top k).

**Considerations:** eval deltas between candidates power "why not X"; each
candidate's PV is the refutation/continuation story. Marginal cost is zero
because the engine runs on the visitor's CPU.

## 2026-07-14 — Design review (3 agents) and resulting corrections

A roadmap review, a technical design review, and a dev-environment review were
run. Findings accepted and folded into ARCHITECTURE.md / ROADMAP.md:

1. **Deployment substrate (was a blocker):** "Next.js on Cloudflare Pages" was
   stale — next-on-pages is deprecated, Next 16 unsupported. **Decided: static
   export (`output: 'export'`) on Workers Static Assets**; we need no SSR since
   the backend is a separate Worker. Rejected: OpenNext-on-Workers (heavier,
   only pays off if SSR is ever wanted).
2. **COOP/COEP headers are load-bearing:** threaded Stockfish WASM requires
   SharedArrayBuffer requires `COOP: same-origin` + `COEP: require-corp`; with
   static assets these go in `_headers`. Consequences accepted: API Worker must
   be same-origin; all subresources CORP/CORS-clean; feature-detect
   `crossOriginIsolated` with a single-thread lite fallback. Phase 1 starts with
   a hello-world deploy proving this end to end before any real code.
3. **Vectorize free tier doesn't fit the corpus:** 20-50k chunks x 768d = 15-38M
   stored dims vs 5M free. **Deferred to Phase 4** (Workers Paid $5/mo vs ~13k
   chunks @ 384d) — the corpus doesn't exist yet; docs no longer claim $0.
4. **Abuse protection promoted to a Phase 2 gate:** unauthenticated Worker
   fronting a paid API = drained budget. Turnstile + per-IP rate limit + payload
   caps + max_tokens cap + provider spend limit, before the endpoint is public.
5. **Client input is untrusted:** Worker replays candidate/PV moves for legality,
   clamps evals, labels them client-reported (also a prompt-injection surface).
6. **Symmetric retrieval:** embed feature-summary strings (not raw prose; prose
   as metadata payload), metadata tag pre-filter + vector re-rank, and a
   ~50-position golden retrieval set as a quality gate before the full embed.
7. **One pinned embedding model both planes:** bge-base-en-v1.5 (768d), local
   sentence-transformers == `@cf/baai/bge-base-en-v1.5` on Workers AI; model+dims
   stamped in the index name.
8. **Feature vocabulary = versioned JSON spec at repo root** with cross-language
   golden fixtures in pytest and vitest (Python/TS drift would silently rot
   retrieval).
9. **Single-sourced prompts:** the eval harness scores the exact versioned
   template the Worker ships — never a replica; every sweep records prompt
   version + model + engine settings.
10. **Three-arm eval** (engine only / +features / +features+RAG) so the RAG
    delta isn't confounded with the feature delta.
11. **Eval harness traps recorded:** Lichess CSV FEN is before the setup move;
    move-match scored as solution-or-eval-equivalent; theme tags are noisy
    (error floor); judge from a different model family than the synthesizer,
    with an explicit >= 80% agreement gate on ~100 hand labels.
12. **Mode 2 grading:** win-percentage deltas (Lichess conversion), not raw
    centipawns; searchmoves run must match the MultiPV run's movetime/depth.
13. **Mobile budgets:** single-thread lite build, k=3, fixed movetime (~depth
    10-14), reached depth shown in the UI.
14. **Engine package pinned:** `stockfish` npm (SF 18, maintained);
    lichess `stockfish.wasm` repos are legacy.
15. **GAMEKNOT licensing spike** before any cleaning code; fallback corpus
    identified (permissive annotated PGNs, Lichess studies).
16. **CI in Phase 1:** GitHub Actions, ruff+pytest and lint+tsc+build.

## 2026-07-14 — Image-to-FEN input

**Decided:** v1 = vision-LLM transcription via the Worker (ships in a day,
<1 cent/scan, behind the same abuse protections). v2 upgrade path = open-source
CV model client-side (ONNX Runtime Web; chesscog/LiveChess2FEN approach): $0 per
scan, no abuse surface, image never leaves the device — deferred because
piece-set variety makes it days-to-weeks of work.

**Non-negotiable either way:** the confirmation UI. An image cannot supply
side-to-move, castling rights, or en passant — the UI asks. Transcribed board
rendered beside the upload, click-to-fix squares, one-click orientation flip
(inverted-board case). Single-piece vision errors are common and easy for the
eye to skim past.

## 2026-07-14 — Dev environment

**Decided:** hooks (ruff/eslint per edit via PostToolUse, pytest/tsc per turn
via Stop hook, Python dispatchers for Windows compat); committed project
`.claude/settings.json` allowlist; `/run-eval` + `/add-puzzle-fixture` commands;
`eval-runner` subagent (keeps sweep logs out of context); edmunds plugin
uninstalled in favor of direct playwright + context7 MCP servers.

**Rejected:** Cloudflare MCP servers (built-in skills + wrangler CLI cover it),
GitHub MCP (gh CLI wins), Python MCPs (uv run output is already ideal),
devcontainer (uv pins everything; Stockfish binary handled by a pinned-release
download script + STOCKFISH_PATH).

**Code conventions added:** no `any` in TypeScript (ESLint `no-explicit-any` =
error); Tailwind 4 is CSS-first — the big globals.css is the theme config, which
is why GitHub's language bar shows "CSS".

## 2026-07-14 — Non-functional requirements

**Decided:** hard budget of **$5/month** at expected scale (~30 users launch
month, ~5/month after); latency targets of ~10s top-k analysis, ~3s move
grading, streaming explanation with first words ~2s (all "tune by feel later").

**Considerations:** per-explanation LLM cost is ~half a cent on Haiku, so the
launch month lands around $2.50 — the budget binds on infrastructure, not
tokens. Its main effect: **Workers Paid ($5/mo) is ruled out**, which resolves
the previously deferred Vectorize question to the free tier (~13k chunks @384d
or ~6k @768d). Rate limits get sized so one abusive user cannot blow the monthly
cap. Move grading at ~3s is compatible with the matched-depth rule because a
single-move `searchmoves` to the top-k run's depth is far cheaper than the full
MultiPV search. One-time costs (eval sweeps, embedding) sit outside the monthly
cap.
