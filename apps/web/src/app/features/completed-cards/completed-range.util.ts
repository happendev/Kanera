import { formatDate } from "../../shared/date-format";

// Helpers for the board's "show completed cards" date-range filter. Kept beside the completed-cards
// panel so both entry points agree on how a picked day maps to an instant.

/** Format a YYYY-MM-DD value for display, falling back to the raw string if it is malformed. */
export function formatCompletedRangeDate(value: string): string {
  return formatDate(value, "medium") || value;
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
