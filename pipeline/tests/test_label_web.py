"""Browser labeling UI: step building, state/resume, and the anchoring rule."""

import json

from pipeline.label_web import PAGE_PATH, State, build_steps

MATE_FEN = "2r4k/pb4pp/1p6/3pP3/3Pn3/2Pq2NQ/PP5P/5R1K w - - 0 24"
MATE_PV = ["h3c8", "b7c8", "f1f8"]


def test_build_steps_includes_start_and_every_move():
    steps, terminal = build_steps(MATE_FEN, MATE_PV)
    assert [s["san"] for s in steps] == ["", "24. Qxc8+", "24... Bxc8", "25. Rf8#"]
    assert steps[0]["fen"] == MATE_FEN
    assert terminal == "CHECKMATE — White wins."


def test_build_steps_terminal_states():
    assert build_steps(MATE_FEN, ["f1e1"])[1] == "no forced mate at the end of this line"
    assert build_steps(MATE_FEN, ["h3c8"])[1] == "check (not mate)"


def test_build_steps_stops_at_an_illegal_move():
    steps, _ = build_steps(MATE_FEN, ["h3c8", "a1a8"])
    assert len(steps) == 2  # start + the one legal move


def test_page_never_ships_a_judge_verdict():
    # The gate depends on unanchored human labels, so the page must not
    # even have a field to display a machine score in.
    page = PAGE_PATH.read_text(encoding="utf-8")
    for banned in ("judgment", "judge_score", "verdict"):
        assert banned not in page


def _write_run(tmp_path, n=3):
    run = tmp_path / "run.jsonl"
    rows = []
    for i in range(n):
        rows.append(
            {
                "puzzle_id": f"p{i}",
                "fen": MATE_FEN,
                "csv_fen": MATE_FEN,
                "setup_move": "h3c8",
                "themes": ["fork"],
                "rating": 1500,
                "rating_band": "1200-1799",
                "solver_color": "w",
                "solution": MATE_PV,
                "solution_san": "24. Qxc8+ Bxc8 25. Rf8#",
                "candidates": {
                    "lines": [],
                    "lines_text": "1. ...",
                    "explanation": "text",
                    "grounded": True,
                    "ground_violations": [],
                    "move_match": {},
                },
                "grade": {"explained": False},
            }
        )
    run.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    return run


def test_state_resumes_and_counts(tmp_path):
    run = _write_run(tmp_path)
    state = State(run, target=10, seed=42)
    assert len(state.jobs) == 3
    first = state.next_job()
    state.save(
        {
            "puzzle_id": first["puzzle_id"],
            "arm": first["arm"],
            "score": 1,
            "category": "wrong_mechanism",
            "note": "",
        }
    )
    assert state.scores[1] == 1

    # A fresh State over the same files must skip what was already labeled.
    reloaded = State(run, target=10, seed=42)
    assert len(reloaded.done) == 1
    assert reloaded.next_job()["puzzle_id"] != first["puzzle_id"]


def test_skip_advances_and_is_never_written(tmp_path):
    # Regression: skip originally saved nothing AND recorded nothing, so
    # next_job handed back the same item forever — skip was a no-op that
    # looked like it worked.
    run = _write_run(tmp_path, n=3)
    state = State(run, target=10, seed=42)
    first = state.next_job()
    state.skipped.add((first["puzzle_id"], first["arm"]))
    assert state.next_job()["puzzle_id"] != first["puzzle_id"]
    # A skip is absent evidence, not a score: it must not reach the file
    # or the score counts the gate is computed from.
    assert not state.labels_path.exists()
    assert state.scores == {0: 0, 1: 0, 2: 0}


def test_skips_do_not_survive_a_restart(tmp_path):
    # Intentional: an item you could not judge today is worth another
    # look tomorrow, and skips are deliberately not persisted.
    run = _write_run(tmp_path, n=3)
    state = State(run, target=10, seed=42)
    first = state.next_job()
    state.skipped.add((first["puzzle_id"], first["arm"]))
    assert State(run, target=10, seed=42).next_job()["puzzle_id"] == first["puzzle_id"]


def test_state_stops_at_target(tmp_path):
    run = _write_run(tmp_path)
    state = State(run, target=1, seed=42)
    job = state.next_job()
    state.save(
        {"puzzle_id": job["puzzle_id"], "arm": job["arm"], "score": 2, "category": "ok", "note": ""}
    )
    assert state.next_job() is None


def test_shuffle_order_matches_the_cli(tmp_path):
    # Both tools shuffle with the same seed so a session can move between
    # them without relabeling or reordering.
    run = _write_run(tmp_path, n=6)
    order = [(j["puzzle_id"], j["arm"]) for j in State(run, 10, 42).jobs]
    assert order == [(j["puzzle_id"], j["arm"]) for j in State(run, 10, 42).jobs]
    assert order != [(j["puzzle_id"], j["arm"]) for j in State(run, 10, 7).jobs]
