import { describe, expect, it } from "vitest";
import { boardToFen, parseScanRequest } from "./scan";

const PNG_URL = `data:image/png;base64,${btoa("fake-image-bytes")}`;

describe("parseScanRequest", () => {
  it("accepts a png data URL", () => {
    const r = parseScanRequest({ image: PNG_URL });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.mediaType).toBe("image/png");
  });

  it("accepts jpeg and webp", () => {
    for (const t of ["jpeg", "webp"]) {
      const r = parseScanRequest({ image: `data:image/${t};base64,AAAA` });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects non-image and malformed data URLs", () => {
    for (const bad of [
      { image: "data:text/html;base64,AAAA" },
      { image: "data:image/png;base64," }, // empty payload
      { image: "data:image/png,notbase64" },
      { image: "https://example.com/x.png" },
      { image: 42 },
      {},
      null,
      "just a string",
    ]) {
      expect(parseScanRequest(bad).ok).toBe(false);
    }
  });

  it("rejects base64 with invalid characters (no injection into the API call)", () => {
    const r = parseScanRequest({ image: 'data:image/png;base64,AAA"><script>' });
    expect(r.ok).toBe(false);
  });
});

describe("boardToFen", () => {
  it("accepts the starting position board", () => {
    const r = boardToFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fen).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1");
  });

  it("tolerates surrounding whitespace from the model", () => {
    expect(boardToFen("  8/8/8/4k3/8/8/8/4K3 \n").ok).toBe(true);
  });

  it("rejects NOT_A_BOARD with a distinct message", () => {
    const r = boardToFen("NOT_A_BOARD");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no chessboard/);
  });

  it("rejects wrong rank counts and junk", () => {
    for (const bad of [
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP", // 7 ranks
      "hello world",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR extra",
      "", // empty
    ]) {
      expect(boardToFen(bad).ok).toBe(false);
    }
  });

  it("rejects boards chess.js won't load (no kings)", () => {
    expect(boardToFen("8/8/8/8/8/8/8/8").ok).toBe(false);
  });
});
