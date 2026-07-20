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
import { clearanceSetCookie, clearanceValid } from "./lib/clearance";
import { buildPrompt, PROMPT_VERSION } from "./lib/prompt";
import { DEFAULT_MODEL, providerFromEnv, type ProviderEnv } from "./lib/providers";
import { boardToFen, parseScanRequest, SCAN_CAPS, scanWithAnthropic } from "./lib/scan";
import { CAPS, parseExplainRequest } from "./lib/schema";
import { turnstileOk } from "./lib/turnstile";

export { BudgetCounter };

/**
 * Fallback worker-wide explanations/day when the DAILY_BUDGET var is unset.
 * The deployed value lives in wrangler.jsonc `vars.DAILY_BUDGET` (with the
 * cost rationale) — keep the two in sync.
 */
const DEFAULT_DAILY_BUDGET = 300;

const BUDGET_EXHAUSTED_MESSAGE =
  "the site's daily explanation budget is used up — try again tomorrow";

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
  if (!env.TURNSTILE_SECRET_KEY) {
    // A missing Turnstile secret must FAIL CLOSED whenever real LLM spend is
    // possible — otherwise a deploy that forgets the secret silently drops
    // the bot gate. With the fake provider (no API key or EXPLAIN_PROVIDER=
    // fake) there is nothing to spend, so local dev stays frictionless.
    const spendPossible =
      env.EXPLAIN_PROVIDER !== "fake" && Boolean(env.ANTHROPIC_API_KEY);
    return spendPossible
      ? jsonError("verification is not configured on this deployment", 503)
      : null;
  }
  // Per-request token (Chromium invisible path) OR a pre-clearance cookie
  // issued by /api/verify (the one-time detour for other browsers).
  const token = request.headers.get("x-turnstile-token");
  const ok = token
    ? await turnstileOk(
        env.TURNSTILE_SECRET_KEY,
        token,
        ip,
        new URL(request.url).hostname,
      )
    : await clearanceValid(env.TURNSTILE_SECRET_KEY, request.headers.get("cookie"));
  if (!ok) {
    return jsonError("verification failed — refresh the page and try again", 403);
  }
  return null;
}

/**
 * Pre-clearance endpoint. GET reports whether the caller already holds a
 * valid clearance cookie; POST {token} verifies a Turnstile token minted on
 * the top-level /turnstile page and answers with a Set-Cookie clearance.
 */
