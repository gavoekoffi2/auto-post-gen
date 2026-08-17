// The user's IANA timezone, used to interpret their scheduling preferences.
//
// preferred_time ("10:00") is a wall-clock intent that only means something
// alongside a zone. The weekly generator runs on a UTC edge runtime, so without
// this the stored hour was applied as a UTC hour for everyone.

export const DEFAULT_TIME_ZONE = "UTC";

export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(timeZone: unknown): string {
  return typeof timeZone === "string" && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

// Human label for the settings UI, e.g. "Africa/Lagos (UTC+1)".
export function describeTimeZone(timeZone: string): string {
  const zone = normalizeTimeZone(timeZone);
  try {
    const label = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    return label ? `${zone} (${label})` : zone;
  } catch {
    return zone;
  }
}
