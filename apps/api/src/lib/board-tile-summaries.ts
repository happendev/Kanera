import { BOARD_TILE_MEMBER_LIMIT, type BoardTileSummary } from "@kanera/shared/dto";
import { boardMembers, cardChecklistItems, cardChecklists, cards, users } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import type { AuthClaims } from "../auth/plugin.js";
import { loadAccessibleBoards } from "./accessible-boards.js";
import { cardAccessCondition, cardDueColumns, overdueSql } from "./card-due-sql.js";
import { withSignedMedia } from "./media-keys.js";

/**
 * The counts row for a set of board tiles.
 *
 * Scope is the intersection of the requested ids and the boards the viewer can open, resolved
 * through `loadAccessibleBoards` so cross-organisation guest boards and standalone boards count the
 * same way the sidebar lists them. The card predicates are exactly the Portfolio bucket's
 * (`cardAccessCondition` for the assigned-items restriction, unarchived, `overdueSql`), so a tile
 * never shows a number the Portfolio row for the same board would contradict.
 */
export async function loadBoardTileSummaries(auth: AuthClaims, boardIds: string[]): Promise<BoardTileSummary[]> {
  const requested = new Set(boardIds);
  const scopeBoards = (await loadAccessibleBoards(auth)).filter((board) => requested.has(board.id));
  if (scopeBoards.length === 0) return [];
  const scopeIds = scopeBoards.map((board) => board.id);
  const conditions = [cardAccessCondition(auth.sub, scopeBoards, cardDueColumns), isNull(cards.archivedAt)];

  // Three independent projections over the same resolved scope; none feeds another.
  const [cardRows, checklistRows, memberRows] = await Promise.all([
    db
      .select({
        boardId: cards.boardId,
        open: sql<number>`count(*) filter (where ${cards.completedAt} is null)::integer`,
        completed: sql<number>`count(*) filter (where ${cards.completedAt} is not null)::integer`,
        overdue: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${overdueSql(cardDueColumns)})::integer`,
        // "Next" is the soonest deadline still ahead; overdue cards are the overdue count's story.
        nextDueDate: sql<string | null>`min(${cards.dueDateLocalDate}) filter (where ${cards.completedAt} is null and not ${overdueSql(cardDueColumns)})`,
        lastActivityAt: sql<Date | null>`max(${cards.updatedAt})`,
      })
      .from(cards)
      .where(and(...conditions))
      .groupBy(cards.boardId),

    // Items on open cards only: a finished card's checklist is finished work, not progress to show.
    db
      .select({
        boardId: cards.boardId,
        done: sql<number>`count(*) filter (where ${cardChecklistItems.completedAt} is not null)::integer`,
        total: sql<number>`count(*)::integer`,
      })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
      .where(and(...conditions, isNull(cards.completedAt)))
      .groupBy(cards.boardId),

    // Explicit membership in join order, the same list the board payload hands every viewer, so a
    // restricted viewer sees nothing here they would not see on the board itself.
    db
      .select({
        boardId: boardMembers.boardId,
        userId: boardMembers.userId,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        clientId: users.clientId,
      })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(inArray(boardMembers.boardId, scopeIds))
      .orderBy(asc(boardMembers.addedAt), asc(boardMembers.userId)),
  ]);

  const cardsByBoard = new Map(cardRows.map((row) => [row.boardId, row]));
  const checklistByBoard = new Map(checklistRows.map((row) => [row.boardId, row]));
  const membersByBoard = new Map<string, { members: BoardTileSummary["members"]; count: number }>();
  for (const row of memberRows) {
    const entry = membersByBoard.get(row.boardId) ?? { members: [], count: 0 };
    entry.count += 1;
    if (entry.members.length < BOARD_TILE_MEMBER_LIMIT) {
      entry.members.push({
        userId: row.userId,
        displayName: row.displayName,
        // Avatar keys sign against the owner's organisation, as every other member list does.
        avatarUrl: withSignedMedia(row.clientId, { avatarUrl: row.avatarUrl }).avatarUrl,
      });
    }
    membersByBoard.set(row.boardId, entry);
  }

  return scopeIds.map((boardId) => {
    const counts = cardsByBoard.get(boardId);
    const checklist = checklistByBoard.get(boardId);
    const members = membersByBoard.get(boardId);
    const lastActivityAt = counts?.lastActivityAt ?? null;
    return {
      boardId,
      open: counts?.open ?? 0,
      completed: counts?.completed ?? 0,
      overdue: counts?.overdue ?? 0,
      checklistDone: checklist?.done ?? 0,
      checklistTotal: checklist?.total ?? 0,
      nextDueDate: counts?.nextDueDate ?? null,
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
      members: members?.members ?? [],
      memberCount: members?.count ?? 0,
    };
  });
}
