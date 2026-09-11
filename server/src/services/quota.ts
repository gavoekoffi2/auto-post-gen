import { queryOne } from "../lib/db.js";

/**
 * Reserves one unit of a per-account quota.
 *
 * Backed by consume_generation_quota, which takes an advisory lock before it
 * counts. Without that lock, parallel requests all read the same count and all
 * pass — the classic way a "limit" turns out not to be one.
 */
export async function consumeQuota(
  profileId: string,
  fn: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const row = await queryOne<{ consume_generation_quota: boolean }>(
    `SELECT consume_generation_quota($1, $2, $3, $4)`,
    [profileId, fn, max, windowSeconds],
  );
  return row?.consume_generation_quota !== false;
}

/**
 * Gives back the most recent reservation.
 *
 * Called when the work the reservation paid for did not happen — a provider
 * that refused before rendering, or a canned fallback. Deletes exactly one
 * row, so the usage history is preserved rather than wiped.
 */
export async function releaseQuota(profileId: string, fn: string): Promise<void> {
  try {
    await queryOne(`SELECT release_generation_quota($1, $2)`, [profileId, fn]);
  } catch (err) {
    // Failing to refund is not worth failing the request the user is waiting
    // on; it costs them one unit of an hourly allowance.
    console.error("[quota] release failed:", (err as Error).message);
  }
}
