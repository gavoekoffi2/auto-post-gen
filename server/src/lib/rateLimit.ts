import { queryOne } from "./db.js";
import { rateLimited } from "./errors.js";

/**
 * Per-bucket rate limit for endpoints reachable without a session.
 *
 * Backed by hit_ip_rate_limit, which takes an advisory lock: without it,
 * parallel requests all read the same count and all pass, and the "limit"
 * only slows down a single-threaded attacker.
 *
 * Fails OPEN. A database hiccup must not take down the login form; the cost
 * of letting a few extra requests through during an outage is much lower than
 * the cost of locking every user out.
 */
export async function hitRateLimit(
  bucket: string,
  max: number,
  windowSeconds: number,
  message = "Trop de requêtes. Réessayez dans un moment.",
): Promise<void> {
  let allowed = true;
  try {
    const row = await queryOne<{ hit_ip_rate_limit: boolean }>(
      `SELECT hit_ip_rate_limit($1, $2, $3)`,
      [bucket, max, windowSeconds],
    );
    allowed = row?.hit_ip_rate_limit !== false;
  } catch (err) {
    console.error("[rateLimit] check failed, allowing:", (err as Error).message);
    return;
  }
  if (!allowed) throw rateLimited(message);
}
