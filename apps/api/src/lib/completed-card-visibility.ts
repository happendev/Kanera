import { or, gte, isNull } from "drizzle-orm";
import { cardSummaryView } from "@kanera/shared/schema";

const DAY_MS = 24 * 60 * 60 * 1000; // 1,440 minutes

export function activeCompletedCardPredicate(activeDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - activeDays * DAY_MS);
  return or(isNull(cardSummaryView.completedAt), gte(cardSummaryView.completedAt, cutoff));
}

// Parse a completed-range query param. Clients send a full ISO instant, but a bare YYYY-MM-DD is
// also accepted; when it bounds the end of a range we extend it to the end of that UTC day so a
// single-day range still includes everything completed during that day. Returns null when absent
// or unparseable so callers fall back to the default visibility window.
export function parseCompletedDateParam(value: string | undefined, endOfDay = false): Date | null {
  if (!value) return null;
  const normalized = endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
