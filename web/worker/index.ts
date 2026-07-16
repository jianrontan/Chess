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

import { buildPrompt, PROMPT_VERSION } from "./lib/prompt";
import { providerFromEnv, type ProviderEnv } from "./lib/providers";
import { CAPS, parseExplainRequest } from "./lib/schema";

interface Env extends ProviderEnv {
  ASSETS: Fetcher;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
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
    },
  });
}

async function handleExplain(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method not allowed", 405);
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

  const provider = providerFromEnv(env);
  return streamText(provider.explain(built.prompt));
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

    return jsonError("not found", 404);
  },
} satisfies ExportedHandler<Env>;
