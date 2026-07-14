---
description: Add a Lichess puzzle as a legality-validated test fixture
argument-hint: <lichess-puzzle-id>
---
Add puzzle $ARGUMENTS as a fixture:

1. Fetch https://lichess.org/api/puzzle/$ARGUMENTS (JSON: game.pgn,
   puzzle.solution as UCI, puzzle.themes, puzzle.rating, puzzle.initialPly).
2. Replay game.pgn to initialPly with python-chess to derive the puzzle FEN.
   Use the helpers in pipeline/src/pipeline/board.py — do not hand-roll FEN logic.
3. Validate: from that FEN, every solution move must be legal
   (apply_moves raises on illegal). If anything fails, STOP and report —
   never write an unvalidated fixture.
4. Write pipeline/tests/fixtures/puzzles/$ARGUMENTS.json with
   {id, fen, solution, themes, rating}, then `git add -f` it (the fixtures dir
   sits inside git-ignored data territory).
5. Run `uv run --project pipeline pytest -q` and confirm green.
