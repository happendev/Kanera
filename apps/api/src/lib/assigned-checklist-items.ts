import { boards, cardChecklistItems, cardChecklists, cards, lists, type CardDueDateSlot } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// One canonical join for "assigned checklist items" across the surfaces that now treat
// checklist items as first-class work items (overdue notifications, home due-soon, and
// assigned-work). Keeping the join + active-entity filters in one place stops them from
// drifting between callers. Visibility scoping differs per surface and is therefore left
// to the caller: home/assigned-work pass a pre-resolved `boardIds` set, while the daily
// digest applies its own membership-based predicate inline (see daily-digest.ts).
export interface AssignedChecklistItemRow {
  itemId: string;
  text: string;
  checklistId: string;
  // Guaranteed non-null: every code path here filters to assigned items.
  assigneeId: string;
  cardId: string;
  cardTitle: string;
  listId: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  workspaceId: string;
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

const selection = {
  itemId: cardChecklistItems.id,
  text: cardChecklistItems.text,
  checklistId: cardChecklistItems.checklistId,
  assigneeId: cardChecklistItems.assigneeId,
  cardId: cards.id,
  cardTitle: cards.title,
  listId: cards.listId,
  boardId: cards.boardId,
  boardName: boards.name,
  boardIcon: boards.icon,
  workspaceId: lists.workspaceId,
  dueDateLocalDate: cardChecklistItems.dueDateLocalDate,
  dueDateSlot: cardChecklistItems.dueDateSlot,
  dueDateTimezone: cardChecklistItems.dueDateTimezone,
};

export interface LoadAssignedChecklistItemsOptions {
  // Restrict to these assignees. Omit to match any assigned item (assigneeId is not null).
  assigneeIds?: string[];
  // Restrict to these (already access-checked) boards.
  boardIds?: string[];
  // Restrict to specific checklist items (used by the overdue sweep for targeted recompute).
  itemIds?: string[];
  // Restrict dueDateLocalDate to these recipient-local dates (e.g. [today, tomorrow]).
  dueDateIn?: string[];
  // Whether to require a due date. Defaults to true; the overdue/due-soon surfaces all
  // need a due date, and it keeps the partial index on assignee_id useful.
  requireDueDate?: boolean;
  // Completed cards still allow checklist item edits, so Assigned Work can surface their
  // incomplete assigned items. Due-soon/notification surfaces keep the stricter default.
  includeCompletedCards?: boolean;
}

export async function loadAssignedChecklistItems(
  tx: Tx,
  opts: LoadAssignedChecklistItemsOptions = {},
): Promise<AssignedChecklistItemRow[]> {
  const requireDueDate = opts.requireDueDate ?? true;
  const conditions: SQL[] = [
    isNull(cardChecklistItems.completedAt),
    isNull(cards.archivedAt),
    isNull(lists.archivedAt),
    isNull(boards.archivedAt),
  ];
  if (!opts.includeCompletedCards) conditions.push(isNull(cards.completedAt));

  if (opts.assigneeIds) {
    if (opts.assigneeIds.length === 0) return [];
    conditions.push(inArray(cardChecklistItems.assigneeId, opts.assigneeIds));
  } else {
    conditions.push(sql`${cardChecklistItems.assigneeId} is not null`);
  }
  if (requireDueDate) conditions.push(sql`${cardChecklistItems.dueDateLocalDate} is not null`);
  if (opts.boardIds) {
    if (opts.boardIds.length === 0) return [];
    conditions.push(inArray(cards.boardId, opts.boardIds));
  }
  if (opts.itemIds) {
    if (opts.itemIds.length === 0) return [];
    conditions.push(inArray(cardChecklistItems.id, opts.itemIds));
  }
  if (opts.dueDateIn) {
    if (opts.dueDateIn.length === 0) return [];
    conditions.push(inArray(cardChecklistItems.dueDateLocalDate, opts.dueDateIn));
  }

  const rows = await tx
    .select(selection)
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(...conditions))
    .limit(5000);

  // assigneeId is guaranteed non-null by the filters above.
  return rows as AssignedChecklistItemRow[];
}
