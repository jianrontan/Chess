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
- or arrive at a position by playing moves on the board.

The app then answers three questions a human coach would answer:

1. **What is the best move here?**
2. **Why is it the best move — and why are the other candidate moves worse?**
3. **What happens next in each line — if I play this, how does the game continue?**

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

**Step 3 — Request to the Worker.** The browser POSTs to a Cloudflare Worker:

```json
{
  "fen": "…",
  "candidates": [
    { "move": "d5c7", "eval": 520,  "pv": ["d5c7", "e8d8", "c7a8", "…"] },
    { "move": "d5b6", "eval": 110,  "pv": ["d5b6", "a8c8", "…"] },
    { "move": "d1f3", "eval": 40,   "pv": ["d1f3", "c8c8", "…"] }
  ]
}
```

The Worker holds the LLM API key (the browser never sees it) and is stateless.

**Step 4 — Feature extraction.** A raw position is piece coordinates; you cannot
search a prose library with coordinates. So the position (and the candidate lines)
are converted into describable facts: "knight fork on king and rook", "back rank
weak", "open c-file", "king stuck in the center". Cheap structural features come
from board logic; the tactical labeling can be assisted by a fast LLM call. These
features become the retrieval query.

**Step 5 — Retrieval (the RAG part).** The features are embedded and used to query
**Cloudflare Vectorize**, which holds ~20–50k chunks of human chess commentary
(see build plane below). The top matches — human explanations of *similar
situations* — come back as text. Retrieval brings the vocabulary and pedagogy of
real annotators: how humans actually explain a fork, why "winning the exchange"
matters, what a plan looks like in this structure.

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
   human-written explanation), plus optional opening-theory text.
2. **Clean and filter:** drop the noisy categories (bare descriptions, chatter),
   keep explanations of plans, quality judgments, and comparisons; dedupe;
   normalize the informal forum prose. Expect to land at ~20–50k good chunks.
3. **Key each chunk by position:** for every comment, replay its game with
   python-chess to the position it refers to, and store the FEN plus extracted
   features (the same feature vocabulary the serve plane uses) as metadata. The
   comment text is what gets embedded.
4. **Embed and upload:** a sentence-embedding model (local sentence-transformers or
   Cloudflare Workers AI — free either way) turns each chunk into a vector;
   vectors + metadata are uploaded to Vectorize.

The shared feature vocabulary between build and serve is the load-bearing design
decision: the serve plane asks "positions with a knight fork and an exposed king"
and the index can answer, because chunks were labeled the same way.

**The eval harness (the project's differentiator):**

Each Lichess puzzle is a free answer key: FEN, solution moves, and theme tags
("fork", "pin", "backRankMate"). The harness:

1. samples puzzles stratified by theme and rating band,
2. runs the full serve pipeline on each position,
3. grades three signals:
   - **legality** (automatic, python-chess) — plumbing check,
   - **move match** vs the puzzle solution (automatic) — plumbing check,
   - **explanation correctness** — does the prose identify and correctly apply the
     right tactic? Graded by an LLM judge that is first validated against a
     hand-labelled sample of 100–200 explanations,
4. reports per-theme accuracy and failure categories, and — the headline — the
   explanation score **with retrieval versus without**, which measures whether the
   RAG layer actually earns its place.

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

### Cost model (why this is nearly free to run)

| Piece | Where it runs | Cost |
| --- | --- | --- |
| Engine (MultiPV analysis) | Visitor's browser (WASM) | 0 |
| Frontend | Cloudflare Pages | 0 (free tier) |
| Worker + Vectorize | Cloudflare | 0 at this scale (free tiers) |
| Explanation LLM call | Claude API | ~1 call per request; cents/day at demo traffic |
| Corpus embedding | Homelab / Workers AI | one-time, ~0 |
| Eval sweeps | Batch API + prompt caching | tens of dollars, one-time per sweep |

The expensive-looking parts (engine compute, alternatives, deep lines) are free
because they happen on the client. The only metered resource is LLM tokens, and
the serve path uses exactly one synthesis call per request.

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
