// Timezone-aware scheduling for the weekly generator.
//
// profiles.preferred_days / preferred_time are WALL-CLOCK values chosen by the
// user ("Lundi", "10:00"). The generator used to build the instant with
// Date#setHours, which resolves in the edge runtime's own clock — UTC. So the
// stored intent ("Monday 10:00 for me") became "Monday 10:00 UTC" for everyone,
// and any user outside UTC was published at the wrong hour.
//
// These helpers convert a wall-clock slot in an IANA zone to the correct
// absolute instant, using Intl to read the zone's offset at that moment (so DST
// transitions are handled without a timezone database of our own).
//
// Pure: no Deno globals, so the test suite exercises the real logic from Node.

export const DAY_NAME_TO_INDEX: Record<string, number> = {
  Dimanche: 0,
  Lundi: 1,
  Mardi: 2,
  Mercredi: 3,
  Jeudi: 4,
  Vendredi: 5,
  Samedi: 6,
};

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Falls back to UTC rather than throwing: a bad zone must not stop a user's
// whole weekly batch from being generated.
export function safeTimeZone(timeZone: unknown): string {
  return typeof timeZone === "string" && isValidTimeZone(timeZone) ? timeZone : "UTC";
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    // Some runtimes render midnight as hour 24 in hour12:false.
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second"),
  };
}

// Minutes that the zone is ahead of UTC at this instant (e.g. +180 for
// Africa/Nairobi, -300 for America/New_York in winter).
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

// The weekday (0=Sunday) as seen in the zone, not in the runtime's clock.
export function weekdayInZone(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

// Turn a wall-clock date+time in `timeZone` into the matching absolute instant.
// Applied twice so a slot that lands near a DST change resolves against the
// offset actually in effect at the target, not the one at the initial guess.
export function zonedWallClockToInstant(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let instant = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000;
  instant = naive - zoneOffsetMinutes(new Date(instant), timeZone) * 60000;
  return new Date(instant);
}

export interface SlotRequest {
  now: Date;
  timeZone: string;
  /** 0=Sunday … 6=Saturday, expressed in the user's zone. */
  weekday: number;
  hour: number;
  minute: number;
  /** Extra whole weeks to push the slot out (used when a rotation wraps). */
  weeksAhead?: number;
}

// Next occurrence of "weekday at hour:minute" in the user's zone, strictly in
// the future. When today IS the target day but the time has already passed, the
// slot moves to next week — same rule the generator had, now evaluated against
// the user's clock instead of the server's.
export function nextWeeklySlot(request: SlotRequest): Date {
  const timeZone = safeTimeZone(request.timeZone);
  const hour = Math.min(23, Math.max(0, Math.trunc(request.hour)));
  const minute = Math.min(59, Math.max(0, Math.trunc(request.minute)));
  const weekday = ((Math.trunc(request.weekday) % 7) + 7) % 7;
  const weeksAhead = Math.max(0, Math.trunc(request.weeksAhead ?? 0));

  const today = partsInZone(request.now, timeZone);
  const currentWeekday = weekdayInZone(request.now, timeZone);

  let daysUntil = (weekday - currentWeekday + 7) % 7;
  if (daysUntil === 0) {
    const todayAtTime = zonedWallClockToInstant(
      today.year,
      today.month,
      today.day,
      hour,
      minute,
      timeZone,
    );
    if (todayAtTime.getTime() <= request.now.getTime()) daysUntil = 7;
  }
  daysUntil += weeksAhead * 7;

  // Add the day offset on the calendar date, then resolve the wall clock — so
  // a day added across a DST change still lands on the intended local time.
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day));
  target.setUTCDate(target.getUTCDate() + daysUntil);

  return zonedWallClockToInstant(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}

// "10:00" / "9:5" / garbage → clamped {hour, minute}, defaulting to 10:00.
export function parsePreferredTime(value: unknown): { hour: number; minute: number } {
  const [rawHour, rawMinute] = String(value ?? "10:00").split(":").map((n) => parseInt(n, 10));
  return {
    hour: Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 10,
    minute: Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0,
  };
}
