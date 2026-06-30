// Shared helpers for the "show completed cards" date-range filter used by the board and
// Assigned Work views. Kept in one place so both surfaces agree with the completed-cards panel
// on how a picked day maps to an instant.

/** Format a YYYY-MM-DD value for display, falling back to the raw string if it is malformed. */
export function formatCompletedRangeDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(year, month - 1, day));
}

/**
 * Convert a YYYY-MM-DD range into the query params the API expects. The day is interpreted in the
 * viewer's local timezone (start vs end of day) — matching the completed-cards panel — so both
 * surfaces include the same cards for a given picked range regardless of the user's offset.
 */
export function appendCompletedRangeParams(params: URLSearchParams, from: string, to: string): void {
  if (from) params.set("completedFrom", new Date(`${from}T00:00:00.000`).toISOString());
  if (to) params.set("completedTo", new Date(`${to}T23:59:59.999`).toISOString());
}
