/**
 * Turnstile server-side verification (browser → this Worker → siteverify;
 * never siteverify from the browser). Runs before any token-spending work.
 *
 * Fail modes: a missing/rejected client token is a hard 403 (that's the
 * point), but a siteverify *infrastructure* failure fails open — an attacker
 * can't induce those, and the rate limit + daily budget still stand.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function turnstileOk(
  secret: string,
  token: string | null,
  remoteIp: string | null,
): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) return true; // siteverify outage — fail open
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return true; // network failure to siteverify — fail open
  }
}
