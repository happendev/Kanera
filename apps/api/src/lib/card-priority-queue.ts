import type { WorkPriorityItem, WorkPriorityLabel, WorkPriorityQueueSnapshot } from "@kanera/shared/dto";
import { compactCardSummary } from "@kanera/shared/events";
import {
  boards,
  cardAssignees,
  cardLabelAssignments,
  cardLabels,
  cardPriorities,
  cardSummaryView,
  lists,
  users,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import { toWireCardSummary } from "./card-summary.js";

/**
 * What counts as being *in* the queue.
 *
 * A queue answers "what's next", so completed and archived cards drop out of it. This is the one
 * place the board rule "completing a card must not make it vanish from the list you completed it in"
 * deliberately does not apply: leaving a done card ranked made the top of the list read as a
 * struck-through no-op. The row itself survives, so un-completing or un-archiving restores the card
 * at its original position, and every count the client sees — rank, `totalCount`, the entry cap —
 * is taken over this same set so they cannot disagree.
 *
 * Survival is time-boxed for completion: the completed-priority-cleanup sweep deletes rows whose
 * card has been done past a 24h grace window, so the restore-on-uncomplete behaviour is an undo for
 * mis-clicks, not a promise that reopening months-old work resurrects its old rank.
 */
export const liveQueueCardCondition = and(
  isNull(cardSummaryView.archivedAt),
  isNull(cardSummaryView.completedAt),
);

/**
 * Hydrated queue rows in canonical order for whatever `where` scopes them — the one projection every
 * hydrated queue read shares: the per-target endpoint, the Team Cards lanes batch, and the realtime
 * snapshot pushed to the target.
 *
 * Board, list and workspace rows are joined for their names: a queue spanning several boards is
 * unreadable without them, and neither Home nor the priorities drawer holds a work catalog to
 * resolve ids against.
 *
 * The `card_assignee` join is correlated on the *entry's own* target, so it works unchanged for a
 * single queue and for the multi-target lanes batch. It is also belt-and-braces beside
 * `cleanupUserBoardParticipation`: a missed cleanup call site degrades to "not shown" rather than
 * lying to the assignee, and re-assigning restores the original rank.
 */
export function priorityQueueRows(where: SQL | undefined) {
  return db
    .select()
    .from(cardPriorities)
    .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardPriorities.cardId))
    .innerJoin(workspaces, eq(workspaces.id, cardSummaryView.workspaceId))
    .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
    .innerJoin(lists, eq(lists.id, cardSummaryView.listId))
    .innerJoin(cardAssignees, and(
      eq(cardAssignees.cardId, cardPriorities.cardId),
      eq(cardAssignees.userId, cardPriorities.targetUserId),
    ))
    .where(where)
    .orderBy(asc(cardPriorities.targetUserId), asc(cardPriorities.position), asc(cardPriorities.cardId));
}

export type PriorityQueueRow = Awaited<ReturnType<typeof priorityQueueRows>>[number];

/**
 * Labels for a set of queued cards, as cardId → chips in workspace label order.
 *
 * Deliberately a *separate* statement rather than another join on `priorityQueueRows`: those rows
 * are consumed positionally (`rank = index + 1`), so a one-to-many fan-out would hand a
 * three-label card three ranks and corrupt every number after it.
 *
 * Callers pass only the card ids they are about to render *visibly*, so a redacted entry's labels
 * are never even read out of the database.
 */
export async function priorityQueueLabels(cardIds: string[]): Promise<Map<string, WorkPriorityLabel[]>> {
  const byCardId = new Map<string, WorkPriorityLabel[]>();
  if (cardIds.length === 0) return byCardId;
  const rows = await db
    .select({
      cardId: cardLabelAssignments.cardId,
      id: cardLabels.id,
      name: cardLabels.name,
      color: cardLabels.color,
    })
    .from(cardLabelAssignments)
    .innerJoin(cardLabels, eq(cardLabels.id, cardLabelAssignments.labelId))
    // Imported historical data can retain assignments to archived labels. Board catalogs and tiles
    // hide those labels, so the priority projection must apply the same active-label boundary.
    .where(and(inArray(cardLabelAssignments.cardId, cardIds), isNull(cardLabels.archivedAt)))
    // Workspace label position, so the chips read in the same order as the card's board tile.
    .orderBy(asc(cardLabels.position), asc(cardLabels.id));
  for (const row of rows) {
    const existing = byCardId.get(row.cardId) ?? [];
    existing.push({ id: row.id, name: row.name, color: row.color });
    byCardId.set(row.cardId, existing);
  }
  return byCardId;
}

