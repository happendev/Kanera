import { SERVER_EVENTS } from "@kanera/shared/events";
import { boardSeparators, cards, type BoardSeparator } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { emitToBoard } from "../realtime/emit.js";
import { between } from "./position.js";
import { positionAtIndex } from "./position.js";
import { emitCardRebalancedByBoard, type CardRebalancedPosition, type RebalancedPosition } from "./rebalance.js";
import { badRequest } from "./errors.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

export function toWireSeparator(separator: BoardSeparator) {
  return separator;
}

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

export async function neighbourLanePositions(options: {
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

  const findAnchor = (anchor: LaneAnchor) => {
    const item = items.find((candidate) => candidate.type === anchor.type && candidate.id === anchor.id);
    if (!item) throw badRequest(`${anchor.type === "card" ? "card" : "separator"} anchor not found`);
    return item;
  };

  let prev: string | null = null;
  let next: string | null = null;
  if (options.afterItem === null && options.beforeItem === undefined) {
    next = items[0]?.position ?? null;
  } else if (options.beforeItem === null && options.afterItem === undefined) {
    prev = items.at(-1)?.position ?? null;
  } else if (options.afterItem) {
    const after = findAnchor(options.afterItem);
    const index = items.findIndex((item) => item.type === after.type && item.id === after.id);
    prev = after.position;
    next = items[index + 1]?.position ?? null;
  } else if (options.beforeItem) {
    const before = findAnchor(options.beforeItem);
    const index = items.findIndex((item) => item.type === before.type && item.id === before.id);
    next = before.position;
    prev = items[index - 1]?.position ?? null;
  }
  return { prev, next };
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
