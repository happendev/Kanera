import { SERVER_EVENTS } from "@kanera/shared/events";
import { boardSeparators, cards, globalWorkSeparators } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, type Tx } from "../db.js";
import { emitToBoard, emitToGlobalWorkSeparatorAudience } from "../realtime/emit.js";
import { between } from "./position.js";
import { positionAtIndex } from "./position.js";
import { applyPositions, emitCardRebalancedByBoard, type CardRebalancedPosition, type RebalancedPosition } from "./rebalance.js";
import { resolveNeighbourPositions } from "./lane-neighbours.js";

export type LaneItemType = "card" | "separator";
export type LaneAnchor = { type: LaneItemType; id: string };

export type LaneRebalanceResult = {
  cardPositions: CardRebalancedPosition[];
  separatorPositions: RebalancedPosition[];
};

type LaneItem = {
  type: LaneItemType;
  id: string;
  boardId: string;
  position: string;
};

async function loadLaneItems(listId: string, boardId: string, tx: Tx): Promise<LaneItem[]> {
  // Callers often pass a transaction handle, which is backed by one pg client.
  // Keep these queries sequential so we do not overlap client.query calls on that
  // transaction connection.
  const cardRows = await tx
    .select({ id: cards.id, boardId: cards.boardId, position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, listId), isNull(cards.archivedAt)))
    .orderBy(asc(cards.position));
  const separatorRows = await tx
    .select({ id: boardSeparators.id, boardId: boardSeparators.boardId, position: boardSeparators.position })
    .from(boardSeparators)
    .where(and(eq(boardSeparators.boardId, boardId), eq(boardSeparators.listId, listId)))
    .orderBy(asc(boardSeparators.position));
  return [
    ...cardRows.map((row): LaneItem => ({ type: "card", ...row })),
    ...separatorRows.map((row): LaneItem => ({ type: "separator", ...row })),
  ].sort((a, b) => Number(a.position) - Number(b.position) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

async function neighbourLanePositions(options: {
  listId: string;
  boardId: string;
  moving?: LaneAnchor;
  afterItem?: LaneAnchor | null;
  beforeItem?: LaneAnchor | null;
  tx?: Tx;
}) {
  const tx = options.tx ?? db;
  const items = (await loadLaneItems(options.listId, options.boardId, tx))
    .filter((item) => item.type !== options.moving?.type || item.id !== options.moving.id);

  return resolveNeighbourPositions(items, options);
}

export async function positionForLaneInsert(options: {
  listId: string;
  boardId: string;
  moving?: LaneAnchor;
  afterItem?: LaneAnchor | null;
  beforeItem?: LaneAnchor | null;
  tx?: Tx;
}) {
  const { prev, next } = await neighbourLanePositions(options);
  return between(prev, next);
}

export async function rebalanceBoardLane(listId: string, boardId: string, tx: Tx = db): Promise<LaneRebalanceResult> {
  const items = await loadLaneItems(listId, boardId, tx);
  const updates = items
    .map((item, index) => ({ ...item, position: positionAtIndex(index), previousPosition: item.position }))
    .filter((item) => item.position !== item.previousPosition);

  const cardPositions = updates
    .filter((item): item is LaneItem & { previousPosition: string } => item.type === "card")
    .map((item) => ({ id: item.id, boardId: item.boardId, position: item.position }));
  const separatorPositions = updates
    .filter((item): item is LaneItem & { previousPosition: string } => item.type === "separator")
    .map((item) => ({ id: item.id, position: item.position }));

  if (cardPositions.length > 0) {
    for (const item of cardPositions) {
      await tx.update(cards).set({ position: item.position, updatedAt: new Date() }).where(eq(cards.id, item.id));
    }
  }
  if (separatorPositions.length > 0) {
    for (const item of separatorPositions) {
      await tx.update(boardSeparators).set({ position: item.position, updatedAt: new Date() }).where(eq(boardSeparators.id, item.id));
    }
  }
  return { cardPositions, separatorPositions };
}

export async function emitLaneRebalanced(boardId: string, listId: string, result: LaneRebalanceResult): Promise<void> {
  if (result.cardPositions.length > 0) await emitCardRebalancedByBoard(listId, result.cardPositions);
  if (result.separatorPositions.length > 0) {
    await emitToBoard(boardId, SERVER_EVENTS.SEPARATOR_REBALANCED, {
      boardId,
      listId,
      positions: result.separatorPositions,
    });
  }
}

export type WorkspaceLaneRebalanceResult = {
  cardPositions: CardRebalancedPosition[];
  boardSeparatorPositions: (RebalancedPosition & { boardId: string })[];
  globalWorkSeparatorPositions: (RebalancedPosition & { workspaceId: string; targetUserId: string; prevPosition: string })[];
};

/**
 * Renumbers everything that can share a position in one workspace list: cards from every board,
 * every board's separators, and every person's Global Work separators.
 *
 * Card positions are only unique per board, so cards from different boards often tie (each board
 * numbers its lane from the same 1000 step). A merged Global Work lane breaks those ties by id,
 * which means nothing can be inserted between two tied neighbours: the midpoint equals both, and a
 * new id always sorts last. Every lane (a board lane, any person's Global Work lane) sorts by the
 * same `(position, type, id)` comparator over a subset of these rows, so renumbering the whole set
 * in that order makes positions strictly increasing without changing what any lane displays.
 */
export async function rebalanceWorkspaceLane(listId: string, tx: Tx): Promise<WorkspaceLaneRebalanceResult> {
  // Sequential on purpose: a transaction handle is one pg client (see loadLaneItems).
  const cardRows = await tx
    .select({ id: cards.id, boardId: cards.boardId, position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, listId), isNull(cards.archivedAt)))
    .for("update");
  const boardSeparatorRows = await tx
    .select({ id: boardSeparators.id, boardId: boardSeparators.boardId, position: boardSeparators.position })
    .from(boardSeparators)
    .where(eq(boardSeparators.listId, listId))
    .for("update");
  const globalWorkSeparatorRows = await tx
    .select({
      id: globalWorkSeparators.id,
      workspaceId: globalWorkSeparators.workspaceId,
      targetUserId: globalWorkSeparators.targetUserId,
      position: globalWorkSeparators.position,
    })
    .from(globalWorkSeparators)
    .where(eq(globalWorkSeparators.listId, listId))
    .for("update");

  type Row =
    | { kind: "card"; type: "card"; id: string; boardId: string; position: string }
    | { kind: "boardSeparator"; type: "separator"; id: string; boardId: string; position: string }
    | { kind: "globalWorkSeparator"; type: "separator"; id: string; workspaceId: string; targetUserId: string; position: string };
  const rows: Row[] = [
    ...cardRows.map((row): Row => ({ kind: "card", type: "card", ...row })),
    ...boardSeparatorRows.map((row): Row => ({ kind: "boardSeparator", type: "separator", ...row })),
    ...globalWorkSeparatorRows.map((row): Row => ({ kind: "globalWorkSeparator", type: "separator", ...row })),
  ].sort((a, b) => Number(a.position) - Number(b.position) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

  const result: WorkspaceLaneRebalanceResult = { cardPositions: [], boardSeparatorPositions: [], globalWorkSeparatorPositions: [] };
  rows.forEach((row, index) => {
    const position = positionAtIndex(index);
    if (position === row.position) return;
    if (row.kind === "card") result.cardPositions.push({ id: row.id, boardId: row.boardId, position });
    else if (row.kind === "boardSeparator") result.boardSeparatorPositions.push({ id: row.id, boardId: row.boardId, position });
    else result.globalWorkSeparatorPositions.push({ id: row.id, workspaceId: row.workspaceId, targetUserId: row.targetUserId, position, prevPosition: row.position });
  });

  await applyPositions(cards, result.cardPositions, tx);
  await applyPositions(boardSeparators, result.boardSeparatorPositions, tx);
  await applyPositions(globalWorkSeparators, result.globalWorkSeparatorPositions, tx);
  return result;
}

/** Fans a workspace lane rebalance out to every board and Global Work audience it touched. */
export async function emitWorkspaceLaneRebalanced(listId: string, result: WorkspaceLaneRebalanceResult): Promise<void> {
  if (result.cardPositions.length > 0) await emitCardRebalancedByBoard(listId, result.cardPositions);
  const separatorsByBoard = new Map<string, RebalancedPosition[]>();
  for (const { boardId, id, position } of result.boardSeparatorPositions) {
    separatorsByBoard.set(boardId, [...(separatorsByBoard.get(boardId) ?? []), { id, position }]);
  }
  for (const [boardId, positions] of separatorsByBoard) {
    await emitToBoard(boardId, SERVER_EVENTS.SEPARATOR_REBALANCED, { boardId, listId, positions });
  }
  // Global Work separators have no rebalance event; an in-place move carries the same information.
  for (const separator of result.globalWorkSeparatorPositions) {
    await emitToGlobalWorkSeparatorAudience(separator.workspaceId, separator.targetUserId, SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_MOVED, {
      workspaceId: separator.workspaceId,
      targetUserId: separator.targetUserId,
      separatorId: separator.id,
      fromListId: listId,
      toListId: listId,
      position: separator.position,
      prevPosition: separator.prevPosition,
    });
  }
}