async function handleVerify(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY) {
    // No enforcement configured — everything is implicitly cleared. (When a
    // real provider key exists, spendGate still fails closed regardless.)
    return Response.json(
      { cleared: true },
      { headers: { "x-content-type-options": "nosniff" } },
    );
  }
  if (request.method === "GET") {
    const cleared = await clearanceValid(
      env.TURNSTILE_SECRET_KEY,
      request.headers.get("cookie"),
    );
    return Response.json(
      { cleared },
      { headers: { "x-content-type-options": "nosniff" } },
    );
  }
  if (request.method !== "POST") {
    return jsonError("method not allowed", 405);
  }
  if (env.EXPLAIN_RATELIMIT) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.EXPLAIN_RATELIMIT.limit({ key: ip });
    if (!success) return jsonError("too many requests — try again in a minute", 429);
  }
  let token: unknown;
  try {
    const body: unknown = await request.json();
    token = (body as Record<string, unknown> | null)?.token;
  } catch {
    return jsonError("invalid JSON", 400);
  }
  if (typeof token !== "string") return jsonError("token required", 400);
  const ip = request.headers.get("cf-connecting-ip");
  const hostname = new URL(request.url).hostname;
  if (!(await turnstileOk(env.TURNSTILE_SECRET_KEY, token, ip, hostname))) {
    return jsonError("verification failed", 403);
  }
  return Response.json(
    { cleared: true },
    {
      headers: {
        "set-cookie": await clearanceSetCookie(env.TURNSTILE_SECRET_KEY),
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * Global daily cap across ALL clients (see budget.ts). Counted after
 * validation so malformed floods can't drain the budget for real users.
 * Fail-open: a budget-infra error must not take the endpoint down — the
 * per-IP limit and the provider spend limit still stand behind it.
 */
async function budgetExhausted(env: Env): Promise<boolean> {
  if (!env.BUDGET) return false;
  const limit = dailyBudgetLimit(env);
  if (limit === null) return false;
  try {
    const stub = env.BUDGET.get(env.BUDGET.idFromName("global"));
    return (await stub.consume(utcDay())) > limit;
  } catch {
    return false;
  }
}

/** UTC date key ("YYYY-MM-DD") the budget counter is bucketed by. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Configured explanations/day, or null when the cap is off or malformed. */
function dailyBudgetLimit(env: Env): number | null {
  const limit = Number(env.DAILY_BUDGET ?? DEFAULT_DAILY_BUDGET);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/**
 * How long a health probe may reuse the last budget reading.
 *
 * /api/health is public and ungated, so WITHOUT this every probe — and
 * every request of a flood — would queue an RPC against the ONE global
 * BudgetCounter that the paid path also needs. That matters because
 * budgetExhausted() fails OPEN: stall the counter and the daily cap stops
 * being enforced. Memoizing per isolate bounds health's load on it to one
 * read per window no matter the request rate. Well under a monitor's
 * 5-minute interval, so probes still see fresh numbers.
 */
const BUDGET_PROBE_TTL_MS = 10_000;

let budgetProbe: { at: number; day: string; used: number | null } | null = null;

async function probeBudgetUsed(
  budget: DurableObjectNamespace<BudgetCounter>,
): Promise<number | null> {
  const day = utcDay();
  const now = Date.now();
  // Keyed by day too, so a UTC rollover can't serve yesterday's total.
  if (budgetProbe && budgetProbe.day === day && now - budgetProbe.at < BUDGET_PROBE_TTL_MS) {
    return budgetProbe.used;
  }
  let used: number | null = null;
  try {
    // used(), never consume(): probing must not spend the budget.
    used = await budget.get(budget.idFromName("global")).used(day);
  } catch {
    used = null; // budget infra unreachable — report unknown, stay 200
  }
  // Cache failures too: a struggling DO must not get a retry storm.
  budgetProbe = { at: Date.now(), day, used };
  return used;
}

/**
 * Liveness + configuration probe: public, unauthenticated, no LLM spend,
 * and deliberately outside spendGate so external monitoring can reach it.
 *
 * It reports the states that silently DEGRADE the live path without taking
 * the site down — `provider` flips to "fake" if the API key vanishes,
 * `turnstile` false means the bot gate isn't configured, and `budget`
 * shows how close the day is to its cap. Every lookup fails SOFT: a
 * monitoring endpoint that 500s on a storage hiccup just pages you about
 * the monitor instead of the service.
 */
async function handleHealth(env: Env): Promise<Response> {
  const used = env.BUDGET ? await probeBudgetUsed(env.BUDGET) : null;
  return Response.json(
    {
      ok: true,
      service: "chess-web",
      prompt: PROMPT_VERSION,
      provider: providerFromEnv(env).name,
      turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
      budget: { used, limit: dailyBudgetLimit(env) },
      time: new Date().toISOString(),
    },
    {
      headers: {
        "x-content-type-options": "nosniff",
        // A cached health response would report "up" through an outage —
        // exactly what the monitor exists to catch.
        "cache-control": "no-store",
      },
    },
  );
}

function jsonError(message: string, status: number): Response {
  return Response.json(
    { error: message },
    { status, headers: { "x-content-type-options": "nosniff" } },
  );
}

type CappedJson = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Read + JSON-parse a request body, enforcing the byte cap WHILE reading —
 * Content-Length is client-controlled (and absent on chunked bodies), so the
 * cap must hold even when the header lies.
 */
async function readCappedJson(
  request: Request,
  capBytes: number,
  tooLargeMessage: string,
): Promise<CappedJson> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > capBytes) {
    return { ok: false, response: jsonError(tooLargeMessage, 413) };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > capBytes) {
        await reader.cancel();
        return { ok: false, response: jsonError(tooLargeMessage, 413) };
      }
      chunks.push(value);
    }
  }
  try {
    return { ok: true, body: JSON.parse(await new Blob(chunks).text()) as unknown };
  } catch {
    return { ok: false, response: jsonError("invalid JSON", 400) };
  }
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

  const read = await readCappedJson(request, CAPS.bodyBytes, "request body too large");
  if (!read.ok) return read.response;

  const parsed = parseExplainRequest(read.body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const built = buildPrompt(parsed.request);
  if (!built.ok) return jsonError(built.error, 400);

  if (await budgetExhausted(env)) {
    return jsonError(BUDGET_EXHAUSTED_MESSAGE, 429);
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

  // Same provider semantics as /api/explain: EXPLAIN_PROVIDER=fake (or no
  // key) must guarantee zero LLM spend — scan answers with a mock instead
  // of silently calling the paid vision API (review finding).
  const fake = env.EXPLAIN_PROVIDER === "fake" || !env.ANTHROPIC_API_KEY;

  const read = await readCappedJson(
    request,
    SCAN_CAPS.bodyBytes,
    "image too large — resize to under ~1MB",
  );
  if (!read.ok) return read.response;

  const parsed = parseScanRequest(read.body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  if (await budgetExhausted(env)) {
    return jsonError(BUDGET_EXHAUSTED_MESSAGE, 429);
  }

  let rawBoard: string;
  if (fake) {
    rawBoard = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  } else {
    try {
      rawBoard = await scanWithAnthropic(
        // fake === false implies the key exists (see above).
        env.ANTHROPIC_API_KEY as string,
        env.EXPLAIN_MODEL ?? DEFAULT_MODEL,
        parsed.image,
      );
    } catch {
      return jsonError("the vision model is unavailable — try again shortly", 502);
    }
  }

  const result = boardToFen(rawBoard);
  if (!result.ok) return jsonError(result.error, 422);
  return Response.json(
    { board: result.board, fen: result.fen },
    { headers: { "x-content-type-options": "nosniff" } },
  );
}

function route(request: Request, env: Env): Promise<Response> | Response {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    return handleHealth(env);
  }

  if (url.pathname === "/api/explain") {
    return handleExplain(request, env);
  }

  if (url.pathname === "/api/scan") {
    return handleScan(request, env);
  }

  if (url.pathname === "/api/verify") {
    return handleVerify(request, env);
  }

  return jsonError("not found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch {
      // Error boundary of last resort: nothing internal (stack, framework
      // detail) may ever reach the client, whatever threw.
      return jsonError("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
