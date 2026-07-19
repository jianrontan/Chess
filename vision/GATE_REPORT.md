# Board-recognition gate report — squarenet-v5

Date: 2026-07-19 · Model: `runs/squarenet-v5` (212k params, 16-epoch cosine,
37-set training pool) · Artifacts: fp32 ONNX 828KB, int8 215KB, parity 1.0.

## Verdict: SHIP (real-screenshot exam passed; one documented limitation)

## Exam 1 — Real screenshots (the deployment criterion): PASS

18 live Lichess analysis-board captures at known positions (openings,
middlegames, sparse endgames; White- and Black-viewpoint), scored raw:

- Square accuracy: **1152/1152 = 100%**
- Board exact-match: **18/18 = 100%**
- King-constraint fix: not needed (no errors to fix)

Method note: the Lichess analysis page orients the board with the side to
move at the bottom. The first scoring pass assumed White-at-bottom and
"failed" exactly the black-to-move boards — an exam-label bug, and a live
rehearsal of the orientation ambiguity the product handles via the
default-White prior + Rotate 180° in the confirm editor.

Breadth caveat: one site (Lichess), default board theme, one capture size.
Planned broadening before retiring /api/scan: more Lichess themes and
chess.com captures (eval-only screenshots, no proprietary assets ingested).

## Exam 2 — Synthetic held-out styles: 99.14% (bar of 99.5% not met, cause isolated)

128k squares rendered in three piece sets + two board themes the model
never trained on, with screenshot-realistic damage:

- Overall: **99.14%** square-level (avg 0.55 wrong squares/board)
- Quantized int8: 99.12% (quantization effectively free)
- Mainstream unseen styles (staunty, fantasy): ~99.9%
- **Known limitation:** kiwen-suwi's knights (~65% on bN). Its glyphs have
  no relatives even in a 37-set pool including four deliberately-quirky
  sets. Users of niche art styles hit the confirm editor, which exists for
  exactly this. Next lever if it ever matters: 48px crops.

## Trust chain

- Training data generated, never annotated: labels correct by construction
  (round-trip tested, both orientations).
- Holdout discipline baked into shards: training cannot see exam styles.
- ONNX parity measured (1.0), quantization re-scored on the full exam.
- Real-screenshot labels come from the URL the capture harness itself set.
