import { describe, expect, it } from "vitest";
import { CLEARANCE_COOKIE, clearanceSetCookie, clearanceValid } from "./clearance";

const SECRET = "test-secret-key";

function cookiePair(setCookie: string): string {
  // "clearance=exp.sig; Max-Age=..." -> "clearance=exp.sig"
  return setCookie.split(";")[0];
}

describe("clearance cookie", () => {
  it("round-trips: issued cookie validates", async () => {
    const set = await clearanceSetCookie(SECRET);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(await clearanceValid(SECRET, cookiePair(set))).toBe(true);
  });

  it("validates among other cookies", async () => {
    const set = await clearanceSetCookie(SECRET);
    const header = `theme=dark; ${cookiePair(set)}; other=1`;
    expect(await clearanceValid(SECRET, header)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const set = await clearanceSetCookie(SECRET);
    const pair = cookiePair(set);
    const tampered = pair.slice(0, -2) + (pair.endsWith("00") ? "11" : "00");
    expect(await clearanceValid(SECRET, tampered)).toBe(false);
  });

  it("rejects a forged expiry (signature is over the expiry)", async () => {
    const set = await clearanceSetCookie(SECRET);
    const [, value] = cookiePair(set).split("=");
    const [, sig] = value.split(".");
    const forged = `${CLEARANCE_COOKIE}=${Math.floor(Date.now() / 1000) + 999999}.${sig}`;
    expect(await clearanceValid(SECRET, forged)).toBe(false);
  });

  it("rejects an expired cookie even with a valid-shape signature", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(await clearanceValid(SECRET, `${CLEARANCE_COOKIE}=${past}.deadbeef`)).toBe(false);
  });

  it("rejects the wrong secret, garbage, and absence", async () => {
    const set = await clearanceSetCookie(SECRET);
    expect(await clearanceValid("other-secret", cookiePair(set))).toBe(false);
    expect(await clearanceValid(SECRET, `${CLEARANCE_COOKIE}=garbage`)).toBe(false);
    expect(await clearanceValid(SECRET, `${CLEARANCE_COOKIE}=1.2.3`)).toBe(false);
    expect(await clearanceValid(SECRET, null)).toBe(false);
    expect(await clearanceValid(SECRET, "theme=dark")).toBe(false);
  });
});
