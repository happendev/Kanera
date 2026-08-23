import { SERVER_EVENTS } from "@kanera/shared/events";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  boards,
  boardGroups,
  automations,
  cards,
  cardLabels,
  cardPriorities,
  checklistTemplates,
  customFields,
  customFieldOptions,
  lists,
  scratchpadNotes,
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

/**
 * Renumber every row matching `where` to evenly spaced positions.
 *
 * The ten wrappers below differ only in table, scope predicate, and tiebreak, so the query shape
 * lives here once: `select … for update order by position` inside the caller's transaction, then a
 * single batched `applyPositions`. Rows whose position is already correct are filtered out, so a
 * no-op rebalance issues no UPDATE at all.
 *
 * `for("update")` is load-bearing — it serialises concurrent rebalances of the same scope, which is
 * what stops two writers interleaving and producing duplicate positions.
 */
async function rebalanceTable(
  table: PgTable,
  columns: { id: AnyPgColumn; position: AnyPgColumn },
  where: SQL | undefined,
  options: { tx?: Tx; tiebreak?: AnyPgColumn } = {},
): Promise<RebalancedPosition[]> {
  const tx = options.tx ?? db;
  const order = options.tiebreak ? [asc(columns.position), asc(options.tiebreak)] : [asc(columns.position)];
  const rows = await tx
    .select({ id: columns.id, position: columns.position })
    .from(table)
    .where(where)
    .for("update")
    .orderBy(...order);

  const updates = rows
    .map((row, index) => ({ id: row.id as string, position: positionAtIndex(index), previousPosition: row.position as string }))
    .filter((row) => row.position !== row.previousPosition);

  await applyPositions(table, updates, tx);

  return updates.map(({ id, position }) => ({ id, position }));
}

export async function rebalanceBoards(workspaceId: string): Promise<RebalancedPosition[]> {
  return rebalanceTable(boards, { id: boards.id, position: boards.position }, and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)));
}

export async function rebalanceBoardGroups(workspaceId: string): Promise<RebalancedPosition[]> {
  return rebalanceTable(boardGroups, { id: boardGroups.id, position: boardGroups.position }, eq(boardGroups.workspaceId, workspaceId));
}

export async function rebalanceLists(workspaceId: string): Promise<RebalancedPosition[]> {
  return rebalanceTable(lists, { id: lists.id, position: lists.position }, and(eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)));
}

export async function rebalanceCustomFields(workspaceId: string): Promise<RebalancedPosition[]> {
  return rebalanceTable(customFields, { id: customFields.id, position: customFields.position }, and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt)));
}

export async function rebalanceCustomFieldOptions(fieldId: string): Promise<RebalancedPosition[]> {
  return rebalanceTable(customFieldOptions, { id: customFieldOptions.id, position: customFieldOptions.position }, and(eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt)));
}

export async function rebalanceCardLabels(workspaceId: string): Promise<RebalancedPosition[]> {
  return rebalanceTable(cardLabels, { id: cardLabels.id, position: cardLabels.position }, and(eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt)));
}

export async function rebalanceChecklistTemplates(workspaceId: string): Promise<RebalancedPosition[]> {
  return rebalanceTable(checklistTemplates, { id: checklistTemplates.id, position: checklistTemplates.position }, and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt)));
}

export async function rebalanceAutomations(workspaceId: string, tx: Tx = db): Promise<RebalancedPosition[]> {
  return rebalanceTable(automations, { id: automations.id, position: automations.position }, and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt)), { tx });
}

/**
 * Renumber one person's priority queue.
 *
 * Safe here in a way it is not for Global Work separators: that virtual lane mixes personal
 * positions with board-owned `cards.position`, so rebalancing it would rewrite source boards.
 * `card_priority.position` is shared with nobody — not `cards.position`, not another user's queue,
 * not any board — so renumbering is purely local.
 *
 * Not optional: with STEP = 1000 and EPS = 1e-6, roughly 30 successive drops into the same slot
 * exhaust the gap, and the failure mode without a rebalance is silent order corruption (two equal
 * positions tiebroken by id, so the sequence spontaneously changes) — unacceptable for a feature
 * whose whole value is "this order is what I said".
 */
export async function rebalanceCardPriorities(targetUserId: string, tx: Tx = db): Promise<RebalancedPosition[]> {
  // Tiebreak on cardId so two entries that momentarily share a position renumber deterministically.
  return rebalanceTable(
    cardPriorities,
    { id: cardPriorities.id, position: cardPriorities.position },
    eq(cardPriorities.targetUserId, targetUserId),
    { tx, tiebreak: cardPriorities.cardId },
  );
}

/**
 * Renumber one person's scratchpad tab order within one organisation.
 *
 * Purely local like `rebalanceCardPriorities`: `scratchpad_note.position` is shared with nobody — not
 * another user's scratchpad nor that person's scratchpad in another organisation — so renumbering
 * cannot reorder out-of-scope data. Required for the same reason: ~30 successive drops into one slot
 * exhaust the gap between two positions, and equal positions make the tab strip's order flip around
 * on its own.
 */
export async function rebalanceScratchpadNotes(
  userId: string,
  clientId: string,
  tx: Tx = db,
): Promise<RebalancedPosition[]> {
  return rebalanceTable(
    scratchpadNotes,
    { id: scratchpadNotes.id, position: scratchpadNotes.position },
    and(eq(scratchpadNotes.userId, userId), eq(scratchpadNotes.clientId, clientId)),
    { tx, tiebreak: scratchpadNotes.id },
  );
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
