import { NOTIFICATION_REASON, boardMembers, boards, cardChecklistItems, cards, clientMembers, clients, notifications } from "@kanera/shared/schema";
import { sql } from "drizzle-orm";
import { assignedCardVisibility } from "./access.js";

export function inboxVisibleNotificationCondition() {
  // Every inbox query and badge must use exactly the same actionable rows, including legacy
  // notifications left behind by access changes. Org admins retain their unrestricted access.
  return sql`${cards.archivedAt} is null
    and (${notifications.reason} not in (${NOTIFICATION_REASON.OVERDUE}, ${NOTIFICATION_REASON.CHECKLIST_ITEM_OVERDUE}) or ${cards.completedAt} is null)
    and (${notifications.reason} <> ${NOTIFICATION_REASON.CHECKLIST_ITEM_OVERDUE} or exists (
      select 1 from ${cardChecklistItems} where ${cardChecklistItems.id} = ${notifications.checklistItemId}
        and ${cardChecklistItems.completedAt} is null
    ))
    and (${notifications.boardId} is null or exists (select 1 from ${boards}
      where ${boards.id} = ${notifications.boardId} and ${boards.archivedAt} is null))
    and exists (select 1 from ${clients} where ${clients.id} = ${notifications.clientId}
      and ${clients.suspendedAt} is null and ${clients.deletedAt} is null)
    and not exists (select 1 from ${clientMembers}
      where ${clientMembers.clientId} = ${notifications.clientId} and ${clientMembers.userId} = ${notifications.userId}
        and (${clientMembers.suspendedAt} is not null or ${clientMembers.removedAt} is not null))
    and (
      exists (select 1 from ${clientMembers}
        where ${clientMembers.clientId} = ${notifications.clientId}
          and ${clientMembers.userId} = ${notifications.userId}
          and ${clientMembers.clientRole} in ('owner', 'admin')
          and ${clientMembers.suspendedAt} is null and ${clientMembers.removedAt} is null)
      or exists (select 1 from ${boardMembers}
        where ${boardMembers.boardId} = ${notifications.boardId}
          and ${boardMembers.userId} = ${notifications.userId}
          and (${boardMembers.assignedItemsOnly} = false or ${notifications.cardId} is null
            or ${assignedCardVisibility(notifications.userId, notifications.cardId)}))
    )`;
}
