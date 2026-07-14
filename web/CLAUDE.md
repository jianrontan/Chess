# web/ — the live app (TypeScript)

Next.js 16 (App Router) + React + Tailwind 4 + shadcn/ui. Part of the pnpm workspace
rooted at the repo top — run installs from the repo root (`pnpm install`), and scripts
via `pnpm --filter web <script>` or from this directory.

## Conventions
- TypeScript strict; `@/*` maps to `src/*`. **Never use `any`** (ESLint enforces
  `no-explicit-any` as an error) — use `unknown` + narrowing, or proper types.
- Tailwind 4 is CSS-first: the theme lives in `src/app/globals.css` (`@theme`
  blocks); there is no tailwind.config.js. GitHub's language bar showing "CSS"
  is this file — we are on Tailwind.
- shadcn/ui components live in `src/components/ui/` — add new ones with
  `pnpm dlx shadcn@latest add <name>`, don't hand-write them.
- ESLint via `pnpm lint`; build check via `pnpm build`.

## Architecture rules
- **Stockfish runs client-side as WebAssembly in a Web Worker** — never on a server.
  Use the WASM build here; the native binary belongs to `/pipeline` only.
- The backend is a **thin Cloudflare Worker** (LLM proxy + Vectorize retrieval).
  The LLM API key lives ONLY in Worker env / `.dev.vars` — never in browser code,
  never in NEXT_PUBLIC_* vars.
- No server containers, no server-side chess compute. Keep the Worker stateless.
- Chessboard UI: `react-chessboard`. Positions are passed around as FEN strings.
