import { cardSummaryView } from "@kanera/shared/schema";
import { and, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { assignedCardVisibility } from "./access.js";
import type { AccessibleBoard } from "./accessible-boards.js";

/**
 * The subset of card columns every cross-board due/overdue projection needs.
 *
 * Declared as a type rather than referencing `cardSummaryView` directly so the same predicates can
 * be pointed at an aliased or narrowed projection. Shared by global work, the portfolio, and home,
 * which must never disagree about what "overdue" or "due soon" means.
 */
export type CardDueColumns = {
  id: typeof cardSummaryView.id;
  boardId: typeof cardSummaryView.boardId;
  listId: typeof cardSummaryView.listId;
  title: typeof cardSummaryView.title;
  dueDateLocalDate: typeof cardSummaryView.dueDateLocalDate;
  dueDateSlot: typeof cardSummaryView.dueDateSlot;
  dueDateTimezone: typeof cardSummaryView.dueDateTimezone;
  completedAt: typeof cardSummaryView.completedAt;
  archivedAt: typeof cardSummaryView.archivedAt;
  createdAt: typeof cardSummaryView.createdAt;
  updatedAt: typeof cardSummaryView.updatedAt;
};

export const cardSummaryDueColumns: CardDueColumns = {
  id: cardSummaryView.id,
  boardId: cardSummaryView.boardId,
  listId: cardSummaryView.listId,
  title: cardSummaryView.title,
  dueDateLocalDate: cardSummaryView.dueDateLocalDate,
  dueDateSlot: cardSummaryView.dueDateSlot,
  dueDateTimezone: cardSummaryView.dueDateTimezone,
  completedAt: cardSummaryView.completedAt,
  archivedAt: cardSummaryView.archivedAt,
  createdAt: cardSummaryView.createdAt,
  updatedAt: cardSummaryView.updatedAt,
};

export function currentLocalDateSql(columns: CardDueColumns): SQL {
  // Stored zones come from the user's IANA timezone setting. Falling back for null/empty values
  // mirrors the application overdue helper while keeping the global query index-friendly.
  return sql`(now() at time zone coalesce(nullif(${columns.dueDateTimezone}, ''), 'UTC'))::date`;
}

export function overdueSql(columns: CardDueColumns): SQL {
  const localDate = currentLocalDateSql(columns);
  const localTime = sql`(now() at time zone coalesce(nullif(${columns.dueDateTimezone}, ''), 'UTC'))::time`;
  return sql`(
    ${columns.dueDateLocalDate} is not null
    and (
      ${localDate} > ${columns.dueDateLocalDate}
      or (
        ${localDate} = ${columns.dueDateLocalDate}
        and ${localTime} >= case coalesce(${columns.dueDateSlot}, 'anyTime')
          when 'morning' then time '09:00'
          when 'afternoon' then time '13:00'
          when 'endOfWorkDay' then time '17:00'
          else time '21:00'
        end
      )
    )
  )`;
}

export function dueSoonSql(columns: CardDueColumns): SQL {
  const localDate = currentLocalDateSql(columns);
  return sql`(
    ${columns.dueDateLocalDate} is not null
    and ${columns.dueDateLocalDate} >= ${localDate}
    and ${columns.dueDateLocalDate} <= ${localDate} + 7
  )`;
}

export function overdueChecklistSql(cardId: typeof cardSummaryView.id, assigneeId?: string): SQL {
  // Checklist due dates use the same slot cut-offs as cards. Keep this projection in SQL so a
  // portfolio metric and its card drill-down are defined by the same predicate.
  return sql`exists (
    select 1
    from card_checklist_item work_item
    inner join card_checklist work_checklist on work_checklist.id = work_item.checklist_id
    where work_checklist.card_id = ${cardId}
      and work_item.assignee_id is not null
      ${assigneeId ? sql`and work_item.assignee_id = ${assigneeId}` : sql``}
      and work_item.completed_at is null
      and work_item.due_date_local_date is not null
      and (
        (now() at time zone coalesce(nullif(work_item.due_date_timezone, ''), 'UTC'))::date > work_item.due_date_local_date
        or (
          (now() at time zone coalesce(nullif(work_item.due_date_timezone, ''), 'UTC'))::date = work_item.due_date_local_date
          and (now() at time zone coalesce(nullif(work_item.due_date_timezone, ''), 'UTC'))::time >=
            case coalesce(work_item.due_date_slot, 'anyTime')
              when 'morning' then time '09:00'
              when 'afternoon' then time '13:00'
              when 'endOfWorkDay' then time '17:00'
              else time '21:00'
            end
        )
      )
  )`;
}

/**
 * Board scope plus the assigned-items-only boundary, as one predicate.
 *
 * `assignedItemsOnly` board members may only see cards assigned to them directly or via a checklist
 * item, so every cross-board card read must carry this. Shared rather than copied: a surface that
 * reimplemented it and got the restricted-board branch wrong would leak card titles across a
 * boundary the board settings promise.
 */
export function cardAccessCondition(
  authUserId: string,
  scopeBoards: AccessibleBoard[],
  columns: CardDueColumns,
): SQL {
  const boardIds = scopeBoards.map((board) => board.id);
  if (boardIds.length === 0) return sql`false`;
  const restrictedBoardIds = scopeBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
  return and(
    inArray(columns.boardId, boardIds),
    restrictedBoardIds.length
      ? or(
          notInArray(columns.boardId, restrictedBoardIds),
          assignedCardVisibility(authUserId, columns.id),
        )
      : undefined,
  )!;
}
