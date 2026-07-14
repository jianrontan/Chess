# Architecture: how the Chess Explanation Engine works

This is the definitive design document. The README gives the elevator pitch; this
explains exactly what happens, end to end, and why each piece exists. It is written
in two passes: first in plain language, then the precise mechanics.

---

## Part 1 — What the user experiences

### The core interaction

The user gives the app a chess position. They can:

- set up pieces on the board by hand,
- paste a FEN string (a one-line text encoding of a position),
- arrive at a position by playing moves on the board,
- or **upload an image of a board** (a screenshot from a site or book diagram,
  or a photo) and have the app read the position from it.

### Image-to-FEN

Image input is a convenience layer in front of the same pipeline: the image is
converted to FEN, then everything proceeds as if the user had typed that FEN.

Design (v1): the browser sends the image to the Worker, which asks a
vision-capable LLM to transcribe the board into FEN. The result is validated
(piece-count/king sanity rules in TS) and then — critically — **confirmed by the
user**, because vision transcription of chess diagrams is decent but single-piece
errors are common, and a silently wrong square would poison every downstream
explanation. The confirm screen is designed to make errors findable and fixable:

- the transcribed board rendered **side by side with the uploaded image**,
- click any square to fix a wrong or missing piece,
- a one-click **orientation flip** (photos and screenshots are often from
  Black's side, and an inverted board is a valid-looking but wrong position),
- explicit **side-to-move and castling-rights inputs** — an image fundamentally
  cannot supply these, so the UI asks rather than guesses.

Two honest caveats. First, angled photos of physical boards are best-effort;
clean screenshots are the reliable case. Second, the vision call is metered and
is an upload endpoint, so it sits behind the same abuse protections as the
explain endpoint.

The designed v2 upgrade is a **traditional open-source CV model running
client-side** (board detection + per-square piece classifier, compiled to run in
the browser via ONNX Runtime Web — the approach of projects like chesscog and
LiveChess2FEN). That path costs nothing per scan, has no abuse surface, and the
image never leaves the user's device — the same "compute in the visitor's
browser" principle as the engine. It is deferred, not chosen first, because it
is days-to-weeks of work (piece-set variety across chess sites is the hard
part) versus a day for the vision-LLM route, and the confirmation UI is
required in both designs anyway.

From there, there are two interaction modes — the same two a chess.com analysis
board offers:

**Mode 1 — "What should I play?"** The app answers three questions a human coach
would answer:

1. **What is the best move here?**
2. **Why is it the best move — and why are the other candidate moves worse?**
3. **What happens next in each line — if I play this, how does the game continue?**

**Mode 2 — "Let me try a move."** The user plays a candidate move on the board and
the app grades it, chess.com-style:

1. **How good was that?** — classified by how much evaluation it gave up versus
   the best move: excellent / good / inaccuracy / mistake / blunder.
2. **Why?** — if the move is wrong, the app shows the concrete refutation: the
   opponent's punishing reply and the line that follows, explained in words.
3. **What was better?** — the best move, with its explanation, one click away.

For example, if the user tries Qxb7 in a position where it loses the queen:

> **Qxb7? — blunder (+0.8 → −6.5)**
>
> The queen grabs a pawn but walks into a trap: Black replies Rb8, pinning your
> queen against the king. The queen cannot escape, and after ...Rxb7 you have
> lost a queen for a rook. The best move was Qd3, keeping the queen safe and
> maintaining your edge.

### A concrete example

Suppose the user sets up a position where White has a knight on d5 and Black's queen
and rook are both reachable by it. The app responds with something like:

> **Best move: Nc7+ (evaluation: +5.2)**
>
> The knight checks the king from c7 and simultaneously attacks the rook on a8 —
> a fork. Black must deal with the check first, so the rook cannot be saved. After
> the forced Kd8, the knight captures on a8 and White is up a full rook.
>
> **Why not the alternatives?**
> - **Nxb6 (+1.1):** wins a pawn, but lets the rook escape. You trade a winning
>   tactic for a small material edge.
> - **Qf3 (+0.4):** develops with pressure, but Black consolidates with ...Rc8 and
>   the tactical window closes.
>
> **The main line continues:** 1. Nc7+ Kd8 2. Nxa8 Qb8 3. Nb6 — the knight escapes,
> and White converts the extra material.

Every part of that answer is grounded: the moves and numbers come from a chess
engine, the concepts ("fork", "forced", "consolidates") are anchored by retrieved
human commentary, and the language model only assembles the pieces into prose.

### Why this is not "just ask ChatGPT"

A language model asked cold about a chess position routinely proposes illegal moves
and invents confident, wrong justifications. This app never lets the model reason
about chess on its own:

- **Which moves are good** is decided by Stockfish, a chess engine far stronger than
  any human. The model cannot override it.
- **What the concepts mean** is anchored by real human commentary retrieved from a
  database of annotated games.
- **The model's only job** is translation: turning engine numbers and retrieved
  commentary into readable English.

And, critically, the output is measured. An automated harness grades the system
against thousands of tactics puzzles with known answers, so "the explanations are
good" is a number, not a hope.

---

## Part 2 — The exact mechanics

### Overview: two planes, one shared artifact

```
BUILD PLANE (offline, Python, homelab)        SERVE PLANE (online, TS, per request)
────────────────────────────────────          ──────────────────────────────────────
raw data → clean → embed → upload   ──────►   Vectorize index ──► retrieval
eval harness (grades the system)              browser engine ──► facts
                                              LLM ──► prose
```

The two planes never call each other directly. The build plane's only shipped
artifact is the vector index; the serve plane reads it at request time.

### The serve plane: one request, step by step

**Step 0 — Deployment substrate (decided after review).** The frontend is a
Next.js **static export** (`output: 'export'`) served from **Cloudflare Workers
Static Assets** — not Cloudflare Pages (`next-on-pages` is deprecated and does
not support Next 16). This choice is load-bearing: multi-threaded Stockfish WASM
requires `SharedArrayBuffer`, which requires the COOP/COEP headers
(`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`) on the document — and with static
assets those are set declaratively in a `_headers` file. Without them the engine
silently falls back to a single-threaded build, several times weaker at the same
latency. Consequences we accept: every cross-origin subresource must be
CORP/CORS-clean, so the API Worker lives **same-origin** under the app's domain,
and the client feature-detects `crossOriginIsolated` with an explicit
single-thread lite fallback (primarily for older mobile browsers).

**Step 1 — Position in.** The UI (Next.js + react-chessboard) holds the current
position as a FEN string. All legality on the client is enforced by the board
library; the engine only ever sees legal positions.

**Step 2 — Engine analysis, in the browser.** Stockfish compiled to WebAssembly
runs in a Web Worker on the visitor's machine. We run it in **MultiPV mode**
(multi principal variation), asking for the top k candidate moves (k = 3–5)
instead of just the single best. For each candidate the engine returns:

- the move itself,
- a numerical evaluation (centipawns, or mate-in-N),
- the **principal variation (PV)** — the sequence of best play for both sides
  that follows, typically 10–20 plies deep.

This one decision is what powers the whole "why not the alternatives" and "what
happens next" experience:

- The **eval delta** between move 1 and move 2 says *how much worse* the
  alternative is (a 4-point drop means a missed tactic; a 0.3 drop means a matter
  of style).
- Each candidate's **PV is the refutation or continuation**: for the best move it
  shows the plan working; for an inferior move it shows concretely how the
  opponent punishes it or how the advantage evaporates.

Running MultiPV costs nothing extra in infrastructure because the engine runs on
the visitor's CPU.

**Step 2b — Grading a user's move (Mode 2).** When the user tries a move of their
own, one of two things is true:

- The move is already among the top k candidates — we have its eval and PV for free.
- It is not (the interesting case). We run one extra engine search restricted to
  that single move (UCI `searchmoves`), which returns its true evaluation and its
  **refutation line** — the opponent's best punishment.

The move is then classified by its delta against the best move — computed on
**win percentage** (the Lichess conversion from centipawns), not raw centipawns,
because a 100cp drop matters enormously in an equal position and not at all when
already +9. Thresholds follow the familiar chess.com-style classes (good /
inaccuracy / mistake / blunder). Two disciplines keep the delta honest: the
`searchmoves` grading run must use the **same movetime/depth** as the MultiPV
run (a cross-depth delta is skewed), and the UI shows the reached depth so a
shallow mobile analysis is never dressed up as a deep one. The delta and
refutation PV become engine facts for synthesis, exactly like the candidates in
Mode 1. The extra search also runs in the browser, so Mode 2 costs no more than
Mode 1: one LLM call.

**Engine budgets by device:** desktop (cross-origin isolated) gets the threaded
NNUE build with k = 3–5 and a fixed movetime of a few seconds; mobile gets the
single-thread lite build, k = 3, fixed movetime — realistically depth 10–14,
enough for tactics. Fixed movetime, never fixed depth, so weak devices degrade
in quality rather than hanging.

**Step 3 — Request to the Worker.** The browser POSTs to a Cloudflare Worker:

```json
{
  "fen": "…",
  "candidates": [
    { "move": "d5c7", "eval": 520,  "pv": ["d5c7", "e8d8", "c7a8", "…"] },
    { "move": "d5b6", "eval": 110,  "pv": ["d5b6", "a8c8", "…"] },
    { "move": "d1f3", "eval": 40,   "pv": ["d1f3", "c8c8", "…"] }
  ],
  "userMove": { "move": "d1b7", "eval": -650, "pv": ["d1b7", "c8b8", "…"] }
}
```

`userMove` is present only in Mode 2; the Worker's synthesis prompt then centers
on grading that move against the candidates rather than presenting the candidates
alone. The Worker holds the LLM API key (the browser never sees it) and is
stateless.

**The Worker trusts nothing from the client.** The payload above is
attacker-controllable input to a paid API, so before any LLM call the Worker:

- validates the FEN and **replays every candidate/PV move for legality** (a
  TS chess library does this in ~1ms) — garbage or injected "moves" are rejected,
  never forwarded into the prompt;
- clamps evals to sane ranges and labels them "client-reported" in the prompt —
  a spoofed +900 for a losing move can degrade one user's own explanation, but
  the prompt never treats client numbers as verified truth;
- enforces payload caps: k ≤ 5, bounded PV length, bounded image size.

**And the endpoint defends itself.** An unauthenticated Worker fronting a paid
LLM API would be drained by a script overnight. Before the endpoint is public:
Cloudflare Turnstile verification, per-IP rate limiting, a `max_tokens` cap per
call, and a provider-side monthly spend limit as the backstop. The image
endpoint (vision calls) is the most expensive surface and gets the strictest
limits.

**Step 4 — Feature extraction.** A raw position is piece coordinates; you cannot
search a prose library with coordinates. So the position (and the candidate lines)
are converted into describable facts: "knight fork on king and rook", "back rank
weak", "open c-file", "king stuck in the center". Cheap structural features come
from board logic; the tactical labeling can be assisted by a fast LLM call. These
features become the retrieval query.

**Step 5 — Retrieval (the RAG part).** The features are embedded and used to query
**Cloudflare Vectorize**, which holds the corpus of human chess commentary
(see build plane below). The top matches — human explanations of *similar
situations* — come back as text. Retrieval brings the vocabulary and pedagogy of
real annotators: how humans actually explain a fork, why "winning the exchange"
matters, what a plan looks like in this structure.

Retrieval is deliberately **symmetric**: what gets embedded at build time is not
the raw narrative prose but each chunk's **feature-summary string** — the same
vocabulary the serve plane queries with — with the prose carried as metadata
payload. (Embedding informal forum narration and querying it with terse feature
strings is an asymmetric-retrieval mismatch that quietly returns noise.) Exact
feature tags are additionally stored as Vectorize metadata, so retrieval is a
hard tag pre-filter first, vector similarity as re-ranking second. Retrieval
quality is gated before the full corpus is embedded: a ~50-position golden set
with hand-picked relevant comments must hit an agreed recall bar, or the RAG
design gets revisited rather than shipped blind.

**Step 6 — Synthesis.** The Worker builds one prompt containing:

- the position (FEN),
- all k candidates with evals and PVs (the facts),
- the extracted features (the concepts),
- the retrieved commentary (the human grounding),
- strict instructions: *explain only these moves and these lines; never invent
  moves or evaluations; cite tactics by name only when the features support it.*

One LLM call (Claude Haiku by default, provider swappable) produces the structured
explanation: best move rationale, per-alternative comparison, and a plain-English
walkthrough of each line. The response streams back to the browser.

**What the model is never allowed to do:** choose moves, estimate evaluations,
extend lines beyond the PV, or assert a tactic the features do not support. If the
engine did not say it and retrieval did not ground it, it does not go in the
answer.

### The build plane: where the grounding comes from

Everything runs in `/pipeline` (Python, uv), on the homelab. It runs occasionally,
by hand — never per user request.

**Corpus construction (one-time, then occasional refreshes):**

1. **Source:** the GAMEKNOT commentary dataset — ~298k pairs of (game move,
   human-written explanation), plus optional opening-theory text. Before any
   cleaning code is written: a licensing/provenance check (it is scraped forum
   content from a 2018 research project) and an identified fallback corpus
   (permissively licensed annotated PGNs, Lichess studies).
2. **Clean and filter:** drop the noisy categories (bare descriptions, chatter),
   keep explanations of plans, quality judgments, and comparisons; dedupe;
   normalize the informal forum prose. Expect to land at ~20–50k good chunks.
3. **Key each chunk by position:** for every comment, replay its game with
   python-chess to the position it refers to, and store the FEN plus extracted
   features (the same feature vocabulary the serve plane uses). What gets
   **embedded** is the chunk's feature-summary string; the prose rides along as
   metadata payload (see Step 5's symmetric-retrieval rationale).
4. **Embed and upload:** one pinned embedding model, **byte-identical between
   build and query time** — bge-base-en-v1.5 (768d), which exists both as a local
   sentence-transformers model and as `@cf/baai/bge-base-en-v1.5` on Workers AI.
   Model + dimensions are stamped into the Vectorize index name so a mismatch is
   impossible to miss. Sizing note: 20–50k chunks × 768d exceeds the Vectorize
   free tier (5M stored dims); the call between Workers Paid ($5/mo, plenty) and
   a smaller 384d corpus is deferred until the corpus actually exists.

The shared feature vocabulary between build and serve is the load-bearing design
decision: the serve plane asks "positions with a knight fork and an exposed king"
and the index can answer, because chunks were labeled the same way. Because it
is implemented twice (Python at build, TS at serve), the vocabulary lives in a
**versioned JSON feature-spec at the repo root** — single source of truth — with
cross-language golden fixtures (same FENs must yield identical feature sets)
tested in both pytest and vitest, so silent drift between the two
implementations is caught by CI instead of quietly rotting retrieval.

**The eval harness (the project's differentiator):**

Each Lichess puzzle is a free answer key: FEN, solution moves, and theme tags
("fork", "pin", "backRankMate"). The harness:

1. samples puzzles stratified by theme and rating band (applying the setup move
   first — the CSV's FEN is the position *before* the opponent's last move),
2. runs the serve pipeline on each position — the **same versioned prompt
   template the Worker ships**, never a re-implementation, with prompt version,
   model ID, and engine depth/movetime recorded in every sweep,
3. grades three signals:
   - **legality** (automatic, python-chess) — plumbing check,
   - **move match** — scored as "the solution move OR an eval-equivalent move",
     because the engine may legitimately pick a different equally-winning move
     (and Lichess itself accepts alternate same-length mates),
   - **explanation correctness** — does the prose identify and correctly apply the
     right tactic? Graded by an LLM judge from a **different model family than
     the synthesizer** (to avoid a model grading its own accent), validated
     against a hand-labelled sample of ~100 explanations with an explicit gate:
     judge–human agreement ≥ 80% on held-out labels, reported per failure
     category,
4. reports per-theme accuracy and failure categories (theme tags are
   auto-generated and noisy, so per-theme numbers carry an error floor), and —
   the headline — a **three-arm comparison** on the same sample: engine facts
   only, engine + features (retrieval off), engine + features + RAG. Three arms,
   not two, so the RAG delta is not confounded with the feature delta.

### Do we need to train anything?

**No model training or fine-tuning, anywhere.** This is a deliberate design
property, worth stating precisely:

| Component | Training needed | What we use instead |
| --- | --- | --- |
| Move selection | None | Stockfish, as-is |
| Explanation writing | None | An off-the-shelf LLM, constrained by the prompt |
| Embeddings | None | A pre-trained sentence-embedding model, as-is |
| Retrieval | None | Vector similarity search over the prepared corpus |
| Eval judge | None | An LLM judge — but it must be **validated**, see below |

The only training-*adjacent* work is human labeling for the judge: we hand-label
100–200 explanations (right theme / wrong theme / right theme but wrong reasoning)
and measure how often the LLM judge agrees with the human labels. If agreement is
high, the judge is trusted to grade the full eval sweeps. This is validation of a
grader, not training of a model — no weights change.

If we ever wanted to go further (fine-tuning a small model on GAMEKNOT to write
explanations directly), that would be a research extension, and the eval harness
we already built is exactly the instrument that could measure whether it beats the
RAG approach. It is out of scope for v1.

### Honest limitations

- **The corpus caps the ceiling.** GAMEKNOT commentary is mostly club-player
  level, not grandmaster prose. Retrieval grounds the explanations; it cannot
  make them deeper than the source material.
- **Engine numbers are not human reasons.** Stockfish knows Nc7+ wins; it does not
  know it is "a fork". The feature-extraction bridge is the fragile, interesting
  part, and eval failures will concentrate there.
- **PVs are lines, not narratives.** A 16-ply PV is a proof, but users want the
  two or three meaningful moments in it. Deciding what to say about a line (and
  what to skip) is prompt-engineering work that the eval harness will pressure-test.
- **Judge bias.** The LLM judge can reward fluent-but-wrong prose; the
  hand-labelled validation set is the guard, and its agreement rate gets reported
  alongside the results.

### Non-functional requirements

Set 2026-07-14. These are product constraints, not aspirations — designs that
violate them get changed.

**Budget: ≤ $5/month total** at the expected scale (~30 users in the launch
month, ~5 users/month after). Consequences:

- LLM spend fits easily: ~half a cent per explanation on Haiku means a 450-request
  launch month costs ~$2.50 and steady state under $0.50.
- **Workers Paid ($5/mo) is ruled out** — it would consume the entire budget. The
  Vectorize corpus therefore lives on the free tier: ~13k chunks @ 384d
  (bge-small) or ~6k curated chunks @ 768d (bge-base); exact pick made in
  Phase 4 when corpus quality is visible.
- Per-user rate limits are sized so a single abusive or runaway user cannot
  exceed the monthly cap; the provider-side spend limit is the backstop.
- One-time costs (eval sweeps, corpus embedding) are budgeted separately and are
  not part of the monthly cap.

**Latency targets (rough, to be tuned by feel once real):**

| Interaction | Target | Mechanism |
| --- | --- | --- |
| Top-k analysis (Mode 1) | ≤ ~10s to settled evals | fixed-movetime MultiPV, threaded on desktop; progressive display as depth climbs |
| Grade a tried move (Mode 2) | ≤ ~3s | single-move `searchmoves` to the same depth as the top-k run (searching one move is far cheaper than all) |
| Explanation | first words ≤ ~2s, complete ~3-5s | streaming from the Worker; Haiku is fast |
| Image-to-FEN scan | ≤ ~5s to the confirm screen | one vision call |

Engine analysis should render progressively (evals visibly deepening) rather
than blocking on the full 10 seconds — perceived latency matters more than
wall-clock.

### Cost model (why this is nearly free to run)

| Piece | Where it runs | Cost |
| --- | --- | --- |
| Engine (MultiPV analysis) | Visitor's browser (WASM) | 0 |
| Frontend | Workers Static Assets | 0 (free tier) |
| Worker | Cloudflare | 0 at this scale (free tier) |
| Vectorize | Cloudflare | free tier (Workers Paid ruled out by the $5/mo budget NFR): ~13k chunks @384d or ~6k @768d, picked in Phase 4 |
| Explanation LLM call | Claude API | ~1 call per request; cents/day at demo traffic |
| Image-to-FEN (v1) | Claude API (vision) | well under a cent per scan; v2 client-side CV model would be 0 |
| Corpus embedding | Homelab / Workers AI | one-time, ~0 |
| Eval sweeps | Batch API + prompt caching | tens of dollars, one-time per sweep |

The expensive-looking parts (engine compute, alternatives, deep lines) are free
because they happen on the client. The metered resources are LLM tokens (one
synthesis call per request, capped and rate-limited) and possibly $5/mo for
vector storage if the full corpus is kept at 768 dimensions.

---

## Appendix: glossary

- **FEN** — a chess position as one line of text. The save-file format for a board.
- **PGN** — a whole game as text: the move list, optionally with comments.
- **UCI** — move notation like `e2e4` (from-square, to-square); also the protocol
  used to talk to engines.
- **Stockfish** — the strongest widely-used open-source chess engine. Outputs best
  moves and numeric evaluations; does not produce prose.
- **MultiPV** — engine mode returning the top k moves each with its own line,
  instead of only the best one.
- **searchmoves** — engine option restricting analysis to specific moves; how we
  get the true eval and refutation of a user-tried move that isn't in the top k.
- **Principal variation (PV)** — the engine's expected sequence of best play for
  both sides from a given move.
- **Centipawn** — 1/100 of a pawn; the unit of engine evaluations. +520 means
  "winning by roughly five pawns' worth".
- **RAG** — Retrieval-Augmented Generation: fetch relevant reference text first,
  then have the model write from it instead of from memory.
- **Embedding** — a list of numbers capturing a text's meaning, so similarity can
  be computed. How retrieval finds "commentary about forks" without keyword match.
- **GAMEKNOT dataset** — ~298k (move, human explanation) pairs scraped from the
  GAMEKNOT forum by a 2018 research project; our retrieval corpus.
- **Eval harness** — the automated grader: runs the system on puzzles with known
  answers and scores legality, move match, and explanation correctness.
- **LLM judge** — a model used as the grader for explanation quality, trusted only
  after its agreement with hand labels is measured.
