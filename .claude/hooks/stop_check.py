"""Stop hook: run the cheap deterministic checks for whatever changed this turn.

pytest for pipeline/ changes, tsc for web/ changes. Exit 2 makes Claude fix
failures before actually stopping. When the test suite grows past smoke tests,
switch the pytest invocation to -m "not slow".
"""

import json
import os
import subprocess
import sys


def run(cmd: str, cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, shell=True)


def main() -> int:
    data = json.load(sys.stdin)
    if data.get("stop_hook_active"):  # loop guard: don't re-block a continuation
        return 0
    root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())

    status = run("git status --porcelain", root).stdout
    changed = [line[3:].strip('"') for line in status.splitlines() if line.strip()]
    py = any(f.startswith("pipeline/") and f.endswith(".py") for f in changed)
    ts = any(f.startswith("web/") and f.rsplit(".", 1)[-1] in ("ts", "tsx") for f in changed)

    failures = []
    if py:
        r = run("uv run --project pipeline pytest -q -x", root)
        if r.returncode != 0:
            failures.append("pytest failed:\n" + (r.stdout + r.stderr)[-3000:])
    if ts:
        r = run("pnpm --filter web exec tsc --noEmit", root)
        if r.returncode != 0:
            failures.append("tsc failed:\n" + (r.stdout + r.stderr)[-3000:])

    if failures:
        print("\n\n".join(failures), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
