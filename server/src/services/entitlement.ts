import { queryOne } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import {
  ENTITLEMENT_COLUMNS,
  SUBSCRIPTION_EXPIRED_MESSAGE,
  resolveEntitlement,
  type Entitlement,
  type SubscriptionFields,
} from "../shared/plans.js";

// What an account may do right now — always read from the database, never
// from the request. The subscription columns are not in the profile PATCH
// allow-list, so no user-facing route can extend a trial or grant a plan.

interface EntitlementRow {
  plan: string | null;
  subscription_status: string | null;
  trial_plan: string | null;
  trial_ends_at: Date | string | null;
  current_period_ends_at: Date | string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

/** node-postgres returns timestamptz as Date; the shared policy speaks ISO. */
export function toSubscriptionFields(row: EntitlementRow | null): SubscriptionFields | null {
  if (!row) return null;
  return {
    plan: row.plan,
    subscription_status: row.subscription_status,
    trial_plan: row.trial_plan,
    trial_ends_at: iso(row.trial_ends_at),
    current_period_ends_at: iso(row.current_period_ends_at),
  };
}

export async function loadEntitlement(profileId: string): Promise<Entitlement> {
  const row = await queryOne<EntitlementRow>(
    `SELECT ${ENTITLEMENT_COLUMNS} FROM profiles WHERE id = $1`,
    [profileId],
  );
  return resolveEntitlement(toSubscriptionFields(row));
}

/**
 * The entitlement, or a 402 when the trial or paid period has ended.
 *
 * Called before anything that creates content. Publishing posts that were
 * already scheduled does not call it: an unpaid account stops generating, it
 * does not lose the posts it already has.
 */
export async function requireActiveEntitlement(profileId: string): Promise<Entitlement> {
  const entitlement = await loadEntitlement(profileId);
  if (!entitlement.canGenerate) {
    throw new HttpError(402, SUBSCRIPTION_EXPIRED_MESSAGE, "subscription_expired");
  }
  return entitlement;
}

/**
 * Generations of `fn` in the rolling 30 days — the plan's cost ceiling.
 *
 * Counted before the hourly reservation. Not atomic on its own, but the
 * hourly reservation right after it is, so a burst can overshoot the monthly
 * ceiling by at most that hourly allowance.
 */
export async function monthlyUsage(profileId: string, fn: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM generation_usage
      WHERE profile_id = $1 AND function_name = $2
        AND created_at >= now() - interval '30 days'`,
    [profileId, fn],
  );
  return row?.n ?? 0;
}
