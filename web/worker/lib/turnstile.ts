/**
 * Turnstile server-side verification (browser → this Worker → siteverify;
 * never siteverify from the browser). Runs before any token-spending work.
 *
 * Fail modes: a missing/rejected client token is a hard 403 (that's the
 * point), but a siteverify *infrastructure* failure fails open — an attacker
 * can't induce those, and the rate limit + daily budget still stand.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Must match the `action` set when the widget renders (public/turnstile.html). */
const EXPECTED_ACTION = "turnstile-spin-v1";

/**
 * Cloudflare's dummy secrets (always-pass / always-fail / token-spent) answer
 * with canned hostname/action values, so those checks apply only to real keys.
 */
const DUMMY_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

export async function turnstileOk(
  secret: string,
  token: string | null,
  remoteIp: string | null,
  expectedHostname: string,
): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) return true; // siteverify outage — fail open
    const data = (await res.json()) as {
      success?: boolean;
      hostname?: string;
      action?: string;
    };
    if (data.success !== true) return false;
    if (DUMMY_SECRETS.has(secret)) return true;
    // Sitekeys are public: a valid token minted on someone else's site (or
    // for a different widget/action) must not clear ours.
    return data.hostname === expectedHostname && data.action === EXPECTED_ACTION;
  } catch {
    return true; // network failure to siteverify — fail open
  }
}
