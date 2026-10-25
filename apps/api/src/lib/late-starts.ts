import { boardMembers, boards, cardAssignees, cards, lists, type Card } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "../db.js";
import { isDueDateOverdue, localParts } from "./due-date.js";
import { workspaceFeatureEnabledSql } from "./workspace-features.js";

export type LateStartRow = Pick<Card, "id" | "key" | "title" | "organisationKey" | "boardId" | "listId" | "startDateLocalDate" | "dueDateLocalDate" | "dueDateSlot" | "dueDateTimezone"> & {
  userId: string;
  boardName: string;
};

/**
 * Open cards assigned to these users whose planned start has passed but that have never been in
 * progress: the "should have started by now" list for the daily digest and work.my_day.
 *
 * "Started" is only knowable where time in progress is tracked, so a card counts only when its
 * workspace has the timeline and time in progress on, its board tracks progress, and the workspace
 * has at least one in-progress list (lists are workspace-scoped). Without one, every card would read
 * as never started. A card that is already overdue is left out: it is reported as overdue, which is
 * the more urgent of the two.
 *
 * `todayFor` gives each user's local date; a start on that day is not late yet. Board access follows
 * the digest: a non-observer board membership, the same rule as the rest of the email.
 */
export async function loadLateStarts(
  executor: Db | Tx,
  opts: { userIds: readonly string[]; todayFor: (userId: string) => string; now: Date },
): Promise<LateStartRow[]> {
  if (opts.userIds.length === 0) return [];
  const rows = await executor
    .select({
      userId: cardAssignees.userId,
      id: cards.id,
      key: cards.key,
      title: cards.title,
      organisationKey: cards.organisationKey,
      boardId: cards.boardId,
      boardName: boards.name,
      listId: cards.listId,
      startDateLocalDate: cards.startDateLocalDate,
      dueDateLocalDate: cards.dueDateLocalDate,
      dueDateSlot: cards.dueDateSlot,
      dueDateTimezone: cards.dueDateTimezone,
    })
    .from(cardAssignees)
    .innerJoin(cards, eq(cards.id, cardAssignees.cardId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, cardAssignees.userId)))
    .where(and(
      inArray(cardAssignees.userId, [...opts.userIds]),
      isNotNull(cards.startDateLocalDate),
      isNull(cards.completedAt),
      isNull(cards.archivedAt),
      isNull(boards.archivedAt),
      isNull(lists.archivedAt),
      isNull(cards.inProgressSince),
      eq(cards.inProgressSeconds, 0),
      eq(boards.inProgressEnabled, true),
      sql`${boardMembers.role} <> 'observer'`,
      workspaceFeatureEnabledSql("timeline", cards.workspaceId),
      workspaceFeatureEnabledSql("inProgress", cards.workspaceId),
      sql`exists (select 1 from list progress_list where progress_list.workspace_id = ${cards.workspaceId} and progress_list.in_progress and progress_list.archived_at is null)`,
    ))
    .orderBy(asc(cardAssignees.userId), asc(cards.startDateLocalDate), asc(cards.id))
    .limit(10_000);
  return rows.filter((row) => row.startDateLocalDate! < opts.todayFor(row.userId) && !isDueDateOverdue(row, opts.now));
}

/** A user's local date, falling back to UTC for an unknown zone. */
export function localToday(now: Date, timeZone: string | null | undefined): string {
  return localParts(now, timeZone || "UTC").date;
}
