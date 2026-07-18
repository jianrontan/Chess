"use client";

/**
 * Invisible Turnstile via a credentialless iframe.
 *
 * The main document runs under COEP: require-corp (the threaded engine needs
 * crossOriginIsolated), which blocks Turnstile's challenge iframes — verified
 * empirically. The workaround: /turnstile.html (served WITHOUT COEP) hosts
 * the widget inside an <iframe credentialless>, which exempts the whole
 * subtree from the parent's embedder policy. Tokens are minted on demand
 * over same-origin postMessage.
 *
 * Browser support: credentialless iframes are Chromium-only (Chrome/Edge).
 * Elsewhere the mint fails → the Worker answers 403 when enforcement is on.
 * Known v1 limitation; a pre-clearance detour page is the designed upgrade.
 */

// Canonical asset path: the platform strips ".html" (307 otherwise).
const IFRAME_SRC = "/turnstile";
const READY_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 20_000;

interface MintMsg {
  type: "turnstile-token";
  id: number;
  token: string | null;
}

let frame: HTMLIFrameElement | null = null;
let readyPromise: Promise<boolean> | null = null;
let nextId = 1;
const waiters = new Map<number, (token: string | null) => void>();

function onMessage(e: MessageEvent) {
  if (e.origin !== window.location.origin) return;
  const d = e.data as Partial<MintMsg> | undefined;
  if (d?.type !== "turnstile-token" || typeof d.id !== "number") return;
  const resolve = waiters.get(d.id);
  if (resolve) {
    waiters.delete(d.id);
    resolve(typeof d.token === "string" ? d.token : null);
  }
}

/**
 * Create the hidden host iframe; resolves true when the widget is ready.
 * A FAILED bootstrap is NOT cached (review finding): the broken iframe is
 * torn down and the next mint retries from scratch, so one slow network
 * moment can't disable verification for the whole session.
 */
function ensureFrame(): Promise<boolean> {
  readyPromise ??= new Promise<boolean>((resolve) => {
    window.addEventListener("message", onMessage);

    const el = document.createElement("iframe");
    // The load-bearing attribute: exempts the subtree from the page's COEP.
    el.setAttribute("credentialless", "");
    el.src = IFRAME_SRC;
    el.style.position = "fixed";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.bottom = "0";
    el.style.right = "0";
    el.style.border = "0";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;

    const timer = setTimeout(() => {
      window.removeEventListener("message", onReady);
      el.remove();
      frame = null;
      readyPromise = null; // retry on the next mint
      resolve(false);
    }, READY_TIMEOUT_MS);
    const onReady = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if ((e.data as { type?: string } | undefined)?.type !== "turnstile-ready") return;
      clearTimeout(timer);
      window.removeEventListener("message", onReady);
      resolve(true);
    };
    window.addEventListener("message", onReady);
    document.body.appendChild(el);
    frame = el;
  });
  return readyPromise;
}

async function mintOnce(): Promise<string | null> {
  const ready = await ensureFrame();
  if (!ready || !frame?.contentWindow) return null;

  const id = nextId++;
  const result = new Promise<string | null>((resolve) => {
    waiters.set(id, resolve);
  });
  frame.contentWindow.postMessage({ type: "turnstile-mint", id }, window.location.origin);

  const timeout = new Promise<string | null>((resolve) =>
    setTimeout(() => {
      waiters.delete(id);
      resolve(null);
    }, TOKEN_TIMEOUT_MS),
  );
  return Promise.race([result, timeout]);
}

// The widget mints one token at a time, and a new execute() cancels the
// in-flight one (which surfaced as a spurious 403 on the earlier request —
// review finding). Serialize mints so overlapping explain/scan calls queue
// instead of cancelling each other.
let mintChain: Promise<unknown> = Promise.resolve();

/**
 * Mint a fresh single-use token, or null if Turnstile is unavailable
 * (unsupported browser, network failure, challenge rejection). The Worker
 * rejects tokenless requests with 403 when enforcement is on.
 */
export function getTurnstileToken(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const p = mintChain.then(() => mintOnce());
  mintChain = p.catch(() => null);
  return p;
}
