// Canonical subscription limits — the single source of truth for what each
// plan is allowed to do.
//
// Until now the plans existed only on the pricing page and in a `plan` column:
// NOTHING enforced them. A Starter account could set post_frequency to 10 and
// receive the Enterprise volume, connect as many networks as Zernio allowed,
// and burn the same AI budget as everyone else. Every limit advertised to a
// paying customer is enforced here, server-side, where the client cannot
// tamper with it.
//
// Keep in sync with src/lib/plans.ts (mirrored for the UI) — tests/plan-limits
// fails the build if the two drift.

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

/** Unknown / missing plan falls back to the most restrictive tier. */
export function planLimits(plan: string | null | undefined): PlanLimits {
  const key = (plan || "").trim().toLowerCase();
  return PLAN_LIMITS[key as PlanId] ?? PLAN_LIMITS.starter;
}

export function isPlanId(value: string | null | undefined): value is PlanId {
  return !!value && value in PLAN_LIMITS;
}
