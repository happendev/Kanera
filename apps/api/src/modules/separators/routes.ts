import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, ACTIVITY_ENTITY_TYPE, boardSeparators, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { emitLaneRebalanced, positionForLaneInsert, rebalanceBoardLane, toWireSeparator } from "../../lib/board-lane.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { emitToBoard } from "../../realtime/emit.js";

export async function separatorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/boards/:boardId/lists/:listId/separators", async (req, reply) => {
    const { boardId, listId } = req.params as { boardId: string; listId: string };
    const body = dto.createSeparatorBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const [list] = await db.select().from(lists).where(eq(lists.id, listId)).limit(1);
    if (!list || list.workspaceId !== ctx.workspaceId) throw badRequest("target list not in board workspace");

    const { separator, rebalanced } = await db.transaction(async (tx) => {
      const result = await positionForLaneInsert({
        listId,
        boardId,
        ...(body.atTop ? { afterItem: null } : { beforeItem: null }),
        tx,
      });
      const [separator] = await tx
        .insert(boardSeparators)
        .values({
          boardId,
          listId,
          title: body.title ?? "",
          color: body.color ?? null,
          position: result.position,
          createdById: req.auth.sub,
        })
        .returning();
      if (!separator) throw notFound();
      const rebalanced = result.needsRebalance ? await rebalanceBoardLane(listId, boardId, tx) : null;
      const finalPosition = rebalanced?.separatorPositions.find((p) => p.id === separator.id)?.position ?? separator.position;
      await recordActivity(tx, {
        boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: separator.id,
        action: ACTIVITY_ACTION.CREATED,
        payload: { title: separator.title, color: separator.color, listId },
      });
      return { separator: { ...separator, position: finalPosition }, rebalanced };
    });

    if (rebalanced) await emitLaneRebalanced(boardId, listId, rebalanced);
    await emitToBoard(boardId, SERVER_EVENTS.SEPARATOR_CREATED, { boardId, separator: toWireSeparator(separator) });
    return reply.status(201).send(toWireSeparator(separator));
  });

  app.patch("/separators/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateSeparatorBody.parse(req.body);
    const [current] = await db.select().from(boardSeparators).where(eq(boardSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertBoardAccess(req.auth, current.boardId, "editor");

    const [separator] = await db
      .update(boardSeparators)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        updatedAt: new Date(),
      })
      .where(eq(boardSeparators.id, id))
      .returning();
    if (!separator) throw notFound();

    await recordActivity(db, {
      boardId: current.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
      entityId: id,
      action: ACTIVITY_ACTION.UPDATED,
      payload: { title: separator.title, color: separator.color },
    });
    await emitToBoard(current.boardId, SERVER_EVENTS.SEPARATOR_UPDATED, { boardId: current.boardId, separator: toWireSeparator(separator) });
    return toWireSeparator(separator);
  });

  app.post("/separators/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveSeparatorBody.parse(req.body);
    const [current] = await db.select().from(boardSeparators).where(eq(boardSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertBoardAccess(req.auth, current.boardId, "editor");
    const [targetList] = await db.select().from(lists).where(eq(lists.id, body.listId)).limit(1);
    if (!targetList || targetList.workspaceId !== ctx.workspaceId) throw badRequest("target list not in same workspace");

    const fromListId = current.listId;
    const prevPosition = current.position;
    const { finalPosition, rebalanced } = await db.transaction(async (tx) => {
      const result = await positionForLaneInsert({
        listId: body.listId,
        boardId: current.boardId,
        moving: { type: "separator", id },
        afterItem: body.afterItem,
        beforeItem: body.beforeItem,
        tx,
      });
      await tx
        .update(boardSeparators)
        .set({ listId: body.listId, position: result.position, updatedAt: new Date() })
        .where(eq(boardSeparators.id, id));
      const rebalanced = result.needsRebalance ? await rebalanceBoardLane(body.listId, current.boardId, tx) : null;
      const finalPosition = rebalanced?.separatorPositions.find((p) => p.id === id)?.position ?? result.position;
      await recordActivity(tx, {
        boardId: current.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: id,
        action: ACTIVITY_ACTION.MOVED,
        payload: { fromListId, toListId: body.listId, prevPosition, position: finalPosition },
      });
      return { finalPosition, rebalanced };
    });

    if (rebalanced) await emitLaneRebalanced(current.boardId, body.listId, rebalanced);
    await emitToBoard(current.boardId, SERVER_EVENTS.SEPARATOR_MOVED, {
      boardId: current.boardId,
      separatorId: id,
      fromListId,
      toListId: body.listId,
      position: finalPosition,
      prevPosition,
    });
    return { id, listId: body.listId, position: finalPosition };
  });

  app.delete("/separators/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(boardSeparators).where(eq(boardSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertBoardAccess(req.auth, current.boardId, "editor");
    await db.transaction(async (tx) => {
      await tx.delete(boardSeparators).where(eq(boardSeparators.id, id));
      await recordActivity(tx, {
        boardId: current.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: id,
        action: ACTIVITY_ACTION.DELETED,
        payload: { title: current.title, color: current.color, listId: current.listId },
      });
    });
    await emitToBoard(current.boardId, SERVER_EVENTS.SEPARATOR_DELETED, { boardId: current.boardId, separatorId: id });
    return reply.status(204).send();
  });
}
