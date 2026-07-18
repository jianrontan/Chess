"""Piece-set import: copy usable Lichess piece sets + record their licenses.

Sets come from a sparse checkout of lichess-org/lila (public/piece). The
SVGs are TRAINING INPUTS only — they are git-ignored here and never shipped;
what ships is a CNN that looked at renders of them. We still only use sets
with a recognized open license, and we record author/license per set
(source: lila COPYING.md).

Excluded sets and why:
- alpha, chess7, companion, leipzig: "freeware"/personal-use terms, no open
  license — same clean-licensing bar as the RAG corpus.
- reillycraig, riohacha: no license stated at all.
- shahi-ivory-brown: non-derivative license; rasterizing is a derivative.
- disguised: openly licensed but every piece of a color is the SAME glyph
  (handicap set) — type labels would be wrong by construction.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

PIECE_CODES = [c + t for c in "wb" for t in "KQRBNP"]

# set name -> (author, license) — from lila COPYING.md.
LICENSED_SETS: dict[str, tuple[str, str]] = {
    "anarcandy": ("caderek", "CC BY-NC-SA 4.0"),
    "caliente": ("avi", "CC BY-NC-SA 4.0"),
    "california": ("Jerry S.", "CC BY-NC-SA 4.0"),
    "cardinal": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "cburnett": ("Colin M.L. Burnett", "GPLv2+"),
    "celtic": ("Maurizio Monge", "MIT"),
    "chessnut": ("Alexis Luengas", "Apache 2.0"),
    "cooke": ("fejfar", "CC BY-NC-SA 4.0"),
    "dubrovny": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "fantasy": ("Maurizio Monge", "MIT"),
    "firi": ("James Faure", "CC BY 4.0"),
    "fresca": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "gioco": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "governor": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "horsey": ("cham, michael1241", "CC BY-NC-SA 4.0"),
    "icpieces": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "kiwen-suwi": ("neverRare", "CC BY 4.0"),
    "kosal": ("Kosal Sen", "CC BY 4.0"),
    "letter": ("usolando", "AGPLv3+"),
    "maestro": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "merida": ("Armando Hernandez Marroquin", "GPLv2+"),
    "monarchy": ("slither77", "CC BY-NC-SA 4.0"),
    "mono": ("Thibault Duplessis, Colin M.L. Burnett", "GPLv2+"),
    "mpchess": ("Maxime Chupin", "GPLv3+"),
    "papercut": ("Nikolay Anzarov", "CC BY 4.0"),
    "pirouetti": ("pirouetti", "AGPLv3+"),
    "pixel": ("therealqtpi", "AGPLv3+"),
    "rhosgfx": ("RhosGFX", "CC0 1.0"),
    "shapes": ("flugsio", "CC BY-SA 4.0"),
    "spatial": ("Maurizio Monge", "MIT"),
    "staunty": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "tatiana": ("sadsnake1", "CC BY-NC-SA 4.0"),
    "totoy": ("Kosal Sen", "CC BY 4.0"),
    "xkcd": ("Randall Munroe", "CC BY-NC 2.5"),
}


# Additional sets from Maurizio Monge's chess-art repo (all MIT) — the
# "fancy" quirky styles that never shipped to lila. Deliberately-weird
# glyphs: exactly the style-space coverage the holdout exam showed missing.
CHESS_ART_SETS = ["eyes", "freak", "prmi", "skulls"]

# monarchy ships webp instead of svg; imported as-is, rasterizer branches.
WEBP_SETS: dict[str, tuple[str, str]] = {
    "monarchy": ("slither77", "CC BY-NC-SA 4.0"),
}


def import_sets(
    lila_piece_dir: Path,
    dest: Path,
    chess_art_dir: Path | None = None,
) -> dict[str, dict[str, str]]:
    """Copy every licensed, complete set into dest/<set>/. Returns the manifest."""
    manifest: dict[str, dict[str, str]] = {}
    for name, (author, license_) in sorted(LICENSED_SETS.items()):
        src = lila_piece_dir / name
        if not src.is_dir():
            print(f"SKIP {name}: not present in checkout")
            continue
        missing = [c for c in PIECE_CODES if not (src / f"{c}.svg").is_file()]
        if missing:
            print(f"SKIP {name}: missing {missing}")
            continue
        out = dest / name
        out.mkdir(parents=True, exist_ok=True)
        for code in PIECE_CODES:
            shutil.copyfile(src / f"{code}.svg", out / f"{code}.svg")
        manifest[name] = {"author": author, "license": license_}

    for name, (author, license_) in WEBP_SETS.items():
        src = lila_piece_dir / name
        if not src.is_dir():
            continue
        missing = [c for c in PIECE_CODES if not (src / f"{c}.webp").is_file()]
        if missing:
            print(f"SKIP {name}: missing {missing}")
            continue
        out = dest / name
        out.mkdir(parents=True, exist_ok=True)
        for code in PIECE_CODES:
            shutil.copyfile(src / f"{code}.webp", out / f"{code}.webp")
        manifest[name] = {"author": author, "license": license_}

    if chess_art_dir is not None:
        for name in CHESS_ART_SETS:
            src = chess_art_dir / "fancy" / name
            # chess-art uses lowercase names: bb.svg -> our bB.svg.
            missing = [c for c in PIECE_CODES if not (src / f"{c.lower()}.svg").is_file()]
            if not src.is_dir() or missing:
                print(f"SKIP chess-art {name}: {'not present' if not src.is_dir() else missing}")
                continue
            out = dest / name
            out.mkdir(parents=True, exist_ok=True)
            for code in PIECE_CODES:
                shutil.copyfile(src / f"{code.lower()}.svg", out / f"{code}.svg")
            manifest[name] = {"author": "Maurizio Monge", "license": "MIT"}

    (dest / "MANIFEST.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Import piece sets (lila + chess-art)")
    parser.add_argument("lila_piece_dir", type=Path, help="path to lila/public/piece")
    parser.add_argument("--chess-art", type=Path, default=None, help="path to a chess-art checkout")
    parser.add_argument(
        "--dest",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "assets" / "pieces",
    )
    args = parser.parse_args()
    manifest = import_sets(args.lila_piece_dir, args.dest, args.chess_art)
    print(f"imported {len(manifest)} sets -> {args.dest}")


if __name__ == "__main__":
    main()
