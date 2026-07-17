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
  async consume(day: string): Promise<number> {
    const stored = await this.ctx.storage.get<{ day: string; count: number }>("budget");
    const count = stored?.day === day ? stored.count + 1 : 1;
    await this.ctx.storage.put("budget", { day, count });
    return count;
  }
}
