/**
 * Provider-agnostic LLM streaming client.
 *
 * The Worker only ever talks to an ExplainProvider — an async iterable of
 * plain-text chunks. Swapping models/vendors (or running the eval harness
 * against a fake) means swapping this object, nothing else. The API key
 * exists ONLY here, read from Worker env (.dev.vars locally / secrets in
 * prod) — never in browser code.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { BuiltPrompt } from "./prompt";

/** Server-controlled output cap — the client cannot raise it. */
export const MAX_OUTPUT_TOKENS = 512;

/** Project default (see CLAUDE.md): Haiku 4.5 for explanations. */
export const DEFAULT_MODEL = "claude-haiku-4-5";

export interface ExplainProvider {
  /** e.g. "anthropic:claude-haiku-4-5" or "fake" — logged, never secret. */
  name: string;
  explain(prompt: BuiltPrompt): AsyncIterable<string>;
}

export function anthropicProvider(
  apiKey: string,
  model: string = DEFAULT_MODEL,
): ExplainProvider {
  return {
    name: `anthropic:${model}`,
    async *explain(prompt: BuiltPrompt): AsyncIterable<string> {
      const client = new Anthropic({ apiKey });
      const stream = client.messages.stream({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    },
  };
}

/**
 * Deterministic mock used until an API key is configured (and by tests).
 * Streams word-by-word so the UI streaming path is exercised for real.
 */
export function fakeProvider(): ExplainProvider {
  return {
    name: "fake",
    async *explain(prompt: BuiltPrompt): AsyncIterable<string> {
      const firstLine =
        prompt.user
          .split("\n")
          .find((l) => /^\d+\. /.test(l) || l.startsWith("Engine line")) ??
        "the engine output";
      const text =
        `[mock explanation — no LLM key configured] ` +
        `Based on ${firstLine.trim()}, the engine's evaluation is the ` +
        `ground truth here. This placeholder proves the request was ` +
        `validated, the ${prompt.promptVersion} prompt was built, and the ` +
        `response streams end to end.`;
      for (const word of text.split(" ")) {
        yield word + " ";
      }
    },
  };
}

export interface ProviderEnv {
  ANTHROPIC_API_KEY?: string;
  EXPLAIN_PROVIDER?: string; // "fake" forces the mock even with a key
  EXPLAIN_MODEL?: string; // optional model override
}

export function providerFromEnv(env: ProviderEnv): ExplainProvider {
  if (env.EXPLAIN_PROVIDER === "fake" || !env.ANTHROPIC_API_KEY) {
    return fakeProvider();
  }
  return anthropicProvider(env.ANTHROPIC_API_KEY, env.EXPLAIN_MODEL);
}
