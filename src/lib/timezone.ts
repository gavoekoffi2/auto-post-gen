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
