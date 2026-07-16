"""End-to-end test of the sampling CLI against the committed fixture."""

import json
from pathlib import Path

from pipeline.sample_puzzles import main

FIXTURE = Path(__file__).parent / "fixtures" / "puzzles_sample.csv"


def test_cli_writes_validated_jsonl(tmp_path: Path, capsys):
    out = tmp_path / "sample.jsonl"
    rc = main(
        [
            "--input",
            str(FIXTURE),
            "--out",
            str(out),
            "--per-cell",
            "2",
            # Filters sized for the small fixture.
            "--min-popularity",
            "0",
            "--min-nb-plays",
            "0",
        ]
    )
    assert rc == 0

    records = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert records, "expected at least one sampled puzzle"
    by_id = {r["puzzle_id"]: r for r in records}

    # fen is the position AFTER the setup move; csv_fen is the raw one.
    scholars = by_id["fx001"]
    assert scholars["fen"] != scholars["csv_fen"]
    assert scholars["setup_move"] == "g8f6"
    assert scholars["solution"] == ["h5f7"]
    assert scholars["solver_color"] == "w"
    assert scholars["rating_band"] == "0-1199"

    # Coverage report mentions empty cells rather than hiding them.
    assert "EMPTY cells" in capsys.readouterr().out


def test_cli_missing_input_gives_download_hint(tmp_path: Path, capsys):
    rc = main(["--input", str(tmp_path / "nope.csv.zst"), "--out", str(tmp_path / "o.jsonl")])
    assert rc == 1
    assert "database.lichess.org" in capsys.readouterr().err
