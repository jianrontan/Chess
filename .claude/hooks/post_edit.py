"""PostToolUse hook: auto-format + lint the file Claude just edited.

Fast per-edit feedback. Exit code 2 feeds remaining errors back to Claude
so it fixes them immediately; exit 0 is silence.
"""

import json
import os
import subprocess
import sys


def run(cmd: str, cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, shell=True)


def main() -> int:
    data = json.load(sys.stdin)
    path = (data.get("tool_input") or {}).get("file_path") or ""
    root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    if not path:
        return 0
    rel = os.path.relpath(path, root).replace("\\", "/")

    if rel.startswith("pipeline/") and rel.endswith(".py"):
        run(f'uv run --project pipeline ruff format "{path}"', root)
        run(f'uv run --project pipeline ruff check --fix "{path}"', root)
        r = run(f'uv run --project pipeline ruff check "{path}"', root)
        if r.returncode != 0:
            print((r.stdout + r.stderr)[-3000:], file=sys.stderr)
            return 2  # blocking: Claude sees the remaining lint errors
    elif rel.startswith("web/src/") and rel.rsplit(".", 1)[-1] in ("ts", "tsx", "js", "jsx"):
        r = run(f'pnpm --filter web exec eslint --fix --no-warn-ignored "{path}"', root)
        if r.returncode != 0:
            print((r.stdout + r.stderr)[-3000:], file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
