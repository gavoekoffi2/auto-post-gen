// Local wall-clock helpers for the scheduling UI.
//
// <input type="date"> and <input type="time"> both speak LOCAL wall-clock, while
// posts.scheduled_for is an absolute instant (timestamptz). Converting between
// the two is where scheduling bugs live, so it happens in exactly one place.
//
// The bug this replaces: the dashboard read the date with
// `toISOString().split("T")[0]` (UTC) but the time with `toTimeString()`
// (local), then wrote them back joined as "YYYY-MM-DDTHH:mm:00" — a string with
// no offset, which Postgres reads as UTC. Saving an untouched post therefore
// shifted it by the user's UTC offset every time, and near midnight the date
// jumped a day.

const pad = (n: number) => String(n).padStart(2, "0");

/** Absolute instant → "YYYY-MM-DD" as the user sees it locally. */
export function toLocalDateInput(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Absolute instant → "HH:mm" as the user sees it locally. */
export function toLocalTimeInput(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Local "YYYY-MM-DD" + "HH:mm" → absolute ISO instant.
 * Returns null when either half is missing or unparseable, so a partially
 * filled form clears the schedule instead of storing a bogus date.
 */
export function localDateTimeToIso(date?: string | null, time?: string | null): string | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) return null;
  // Reject values that would silently roll over (e.g. month 13 → next January).
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  // A rolled-over date (31 April → 1 May) means the input was not a real date.
  if (local.getMonth() !== month - 1 || local.getDate() !== day) return null;
  return local.toISOString();
}

/** Combine a Date (day) and an "HH:mm" string into an absolute instant. */
export function combineDateAndTime(day: Date, time: string): string | null {
  return localDateTimeToIso(toLocalDateInput(day), time);
}
