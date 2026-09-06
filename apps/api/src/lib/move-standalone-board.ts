import { boards, workspaces } from "@kanera/shared/schema";
import type { MoveBoardBody } from "@kanera/shared/dto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { emitBoardRebalancedToVisibleUsers, emitToBoardAudience } from "../realtime/emit.js";
import { recordActivity } from "./activity.js";
import { badRequest, notFound } from "./errors.js";
import { between, positionAtIndex } from "./position.js";

/** Standalone boards share organisation ordering despite each having its own hidden workspace. */
export async function moveStandaloneBoard(clientId: string, actorId: string, id: string, body: MoveBoardBody) {
  const result = await db.transaction(async (tx) => {
    // Legacy standalone boards all started at the same position. Normalise the entire order in
    // one locked transaction so an anchor with tied positions still means exactly before/after.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`standalone-order:${clientId}`}))`);
    const scope = tx.select({ id: workspaces.id }).from(workspaces)
      .where(and(eq(workspaces.clientId, clientId), eq(workspaces.kind, "board"), isNull(workspaces.archivedAt)));
    const siblings = await tx.select().from(boards)
      .where(and(inArray(boards.workspaceId, scope), isNull(boards.archivedAt)))
      .orderBy(asc(boards.position), asc(boards.name), asc(boards.id)).for("update");
    const current = siblings.find((board) => board.id === id);
    if (!current) throw notFound("board not found");
    const ordered = siblings.filter((board) => board.id !== id);
    const anchorId = body.afterBoardId ?? body.beforeBoardId;
    let index: number;
    if (anchorId) {
      const anchorIndex = ordered.findIndex((board) => board.id === anchorId);
      if (anchorIndex < 0) throw badRequest("board ordering anchor not found");
      index = anchorIndex + (body.afterBoardId ? 1 : 0);
    } else {
      index = body.beforeBoardId === null ? ordered.length : 0;
    }
    const hasTies = new Set(siblings.map((board) => board.position)).size !== siblings.length;
    const positions = new Map(siblings.map((board, i) => [board.id, hasTies ? positionAtIndex(i) : board.position]));
    const prev = ordered[index - 1];
    const next = ordered[index];
    const gap = between(prev ? positions.get(prev.id)! : null, next ? positions.get(next.id)! : null);
    positions.set(id, gap.position);
    ordered.splice(index, 0, current);
    if (gap.needsRebalance) ordered.forEach((board, i) => positions.set(board.id, positionAtIndex(i)));
    const updates = ordered.map((board) => ({
      id: board.id, workspaceId: board.workspaceId, prevPosition: board.position, position: positions.get(board.id)!,
    })).filter((board) => board.position !== board.prevPosition);
    if (updates.length) {
      const cases = updates.map((board) => sql`when ${board.id} then ${board.position}::numeric`);
      await tx.update(boards).set({
        position: sql`case ${boards.id} ${sql.join(cases, sql` `)} end`, updatedAt: new Date(),
      }).where(inArray(boards.id, updates.map((board) => board.id)));
    }
    const position = positions.get(id)!;
    await recordActivity(tx, { boardId: id, workspaceId: current.workspaceId, actorId,
      entityType: "board", entityId: id, action: "moved", payload: { prevPosition: current.position, position } });
    return { position, updates, workspaceId: current.workspaceId, prevPosition: current.position, rebalanced: hasTies || gap.needsRebalance };
  });
  // Each sibling has a distinct audience and workspace. Publish normalised positions first,
  // through the existing durable visibility filter, so guests only learn accessible board order.
  if (result.rebalanced) {
    for (const update of result.updates) {
      await emitBoardRebalancedToVisibleUsers(update.workspaceId, {
        workspaceId: update.workspaceId, positions: [{ id: update.id, position: update.position }],
      });
    }
  }
  await emitToBoardAudience(id, "board:moved", {
    workspaceId: result.workspaceId, boardId: id,
    position: result.position, prevPosition: result.prevPosition,
  }, { workspaceId: result.workspaceId });
  return { id, position: result.position, positions: result.updates.map(({ id, position }) => ({ id, position })) };
}