/**
 * One queue row as the client sees it, redacted when this viewer may not see the card.
 *
 * `rank` comes from the caller's index into the *target's* live set, never the viewer's, so a
 * manager who can see 3 of 5 entries reads 1, 2, 5 — the same numbers the assignee reads.
 */
export function toPriorityQueueItem(
  row: PriorityQueueRow,
  rank: number,
  options: { visible: boolean; clientId: string; labels: WorkPriorityLabel[] },
): WorkPriorityItem {
  return {
    id: row.card_priority.id,
    position: row.card_priority.position,
    rank,
    // Same projection `workCards()` runs, so a WorkCard from either endpoint is shape-identical.
    // `lastActivityAt`/`lastMovedAt` are deliberately absent: they are not part of the WorkCard type,
    // and neither the Priorities display nor the Home block renders staleness.
    card: options.visible
      ? {
          ...compactCardSummary(toWireCardSummary(row.card_summary_view, options.clientId)),
          workspaceId: row.card_summary_view.workspaceId,
        }
      : null,
    // Redacted with the card: an entry the viewer cannot see must disclose no board or list name.
    context: options.visible
      ? {
          boardName: row.board.name,
          boardIcon: row.board.icon,
          boardIconColor: row.board.iconColor,
          listName: row.list.name,
          listIcon: row.list.icon,
          listColor: row.list.color,
          workspaceName: row.workspace.name,
          labels: options.labels,
        }
      : null,
  };
}

/**
 * One user's own queue, unredacted, for the realtime snapshot pushed to that user.
 *
 * Deliberately a pure function of `targetUserId` with no `AuthClaims`, because the emit path has
 * none: it runs after a commit that may have been made by somebody else entirely. That is sound only
 * because this is sent to the target and to nobody else — every entry is a card assigned to them,
 * and losing board access deletes the row (`cleanupUserBoardParticipation`), so the target is never
 * partially sighted and no visibility pass is needed. Anyone else watching this queue gets the
 * content-free `cardPriority:invalidated` ping and refetches under their own credentials.
 *
 * Shares `priorityQueueRows`/`toPriorityQueueItem` with the REST reads so the event payload and the
 * `GET /work/priorities/:userId` body cannot drift apart.
 */
export async function loadOwnPriorityQueueSnapshot(targetUserId: string): Promise<WorkPriorityQueueSnapshot> {
  const [ownerRows, rows] = await Promise.all([
    db.select({ clientId: users.clientId }).from(users).where(eq(users.id, targetUserId)).limit(1),
    priorityQueueRows(and(eq(cardPriorities.targetUserId, targetUserId), liveQueueCardCondition)),
  ]);
  const clientId = ownerRows[0]?.clientId ?? "";
  // Every entry is visible here (this snapshot only ever goes to the target), so every card's
  // labels are wanted.
  const labelsByCardId = await priorityQueueLabels(rows.map((row) => row.card_summary_view.id));
  const items = rows.map((row, index) => toPriorityQueueItem(row, index + 1, {
    visible: true,
    clientId,
    labels: labelsByCardId.get(row.card_summary_view.id) ?? [],
  }));

  return {
    targetUserId,
    items,
    totalCount: items.length,
    // Stamped at read time, not send time: two mutations can drain from the outbox out of order, and
    // this is what lets a client discard the older queue instead of resurrecting a stale order.
    snapshotAt: new Date().toISOString(),
  };
}
