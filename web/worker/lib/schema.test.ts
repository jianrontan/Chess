import { describe, expect, it } from "vitest";
import { CAPS, parseExplainRequest } from "./schema";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const line = (over: Record<string, unknown> = {}) => ({
  multipv: 1,
  depth: 20,
  cp: 30,
  pv: ["e2e4", "e7e5"],
  ...over,
});

describe("parseExplainRequest — candidates", () => {
  it("accepts a well-formed request", () => {
    const r = parseExplainRequest({ mode: "candidates", fen: START, lines: [line()] });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown mode, missing fen, empty lines", () => {
    expect(parseExplainRequest({ mode: "nope", fen: START, lines: [line()] }).ok).toBe(false);
    expect(parseExplainRequest({ mode: "candidates", lines: [line()] }).ok).toBe(false);
    expect(parseExplainRequest({ mode: "candidates", fen: START, lines: [] }).ok).toBe(false);
  });

  it("rejects more than the k cap", () => {
    const lines = Array.from({ length: CAPS.lines + 1 }, (_, i) => line({ multipv: i + 1 }));
    expect(parseExplainRequest({ mode: "candidates", fen: START, lines }).ok).toBe(false);
  });

  it("rejects a line with neither cp nor mate, or malformed UCI", () => {
    expect(
      parseExplainRequest({ mode: "candidates", fen: START, lines: [line({ cp: undefined })] }).ok,
    ).toBe(false);
    expect(
      parseExplainRequest({ mode: "candidates", fen: START, lines: [line({ pv: ["e2e9"] })] }).ok,
    ).toBe(false);
    expect(
      parseExplainRequest({
        mode: "candidates",
        fen: START,
        lines: [line({ pv: ["e2e4; DROP TABLE"] })],
      }).ok,
    ).toBe(false);
  });

  it("clamps evals and truncates long PVs (client values are untrusted)", () => {
    const longPv = Array.from({ length: 40 }, () => "e2e4");
    const r = parseExplainRequest({
      mode: "candidates",
      fen: START,
      lines: [line({ cp: 123456, pv: longPv })],
    });
    if (!r.ok) throw new Error(r.error);
    if (r.request.mode !== "candidates") throw new Error("wrong mode");
    expect(r.request.lines[0].cp).toBe(9999);
    expect(r.request.lines[0].pv.length).toBe(CAPS.pvMoves);
  });
});

describe("parseExplainRequest — grade", () => {
  const grade = {
    mode: "grade",
    fen: START,
    verdict: { moveUci: "e2e4", moveClass: "good", winPctBefore: 53, winPctAfter: 52 },
    playedLine: line({ pv: ["e2e4", "e7e5"] }),
    bestLine: line({ pv: ["d2d4", "d7d5"] }),
  };

  it("accepts a well-formed request and clamps win percentages", () => {
    const r = parseExplainRequest({
      ...grade,
      verdict: { ...grade.verdict, winPctBefore: 250, winPctAfter: -4 },
    });
    if (!r.ok) throw new Error(r.error);
    if (r.request.mode !== "grade") throw new Error("wrong mode");
    expect(r.request.verdict.winPctBefore).toBe(100);
    expect(r.request.verdict.winPctAfter).toBe(0);
  });

  it("rejects when playedLine does not start with the played move", () => {
    const r = parseExplainRequest({ ...grade, playedLine: line({ pv: ["g1f3"] }) });
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid move class", () => {
    const r = parseExplainRequest({
      ...grade,
      verdict: { ...grade.verdict, moveClass: "brilliant" },
    });
    expect(r.ok).toBe(false);
  });
});
