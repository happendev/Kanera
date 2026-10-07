import type { dto } from "@kanera/shared";
import type { activityEvents, comments } from "@kanera/shared/schema";
import { and, eq, gt, lt, or, type SQL } from "drizzle-orm";

/** Within one timestamp the card's own "created" entry sorts first so the feed opens with it. */
export function cardFeedSortPriority(item: dto.CardFeedItem): number {
  return item.type === "activity" && item.data.entityType === "card" && item.data.action === "created" ? 0 : 1;
}

/** Newest first; ties broken by the creation entry, then by id so pages are stable across requests. */
export function compareCardFeedItems(a: dto.CardFeedItem, b: dto.CardFeedItem): number {
  const ta = new Date(a.data.createdAt as unknown as string).getTime();
  const tb = new Date(b.data.createdAt as unknown as string).getTime();
  if (ta !== tb) return tb - ta;
  const priority = cardFeedSortPriority(a) - cardFeedSortPriority(b);
  if (priority !== 0) return priority;
  return String(a.data.id).localeCompare(String(b.data.id));
}

/**
 * Keyset predicate for the next feed page, mirroring `compareCardFeedItems`: strictly older rows, or
 * same-timestamp rows that sort after the cursor by priority and then id.
 */
export function feedAfterCursor(
  cursor: { createdAt: string; priority: number; id: string },
  createdAt: typeof comments.createdAt | typeof activityEvents.createdAt,
  id: typeof comments.id | typeof activityEvents.id,
  priority: SQL,
): SQL {
  const at = new Date(cursor.createdAt);
  return or(
    lt(createdAt, at),
    and(eq(createdAt, at), or(
      gt(priority, cursor.priority),
      and(eq(priority, cursor.priority), gt(id, cursor.id)),
    )),
  )!;
}
