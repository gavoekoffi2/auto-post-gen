// Plans, prices and the subscription lifecycle — the single definition of
// what each account is allowed to do.
//
// This module is intentionally dependency-free and uses only erasable
// TypeScript so the exact same file works in three runtimes:
//   - the API server (Node):          server/src/shared/plans.ts
//   - the dashboard (Vite / React):   src/lib/plans.ts
//   - the Node test runner (type stripping)
//
// Keep the two copies byte-for-byte identical — tests/subscription.test.js
// enforces it. Edit both together.
//
// The server copy is the one that ENFORCES: every limit sold on the pricing
// page is applied by the API, from columns only the server writes. The
// dashboard copy only labels and pre-constrains the UI.

export type PlanId = "starter" | "pro" | "enterprise";

export interface PlanLimits {
  id: PlanId;
  label: string;
  /** Automatic posts generated per week by auto-generate-weekly. */
  postsPerWeek: number;
  /** Social accounts connectable through Zernio. */
  socialAccounts: number;
  /** Cost ceiling: AI text generations per rolling 30 days. */
  monthlyTextGenerations: number;
  /** Cost ceiling: AI poster generations per rolling 30 days. */
  monthlyImageGenerations: number;
  /** AI auto-reply to comments. */
  aiAutoReply: boolean;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  starter: {
    id: "starter",
    label: "Starter",
    postsPerWeek: 3,
    socialAccounts: 2,
    monthlyTextGenerations: 60,
    monthlyImageGenerations: 60,
    aiAutoReply: false,
  },
  pro: {
    id: "pro",
    label: "Pro",
    postsPerWeek: 7,
    socialAccounts: 3,
    monthlyTextGenerations: 150,
    monthlyImageGenerations: 150,
    aiAutoReply: false,
  },
  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    postsPerWeek: 10,
    socialAccounts: 8,
    monthlyTextGenerations: 300,
    monthlyImageGenerations: 300,
    aiAutoReply: true,
  },
};

export type BillingPeriod = "monthly" | "annual";

/**
 * Prices in FCFA. The pricing page, the payment screen and the server-side
 * amount check all read these, so the price a customer is shown and the price
 * they are asked to pay cannot drift apart.
 *
 * `annualPerMonth` is the displayed monthly equivalent; the amount charged for
 * a year is twelve times it.
 */
export const PLAN_PRICES_FCFA: Record<PlanId, { monthly: number; annualPerMonth: number }> = {
  starter: { monthly: 5000, annualPerMonth: 4200 },
  pro: { monthly: 15000, annualPerMonth: 12500 },
  enterprise: { monthly: 35000, annualPerMonth: 29000 },
};

/** What a customer pays for one billing period. */
export function priceFor(plan: PlanId, period: BillingPeriod): number {
  const price = PLAN_PRICES_FCFA[plan];
  return period === "annual" ? price.annualPerMonth * 12 : price.monthly;
}

/** Length of the free trial, in days. Mirrored by the signup migration. */
export const TRIAL_DAYS = 7;

/** Unknown / missing plan falls back to the most restrictive tier. */
export function planLimits(plan: string | null | undefined): PlanLimits {
  const key = (plan || "").trim().toLowerCase();
  return PLAN_LIMITS[key as PlanId] ?? PLAN_LIMITS.starter;
}

export function isPlanId(value: string | null | undefined): value is PlanId {
  return !!value && Object.prototype.hasOwnProperty.call(PLAN_LIMITS, value);
}

export type EntitlementState = "trialing" | "active" | "expired";

export interface SubscriptionFields {
  plan?: string | null;
  subscription_status?: string | null;
  trial_plan?: string | null;
  trial_ends_at?: string | null;
  current_period_ends_at?: string | null;
}

export interface Entitlement {
  state: EntitlementState;
  /** The plan whose limits apply right now (the trial plan while trialing). */
  plan: PlanId;
  limits: PlanLimits;
  /** When the current trial or paid period ends; null = open-ended. */
  endsAt: string | null;
  /** Whole days left, rounded up; null when open-ended. 0 once expired. */
  daysLeft: number | null;
  /** May the account create new content (AI text, posters, networks)? */
  canGenerate: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / DAY_MS));
}

/**
 * The single answer to "what is this account allowed to do right now?".
 *
 * Derived from timestamps at read time rather than from a status some job has
 * to update: a trial that ended at 03:00 is over at 03:00 whether or not any
 * cron ran. Every server-side gate and every screen that shows the plan calls
 * this, so the product never says one thing and enforces another.
 *
 *  - active, no end date     → the paid plan, open-ended (comped / legacy)
 *  - active, end in future   → the paid plan until then
 *  - trialing, end in future → the trial plan until then
 *  - anything past its end   → expired: limits fall to Starter and new
 *    generation stops. Posts already scheduled are still published.
 */
export function resolveEntitlement(
  profile: SubscriptionFields | null | undefined,
  now: number = Date.now(),
): Entitlement {
  const status = profile?.subscription_status;

  if (status === "active") {
    const plan = isPlanId(profile?.plan) ? profile!.plan as PlanId : "starter";
    const endsAt = profile?.current_period_ends_at ?? null;
    if (!endsAt || new Date(endsAt).getTime() > now) {
      return {
        state: "active",
        plan,
        limits: PLAN_LIMITS[plan],
        endsAt,
        daysLeft: endsAt ? daysUntil(endsAt, now) : null,
        canGenerate: true,
      };
    }
    return expired(endsAt);
  }

  if (status === "trialing") {
    const plan = isPlanId(profile?.trial_plan) ? profile!.trial_plan as PlanId : "pro";
    const endsAt = profile?.trial_ends_at ?? null;
    if (endsAt && new Date(endsAt).getTime() > now) {
      return {
        state: "trialing",
        plan,
        limits: PLAN_LIMITS[plan],
        endsAt,
        daysLeft: daysUntil(endsAt, now),
        canGenerate: true,
      };
    }
    return expired(endsAt);
  }

  // No lifecycle data at all (a row predating the migration that somehow
  // escaped the backfill): fail towards the most restrictive paid tier rather
  // than locking the person out.
  return {
    state: "active",
    plan: "starter",
    limits: PLAN_LIMITS.starter,
    endsAt: null,
    daysLeft: null,
    canGenerate: true,
  };
}

function expired(endsAt: string | null): Entitlement {
  return {
    state: "expired",
    plan: "starter",
    limits: PLAN_LIMITS.starter,
    endsAt,
    daysLeft: 0,
    canGenerate: false,
  };
}

/** Columns to select from `profiles` to call resolveEntitlement. */
export const ENTITLEMENT_COLUMNS =
  "plan, subscription_status, trial_plan, trial_ends_at, current_period_ends_at";

/** Shown wherever an expired account is refused new content. */
export const SUBSCRIPTION_EXPIRED_MESSAGE =
  "Votre essai gratuit ou votre abonnement est terminé. Choisissez un forfait " +
  "sur la page Abonnement pour reprendre la génération : vos posts déjà " +
  "programmés continuent d'être publiés.";

/** Accepted payment channels, as stored in subscription_requests. */
export const PAYMENT_METHODS = {
  wave: "Wave",
  orange_money: "Orange Money",
  mtn_momo: "MTN Mobile Money",
  moov_money: "Moov Money",
  other: "Autre",
} as const;

export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, value);
}
