import { describe, expect, it } from "vitest";
import { parseInfoLine } from "./client";

describe("parseInfoLine", () => {
  it("parses a full multipv cp info line", () => {
    const parsed = parseInfoLine(
      "info depth 20 seldepth 25 multipv 2 score cp 34 nodes 12345 nps 6172 time 2 pv e2e4 e7e5 g1f3",
    );
    expect(parsed).toEqual({
      multipv: 2,
      depth: 20,
      cp: 34,
      mate: undefined,
      pv: ["e2e4", "e7e5", "g1f3"],
    });
  });

  it("parses a mate score", () => {
    const parsed = parseInfoLine("info depth 18 multipv 1 score mate 3 pv d1h5 e8e7 h5e5");
    expect(parsed?.mate).toBe(3);
    expect(parsed?.cp).toBeUndefined();
  });

  it("parses a negative (getting-mated) mate score", () => {
    const parsed = parseInfoLine("info depth 12 score mate -2 pv f2f3 d8h4");
    expect(parsed?.mate).toBe(-2);
    expect(parsed?.cp).toBeUndefined();
  });

  it("defaults multipv to 1 when absent", () => {
    const parsed = parseInfoLine("info depth 20 score cp 34 pv e2e4");
    expect(parsed?.multipv).toBe(1);
  });

  it("skips lowerbound lines (provisional aspiration-window score)", () => {
    expect(
      parseInfoLine("info depth 20 multipv 1 score cp 34 lowerbound pv e2e4"),
    ).toBeUndefined();
  });

  it("skips upperbound lines", () => {
    expect(
      parseInfoLine("info depth 20 multipv 1 score cp 34 upperbound pv e2e4"),
    ).toBeUndefined();
  });

  it("skips info lines with no pv", () => {
    expect(parseInfoLine("info depth 20 multipv 1 score cp 34 nodes 999")).toBeUndefined();
  });

  it("does not mistake seldepth for depth (token-collision safety)", () => {
    // Only 'seldepth' is present, no bare 'depth' token -> depth is unknown,
    // so the line must be skipped rather than reading seldepth's value.
    expect(parseInfoLine("info seldepth 30 multipv 1 score cp 5 pv e2e4")).toBeUndefined();
  });

  it("reads the real depth even when seldepth appears first", () => {
    const parsed = parseInfoLine("info seldepth 30 depth 22 multipv 1 score cp 5 pv e2e4");
    expect(parsed?.depth).toBe(22);
  });

  it("returns undefined for a bestmove line", () => {
    expect(parseInfoLine("bestmove e2e4 ponder e7e5")).toBeUndefined();
  });

  it("returns undefined for an info string line", () => {
    expect(parseInfoLine("info string NNUE evaluation using nn-xxxx.nnue")).toBeUndefined();
  });

  it("returns undefined for an empty line", () => {
    expect(parseInfoLine("")).toBeUndefined();
  });
});
