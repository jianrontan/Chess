---
description: Run an eval sweep and report the per-theme scorecard
argument-hint: [--rag on|off] [--sample N] [--themes t1,t2]
---
Run an eval-harness sweep with args: $ARGUMENTS

1. If sample > 200 puzzles, run on the homelab over Tailscale:
   `ssh homelab "cd ~/Chess && uv run --project pipeline python -m pipeline.eval $ARGUMENTS"`.
   Otherwise run locally with the same module invocation.
2. Delegate the actual run to the **eval-runner** agent so raw per-puzzle logs
   stay out of this conversation.
3. Report ONLY: the per-theme accuracy table (all arms if multiple requested),
   overall legality % and move-match % (flag if below ~100% — those are plumbing
   bugs), judge failure categories (wrong theme / right theme wrong reasoning /
   hallucinated line) with counts, and the approximate LLM cost of the sweep.
4. Append the scorecard to docs/private/eval-log.md with date + git SHA + prompt
   version, and diff against the previous entry if one exists.
