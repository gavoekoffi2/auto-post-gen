// Timezone-correct scheduling.
//
// The Supabase edge runtime's local time is UTC, so `date.setHours(10, 0)`
// scheduled a user's "10:00" at 10:00 UTC regardless of where they are, and
// `date.getDay()` answered with the UTC weekday — which can differ from the
// user's own weekday near midnight. Everything here works from an explicit
// IANA zone instead of the runtime's.
//
// No dependencies: `Intl.DateTimeFormat` already carries the tz database.

/** Falls back to UTC for a missing or unusable zone rather than throwing. */
export function safeTimeZone(value: unknown): string {
  const tz = typeof value === "string" ? value.trim() : "";
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    console.warn(`Unknown timezone "${tz}", falling back to UTC`);
    return "UTC";
  }
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday .. 6 = Saturday
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** The wall-clock reading of `instant` in `timeZone`. */
export function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const num = (type: string) => parseInt(get(type), 10);

  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    // Intl can emit "24" for midnight under hour12:false; normalise it.
    hour: num("hour") % 24,
    minute: num("minute"),
    second: num("second"),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // formatToParts drops sub-second precision, so compare on whole seconds.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given local
 * date and time.
 *
 * The offset depends on the instant we are solving for, so we guess, measure
 * the offset there, correct, and measure once more — which settles DST
 * transitions. On a "spring forward" gap (a local time that never occurs) this
 * lands on the instant just after the jump, which is the sane behaviour for a
 * scheduler.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  const corrected = naive - zoneOffsetMs(new Date(instant), timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/**
 * The next occurrence of `targetWeekday` at `hour`:`minute`, expressed in
 * `timeZone` and returned as a UTC instant.
 *
 * When the target day is today and the time has already passed in the user's
 * own zone, it rolls to the following week.
 */
export function nextOccurrenceInZone(
  now: Date,
  targetWeekday: number, // 0 = Sunday
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const today = partsInZone(now, timeZone);
  let daysAhead = (targetWeekday - today.weekday + 7) % 7;

  if (daysAhead === 0) {
    const todayAtTime = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
    if (todayAtTime.getTime() <= now.getTime()) daysAhead = 7;
  }

  // Add whole days in the zone's own calendar: build the target date from the
  // local Y/M/D so a DST shift never moves it onto the wrong day.
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + daysAhead));
  return zonedTimeToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}
