/**
 * Pre-clearance cookie for browsers where the invisible per-request Turnstile
 * path can't run (credentialless iframes are Chromium-only). The user passes
 * Turnstile ONCE on the top-level /turnstile page; /api/verify checks that
 * token and issues a short-lived HMAC-signed cookie which the spend gate then
 * accepts in place of a per-request token.
 *
 * Value format: "<expiry-unix-seconds>.<hex hmac-sha256(expiry, secret)>".
 * The Turnstile secret doubles as the HMAC key — server-only either way.
 */

export const CLEARANCE_COOKIE = "clearance";
export const CLEARANCE_TTL_S = 3600;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(s: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/.test(s) || s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Set-Cookie header value granting clearance for CLEARANCE_TTL_S. */
export async function clearanceSetCookie(secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + CLEARANCE_TTL_S;
  const key = await hmacKey(secret);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp))));
  return [
    `${CLEARANCE_COOKIE}=${exp}.${sig}`,
    `Max-Age=${CLEARANCE_TTL_S}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
  ].join("; ");
}

/** True when the request carries a valid, unexpired clearance cookie. */
export async function clearanceValid(
  secret: string,
  cookieHeader: string | null,
): Promise<boolean> {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${CLEARANCE_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [expStr, sigHex] = match[1].split(".");
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < Date.now() / 1000) return false;
  const sig = sigHex ? hexToBytes(sigHex) : null;
  if (!sig) return false;
  const key = await hmacKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sig as unknown as ArrayBuffer,
    new TextEncoder().encode(String(exp)),
  );
}
