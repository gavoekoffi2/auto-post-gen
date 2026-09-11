// The weekly plan's arithmetic.
//
// Pure and dependency-free so it can be exercised directly, which matters:
// this is where weekly generation has gone wrong before — a same-day target
// pushed a full week out, and two posts written with the EXACT same
// scheduled_for that then went out back-to-back in one publish tick.

export type ContentCategory = "value" | "research" | "promo";

/** Hours added between two posts that land on the same preferred day. */
const SLOT_SPACING_HOURS = 4;

const DAY_MAPPING: Record<string, number> = {
  Dimanche: 0,
  Lundi: 1,
  Mardi: 2,
  Mercredi: 3,
  Jeudi: 4,
  Vendredi: 5,
  Samedi: 6,
};

export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/**
 * Lays out the categories across the week's free slots.
 *
 * The promo and research counts are ceilings the user chose, so the plan fills
 * them first and pads with value posts. A week already carrying two promos
 * does not get a third just because a top-up run happened.
 */
export function buildEditorialPlan(
  promo: number,
  research: number,
  slots: number,
): ContentCategory[] {
  const remaining: Record<ContentCategory, number> = {
    value: Math.max(0, slots - promo - research),
    research: Math.max(0, research),
    promo: Math.max(0, promo),
  };
  const plan: ContentCategory[] = [];
  const order: ContentCategory[] = ["value", "research", "promo"];
  while (plan.length < slots && order.some((c) => remaining[c] > 0)) {
    for (const category of order) {
      if (plan.length >= slots) break;
      if (remaining[category] > 0) {
        plan.push(category);
        remaining[category] -= 1;
      }
    }
  }
  while (plan.length < slots) plan.push("value");
  return plan;
}

/**
 * Computes the instant for one slot.
 *
 * Exported because the day/hour arithmetic is where this has gone wrong
 * before: a same-day target that was always pushed a full week out, and two
 * posts landing on the EXACT same instant when there are more posts than
 * preferred days — they then went out back-to-back in one publish tick.
 */
export function slotInstant(
  now: Date,
  slotIndex: number,
  preferredDays: string[],
  hour: number,
  minute: number,
): Date {
  const day = preferredDays[slotIndex % preferredDays.length] ?? "Lundi";
  const targetDayNumber = DAY_MAPPING[day] ?? 1;
  const passOverDays = Math.floor(slotIndex / preferredDays.length);
  const slotHour = Math.min(21, hour + passOverDays * SLOT_SPACING_HOURS);

  const scheduled = new Date(now);
  let daysUntilTarget = (targetDayNumber - scheduled.getDay() + 7) % 7;
  if (daysUntilTarget === 0) {
    // Today is the target day: keep today only if the chosen time is still
    // ahead. Always pushing a week out dropped this week's post entirely.
    const todayAtTime = new Date(now);
    todayAtTime.setHours(slotHour, minute, 0, 0);
    if (todayAtTime.getTime() <= now.getTime()) daysUntilTarget = 7;
  }
  scheduled.setDate(scheduled.getDate() + daysUntilTarget);
  scheduled.setHours(slotHour, minute, 0, 0);
  return scheduled;
}

