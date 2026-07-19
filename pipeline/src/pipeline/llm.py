"""Provider-agnostic LLM clients for the eval harness.

Mirrors web/worker/lib/providers.ts: same default model (Haiku 4.5, what
prod serves), same output cap, plus a deterministic fake so the whole
harness runs keyless in tests. The API key is read from the environment
only (ANTHROPIC_API_KEY) — never from a file in this repo.
"""

import hashlib
import os
from typing import Protocol

# Server-controlled output cap in the Worker (providers.ts MAX_OUTPUT_TOKENS).
MAX_OUTPUT_TOKENS = 512
DEFAULT_MODEL = "claude-haiku-4-5"


class LLM(Protocol):
    name: str

    def complete(self, system: str, user: str, *, max_tokens: int = MAX_OUTPUT_TOKENS) -> str: ...


class FakeLLM:
    """Deterministic mock (same spirit as the Worker's fakeProvider).

    Echoes the first engine-line row so groundedness checks have something
    real to verify, and stamps a content hash so identical prompts always
    produce identical output.
    """

    name = "fake"

    def __init__(self, canned: str | None = None):
        self._canned = canned

    def complete(self, system: str, user: str, *, max_tokens: int = MAX_OUTPUT_TOKENS) -> str:
        if self._canned is not None:
            return self._canned
        first_line = next(
            (
                stripped
                for line in user.split("\n")
                if (stripped := line.strip()) and stripped[0].isdigit() and ". " in stripped
            ),
            "the engine output",
        )
        digest = hashlib.sha256(user.encode("utf-8")).hexdigest()[:8]
        return (
            f"[fake explanation {digest}] Based on {first_line}, the engine's "
            "evaluation is the ground truth here."
        )


class AnthropicLLM:
    """Real client. Import of the sdk is deferred so keyless environments
    (CI, tests) never need the dependency exercised."""

    def __init__(self, model: str = DEFAULT_MODEL, api_key: str | None = None):
        import anthropic

        key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        self._client = anthropic.Anthropic(api_key=key)
        self.model = model
        self.name = f"anthropic:{model}"

    def complete(self, system: str, user: str, *, max_tokens: int = MAX_OUTPUT_TOKENS) -> str:
        response = self._client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(block.text for block in response.content if block.type == "text")


def make_llm(kind: str, model: str = DEFAULT_MODEL) -> LLM:
    """CLI factory: "fake" or "anthropic"."""
    if kind == "fake":
        return FakeLLM()
    if kind == "anthropic":
        return AnthropicLLM(model=model)
    raise ValueError(f"unknown llm kind: {kind}")
