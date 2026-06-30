import { SERVER_EVENTS } from "@kanera/shared/events";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  boards,
  boardGroups,
  automations,
  cards,
  cardLabels,
  checklistTemplates,
  customFields,
  customFieldOptions,
  lists,
} from "@kanera/shared/schema";
import { db, type Db } from "../db.js";
import { emitToBoard } from "../realtime/emit.js";
import { positionAtIndex } from "./position.js";

export interface RebalancedPosition {
  id: string;
  position: string;
}

export type CardRebalancedPosition = RebalancedPosition & { boardId: string };

type Tx = Pick<Db, "execute" | "select" | "update">;

// A rebalance can touch every sibling at once, so apply all new positions in a single statement
// instead of one UPDATE per row. We build `set position = case id when <id> then <pos> ... end`
// over the changed rows; ids and positions are parameterized, so this is injection-safe. All
// rebalanced tables share the `id` / `position` / `updated_at` columns this relies on.
async function applyPositions(table: PgTable, updates: RebalancedPosition[], tx: Tx): Promise<void> {
  if (updates.length === 0) return;
  const cases = updates.map((row) => sql`when ${row.id} then ${row.position}::numeric`);
  const ids = updates.map((row) => sql`${row.id}`);
  await tx.execute(sql`
    update ${table}
    set position = case id ${sql.join(cases, sql` `)} end,
        updated_at = now()
    where id in (${sql.join(ids, sql`, `)})
  `);
}

export async function rebalanceBoards(workspaceId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: boards.id, position: boards.position })
    .from(boards)
    .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)))
    .for("update")
    .orderBy(asc(boards.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(boards, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceBoardGroups(workspaceId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: boardGroups.id, position: boardGroups.position })
    .from(boardGroups)
    .where(eq(boardGroups.workspaceId, workspaceId))
    .for("update")
    .orderBy(asc(boardGroups.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(boardGroups, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceLists(workspaceId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: lists.id, position: lists.position })
    .from(lists)
    .where(and(eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
    .for("update")
    .orderBy(asc(lists.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(lists, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceCustomFields(workspaceId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: customFields.id, position: customFields.position })
    .from(customFields)
    .where(and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt)))
    .for("update")
    .orderBy(asc(customFields.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(customFields, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceCustomFieldOptions(fieldId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: customFieldOptions.id, position: customFieldOptions.position })
    .from(customFieldOptions)
    .where(and(eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt)))
    .for("update")
    .orderBy(asc(customFieldOptions.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(customFieldOptions, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceCardLabels(workspaceId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: cardLabels.id, position: cardLabels.position })
    .from(cardLabels)
    .where(and(eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt)))
    .for("update")
    .orderBy(asc(cardLabels.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(cardLabels, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceChecklistTemplates(workspaceId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: checklistTemplates.id, position: checklistTemplates.position })
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt)))
    .for("update")
    .orderBy(asc(checklistTemplates.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(checklistTemplates, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceAutomations(workspaceId: string): Promise<RebalancedPosition[]> {
  const rows = await db
    .select({ id: automations.id, position: automations.position })
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt)))
    .for("update")
    .orderBy(asc(automations.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(automations, updates, db);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceCards(listId: string, tx: Tx = db): Promise<CardRebalancedPosition[]> {
  const rows = await tx
    .select({ id: cards.id, boardId: cards.boardId, position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, listId), isNull(cards.archivedAt)))
    // Card order is workspace-list-scoped, so the lock spans all boards in this
    // list. A per-board rebalance would preserve stale local slices and scramble
    // cross-board priority.
    .for("update")
    .orderBy(asc(cards.position));

  const updates = rows
    .map((row, index) => ({ id: row.id, boardId: row.boardId, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(cards, updates, tx);

  return updates.map(({ id, boardId, position }) => ({ id, boardId, position }));
}

export async function emitCardRebalancedByBoard(listId: string, positions: readonly CardRebalancedPosition[]): Promise<void> {
  const byBoard = new Map<string, RebalancedPosition[]>();
  for (const { boardId, id, position } of positions) {
    const boardPositions = byBoard.get(boardId) ?? [];
    boardPositions.push({ id, position });
    byBoard.set(boardId, boardPositions);
  }
  for (const [boardId, boardPositions] of byBoard) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_REBALANCED, { boardId, listId, positions: boardPositions });
  }
}
