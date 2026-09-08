/** The browser's IANA timezone, or "UTC" if the runtime cannot report one. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A short, readable label such as "Europe/Paris (UTC+02:00)". */
export function timeZoneLabel(timeZone: string): string {
  try {
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return offset ? `${timeZone} (${offset})` : timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * Zones offered in the profile picker. The user's own zone is always included
 * and listed first, so anyone outside this list can still keep their real one.
 */
export function timeZoneOptions(current: string): string[] {
  const common = [
    "UTC",
    "Africa/Abidjan",
    "Africa/Lome",
    "Africa/Dakar",
    "Africa/Douala",
    "Africa/Kinshasa",
    "Africa/Casablanca",
    "Africa/Algiers",
    "Africa/Tunis",
    "Africa/Lagos",
    "Africa/Nairobi",
    "Europe/Paris",
    "Europe/Brussels",
    "Europe/Zurich",
    "Europe/London",
    "Europe/Lisbon",
    "America/Montreal",
    "America/New_York",
    "America/Cayenne",
    "Indian/Antananarivo",
    "Indian/Reunion",
  ];
  const browser = browserTimeZone();
  return Array.from(new Set([current, browser, ...common].filter(Boolean)));
}

/**
 * Split an ISO timestamp into the `<input type="date">` and
 * `<input type="time">` values for the viewer's own clock.
 *
 * Mixing `toISOString()` (UTC) for the date with `toTimeString()` (local) for
 * the time showed a date and a time from two different instants — off by a
 * full day for anyone east of UTC late in the evening.
 */
export function splitLocalDateTime(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Inverse of splitLocalDateTime: turn the two form values back into an ISO
 * instant. `"2026-09-09T00:30:00"` with no zone is read as UTC by Postgres, so
 * re-saving an unchanged post used to move it by the viewer's UTC offset.
 * Building a Date from the parts anchors it to the viewer's zone, and
 * toISOString() then sends an unambiguous instant.
 */
export function joinLocalDateTime(date: string, time: string): string | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if ([year, month, day, hour, minute].some((n) => !Number.isFinite(n))) return null;
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}
