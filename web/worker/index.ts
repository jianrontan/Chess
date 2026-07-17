/**
 * API Worker. Same-origin under the app's domain (COEP: require-corp on the
 * document means cross-origin fetches would need CORS/CORP; same-origin needs
 * nothing). Static assets are served directly by the platform; only /api/*
 * reaches this code (see run_worker_first in wrangler.jsonc).
 *
 * NOTE: _headers does NOT apply to Worker-generated responses — if a response
 * from this Worker ever needs COOP/COEP (it shouldn't; the document is a
 * static asset), set the headers here explicitly.
 */

import { BudgetCounter } from "./budget";
import { buildPrompt, PROMPT_VERSION } from "./lib/prompt";
import { DEFAULT_MODEL, providerFromEnv, type ProviderEnv } from "./lib/providers";
import { boardToFen, parseScanRequest, SCAN_CAPS, scanWithAnthropic } from "./lib/scan";
import { CAPS, parseExplainRequest } from "./lib/schema";
import { turnstileOk } from "./lib/turnstile";

export { BudgetCounter };

/** Default worker-wide explanations/day when DAILY_BUDGET isn't set. */
const DEFAULT_DAILY_BUDGET = 300;

interface Env extends ProviderEnv {
  ASSETS: Fetcher;
  EXPLAIN_RATELIMIT?: RateLimit;
  BUDGET?: DurableObjectNamespace<BudgetCounter>;
  DAILY_BUDGET?: string;
  /** When set, LLM-spending endpoints require a valid Turnstile token. */
  TURNSTILE_SECRET_KEY?: string;
}

/**
 * Shared gate for every endpoint that can spend LLM tokens: per-IP rate
 * limit first (cheapest), then Turnstile (before the body is even read).
 * Returns an error Response to send, or null to proceed.
 */
async function spendGate(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip");
  if (env.EXPLAIN_RATELIMIT) {
    const { success } = await env.EXPLAIN_RATELIMIT.limit({ key: ip ?? "unknown" });
    if (!success) return jsonError("too many requests — try again in a minute", 429);
  }
  if (env.TURNSTILE_SECRET_KEY) {
    const token = request.headers.get("x-turnstile-token");
    if (!(await turnstileOk(env.TURNSTILE_SECRET_KEY, token, ip))) {
      return jsonError("verification failed — refresh the page and try again", 403);
    }
  }
  return null;
}

/**
 * Global daily cap across ALL clients (see budget.ts). Counted after
 * validation so malformed floods can't drain the budget for real users.
 * Fail-open: a budget-infra error must not take the endpoint down — the
 * per-IP limit and the provider spend limit still stand behind it.
 */
async function budgetExhausted(env: Env): Promise<boolean> {
  if (!env.BUDGET) return false;
  const limit = Number(env.DAILY_BUDGET ?? DEFAULT_DAILY_BUDGET);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const stub = env.BUDGET.get(env.BUDGET.idFromName("global"));
    return (await stub.consume(day)) > limit;
  } catch {
    return false;
  }
}

function jsonError(message: string, status: number): Response {
  return Response.json(
    { error: message },
    { status, headers: { "x-content-type-options": "nosniff" } },
  );
}

/** Stream provider text chunks as a plain chunked-text response. */
function streamText(chunks: AsyncIterable<string>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch {
        // Mid-stream provider failure: headers are already sent, so append a
        // visible marker instead of a status code the client can't see.
        controller.enqueue(
          encoder.encode("\n\n[The explanation was cut off by an upstream error.]"),
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleExplain(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  const gated = await spendGate(request, env);
  if (gated) return gated;

  // Reject oversized payloads before buffering them.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > CAPS.bodyBytes) {
    return jsonError("request body too large", 413);
  }
  const raw = await request.text();
  if (raw.length > CAPS.bodyBytes) {
    return jsonError("request body too large", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const parsed = parseExplainRequest(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const built = buildPrompt(parsed.request);
  if (!built.ok) return jsonError(built.error, 400);

  if (await budgetExhausted(env)) {
    return jsonError(
      "the site's daily explanation budget is used up — try again tomorrow",
      429,
    );
  }

  const provider = providerFromEnv(env);
  return streamText(provider.explain(built.prompt));
}

/** Image-to-FEN: vision LLM behind the same gates as /api/explain. */
async function handleScan(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  const gated = await spendGate(request, env);
  if (gated) return gated;

  if (!env.ANTHROPIC_API_KEY) {
    return jsonError("image scanning is not configured on this deployment", 501);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > SCAN_CAPS.bodyBytes) {
    return jsonError("image too large — resize to under ~1MB", 413);
  }
  const raw = await request.text();
  if (raw.length > SCAN_CAPS.bodyBytes) {
    return jsonError("image too large — resize to under ~1MB", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const parsed = parseScanRequest(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  if (await budgetExhausted(env)) {
    return jsonError(
      "the site's daily explanation budget is used up — try again tomorrow",
      429,
    );
  }

  let rawBoard: string;
  try {
    rawBoard = await scanWithAnthropic(
      env.ANTHROPIC_API_KEY,
      env.EXPLAIN_MODEL ?? DEFAULT_MODEL,
      parsed.image,
    );
  } catch {
    return jsonError("the vision model is unavailable — try again shortly", 502);
  }

  const result = boardToFen(rawBoard);
  if (!result.ok) return jsonError(result.error, 422);
  return Response.json(
    { board: result.board, fen: result.fen },
    { headers: { "x-content-type-options": "nosniff" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "chess-web",
        prompt: PROMPT_VERSION,
        provider: providerFromEnv(env).name,
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/explain") {
      return handleExplain(request, env);
    }

    if (url.pathname === "/api/scan") {
      return handleScan(request, env);
    }

    return jsonError("not found", 404);
  },
} satisfies ExportedHandler<Env>;
