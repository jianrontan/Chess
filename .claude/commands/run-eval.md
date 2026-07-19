---
description: Run an eval sweep and report the per-theme scorecard
argument-hint: [--sample-size N] [--depth D] [--llm fake|anthropic] [--judge]
---
Run an eval-harness sweep with args: $ARGUMENTS

Modules (all in `pipeline/`, run with `uv run python -m ...` from that dir):

- `pipeline.run_eval` — synthesis sweep. Key flags: `--out` (required),
  `--llm fake|anthropic`, `--depth` (14 default), `--sample-size N` (seeded,
  stratification-preserving — use this to size down, NOT `--limit`),
  `--concurrency` (6 default; the sweep is LLM-latency-bound). Resumable:
  rerunning the same `--out` skips finished puzzles.
- `pipeline.judge_eval` — judge pass. `--effort low|medium|high` is the
  dominant cost lever (measured 4.7x between low and high).
- `pipeline.eval_report` — the scorecard.
- `pipeline.label` / `pipeline.judge_gate` — human labels and the validation
  gate. See below.

Steps:

1. Run locally — measured 0.42s/puzzle engine time at depth 14 (the full
   1172-puzzle sample analyses in ~8 minutes), so the homelab is not needed.
   The wall-clock cost is LLM round-trips; raise `--concurrency` before
   reaching for another machine.
2. Delegate the run to the **eval-runner** agent so per-puzzle logs stay out
   of this conversation.
3. Report ONLY: the per-theme table, the plumbing rates (move-match,
   groundedness — flag anything below ~100%, those are trust-chain bugs, not
   quality signals), the free deterministic proxies, judge score distribution
   and failure categories, and the measured cost.
4. **Never present judge numbers as final unless the gate has passed.**
   `pipeline.judge_gate` must report PASS on the holdout split at >=80%
   exact agreement with hand labels, with a kappa that is not near zero. If
   it has not been run, say the numbers are provisional.
5. Append the scorecard to docs/private/eval-log.md with date + git SHA +
   prompt version + judge config, and diff against the previous entry.
