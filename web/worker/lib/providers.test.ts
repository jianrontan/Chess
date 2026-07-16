import { describe, expect, it } from "vitest";
import type { BuiltPrompt } from "./prompt";
import { fakeProvider, providerFromEnv } from "./providers";

const prompt: BuiltPrompt = {
  system: "system",
  user: "Engine analysis, top candidate moves (searched to depth 20):\n1. e4 — roughly equal",
  promptVersion: "explain-v1",
};

describe("fakeProvider", () => {
  it("streams multiple chunks that assemble into a mock explanation", async () => {
    const chunks: string[] = [];
    for await (const c of fakeProvider().explain(prompt)) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(5);
    const text = chunks.join("");
    expect(text).toContain("[mock explanation");
    expect(text).toContain("explain-v1");
  });
});

describe("providerFromEnv", () => {
  it("falls back to the fake provider without a key", () => {
    expect(providerFromEnv({}).name).toBe("fake");
  });

  it("uses Anthropic when a key is present", () => {
    expect(providerFromEnv({ ANTHROPIC_API_KEY: "k" }).name).toBe(
      "anthropic:claude-haiku-4-5",
    );
  });

  it("EXPLAIN_PROVIDER=fake forces the mock even with a key", () => {
    expect(
      providerFromEnv({ ANTHROPIC_API_KEY: "k", EXPLAIN_PROVIDER: "fake" }).name,
    ).toBe("fake");
  });

  it("EXPLAIN_MODEL overrides the model", () => {
    expect(
      providerFromEnv({ ANTHROPIC_API_KEY: "k", EXPLAIN_MODEL: "claude-sonnet-5" }).name,
    ).toBe("anthropic:claude-sonnet-5");
  });
});
