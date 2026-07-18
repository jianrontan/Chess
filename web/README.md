# web/ — Chess Explanation Engine (frontend + Worker)

Next.js 16 (App Router) static export + a thin Cloudflare Worker backend
(LLM proxy with Turnstile, rate limiting, and a daily budget). Stockfish runs
client-side as WASM in a Web Worker. Part of the repo's pnpm workspace —
run installs from the repo root (`pnpm install`).

## Commands

- `pnpm dev` — Next.js dev server (copies the engine assets first)
- `pnpm preview` — build + `wrangler dev` (full stack, including the Worker)
- `pnpm deploy` — build + `wrangler deploy`
- `pnpm test` — vitest
- `pnpm lint` — eslint

See `CLAUDE.md` in this directory for conventions, architecture rules, and the
Windows wrangler gotcha, and `docs/ARCHITECTURE.md` at the repo root for the
full system design.
