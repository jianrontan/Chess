/**
 * Global daily budget for /api/explain.
 *
 * The per-IP rate limit is a brake, not accounting: it is per-colo and has no
 * aggregate ceiling — N attacking IPs get N budgets. This single Durable
 * Object (one instance, strongly consistent) counts every request that
 * reaches synthesis, worker-wide, and caps the day's total. Past the cap the
 * endpoint answers 429 until the next UTC day. Worst-case daily LLM spend is
 * therefore DAILY_BUDGET × (cost per explanation) no matter how many IPs an
 * abuser brings. The provider-side monthly spend limit remains the final
 * backstop.
 */

import { DurableObject } from "cloudflare:workers";

export class BudgetCounter extends DurableObject {
  /**
   * Count one explanation against `day` (UTC date, "YYYY-MM-DD") and return
   * the day's running total. A new day resets the counter; stale state from
   * previous days is overwritten, so storage stays a single small record.
   */
  async consume(day: string, limit?: number): Promise<number> {
    const stored = await this.ctx.storage.get<{ day: string; count: number }>("budget");
    const count = stored?.day === day ? stored.count + 1 : 1;
    // Stop persisting once past the cap. Every answer from here is 429
    // regardless of the exact total, so the write buys nothing — and
    // skipping it means a sustained drain attempt can't spin storage
    // writes on this one global object, while the stored number stays a
    // believable "explanations" figure instead of climbing into five
    // digits on /api/health. Enforcement is unchanged: reads keep
    // returning limit+2, limit+3… which are still > limit.
    if (limit === undefined || count <= limit + 1) {
      await this.ctx.storage.put("budget", { day, count });
    }
    return count;
  }

  /**
   * Read `day`'s total WITHOUT counting against it — for /api/health.
   * Monitoring must never consume budget: a 5-minute probe calling
   * consume() would burn ~288 explanations/day all by itself.
   */
  async used(day: string): Promise<number> {
    const stored = await this.ctx.storage.get<{ day: string; count: number }>("budget");
    return stored?.day === day ? stored.count : 0;
  }
}
