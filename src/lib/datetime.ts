// Scheduling helpers.
//
// posts.scheduled_for is a timestamptz. The whole app must therefore convert
// between the *user's local* wall clock (what the date/time inputs show) and an
// absolute instant (what the database and the publishing cron compare against).
//
// Getting this wrong is not cosmetic: the dashboard used to read the DATE in
// UTC (toISOString) but the TIME in local time (toTimeString), then save the
// two back concatenated WITHOUT any offset — a naive string Postgres reads as
// UTC. For a user at UTC+1 that silently shifted every re-saved post by an
// hour, and around midnight it moved it to the wrong day entirely.

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO instant → "YYYY-MM-DD" in the viewer's local timezone. */
export function toLocalDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO instant → "HH:MM" in the viewer's local timezone. */
export function toLocalTimeInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * "YYYY-MM-DD" + "HH:MM" entered by the user (local wall clock) → absolute ISO
 * instant to store, or null when either part is missing/invalid.
 */
export function fromLocalDateTimeInput(
  dateValue: string | null | undefined,
  timeValue: string | null | undefined,
): string | null {
  if (!dateValue || !timeValue) return null;
  const [year, month, day] = dateValue.split("-").map((part) => parseInt(part, 10));
  const [hours, minutes] = timeValue.split(":").map((part) => parseInt(part, 10));
  if (![year, month, day, hours, minutes].every(Number.isFinite)) return null;
  const local = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}
