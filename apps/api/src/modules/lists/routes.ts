import { dto } from "@kanera/shared";
import type { DeletionImpactResponse } from "@kanera/shared/dto";
import { cards, lists } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess, assertWorkspaceAccess } from "../../lib/access.js";
import { emitActivityFeedItem, recordActivity, recordCoalescedActivity } from "../../lib/activity.js";
import { deleteAttachmentFiles } from "../../lib/attachment-cleanup.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { clearNotificationsForCards, emitDeletedNotifications } from "../../lib/notifications.js";
import { between } from "../../lib/position.js";
import { rebalanceLists } from "../../lib/rebalance.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { emitToBoard, emitToWorkspace } from "../../realtime/emit.js";

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full list scan.
async function neighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db
      .select({ position: lists.position })
      .from(lists)
      .where(and(eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
      .orderBy(asc(lists.position))
      .limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db
      .select({ position: lists.position })
      .from(lists)
      .where(and(eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
      .orderBy(desc(lists.position))
      .limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db
      .select({ position: lists.position })
      .from(lists)
      .where(and(eq(lists.id, afterId), eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
      .limit(1);
    if (!after) throw badRequest("afterListId not found");
    const [nextList] = await db
      .select({ position: lists.position })
      .from(lists)
      .where(and(eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt), gt(lists.position, after.position)))
      .orderBy(asc(lists.position))
      .limit(1);
    prev = after.position;
    next = nextList?.position ?? null;
  } else if (beforeId) {
    const [before] = await db
      .select({ position: lists.position })
      .from(lists)
      .where(and(eq(lists.id, beforeId), eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
      .limit(1);
    if (!before) throw badRequest("beforeListId not found");
    const [prevList] = await db
      .select({ position: lists.position })
      .from(lists)
      .where(and(eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt), lt(lists.position, before.position)))
      .orderBy(desc(lists.position))
      .limit(1);
    next = before.position;
    prev = prevList?.position ?? null;
  }
  return { prev, next };
}

function listUpdateActivityValue(name: string, icon: string | null, color: string | null) {
  return { name, icon, color };
}

export async function listRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/workspaces/:wsId/lists", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    const body = dto.createListBody.parse(req.body);
    await assertWorkspaceAccess(req.auth, workspaceId, "editor");

    const [last] = await db
      .select({ position: lists.position })
      .from(lists)
      .where(eq(lists.workspaceId, workspaceId))
      .orderBy(desc(lists.position))
      .limit(1);
    const { position } = between(last?.position ?? null, null);

    const [list] = await db.insert(lists).values({
      workspaceId,
      name: body.name,
      icon: body.icon ?? null,
      color: body.color ?? null,
      position,
    }).returning();

    await recordActivity(db, {
      boardId: null,
      workspaceId,
      actorId: req.auth.sub,
      entityType: "list",
      entityId: list!.id,
      action: "created",
      payload: { name: list!.name },
    });
    emitToWorkspace(workspaceId, "list:created", { workspaceId, list: list! });
    return reply.status(201).send(list);
  });

  app.patch("/lists/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateListBody.parse(req.body);
    const [current] = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "editor");
    const [list] = await db
      .update(lists)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.color !== undefined && { color: body.color }),
        updatedAt: new Date(),
      })
      .where(eq(lists.id, id))
      .returning();

    const fromValue = listUpdateActivityValue(current.name, current.icon, current.color);
    const toValue = listUpdateActivityValue(
      body.name ?? current.name,
      body.icon !== undefined ? body.icon : current.icon,
      body.color !== undefined ? body.color : current.color,
    );
    // List titles and appearance are easy to tweak repeatedly while setting up
    // a workspace, so keep one visible feed story per edit burst.
    await recordCoalescedActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "list",
      entityId: id,
      action: "updated",
      coalesceKey: "list:update",
      windowMs: 120_000,
      fromValue,
      toValue,
      payload: body,
    });
    emitToWorkspace(current.workspaceId, "list:updated", { workspaceId: current.workspaceId, list: list! });
    return list!;
  });

  app.get("/lists/:id/deletion-impact", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select({ workspaceId: lists.workspaceId }).from(lists).where(eq(lists.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");

    const [impact] = await db
      .select({ cardCount: sql<number>`count(*)::int` })
      .from(cards)
      .where(eq(cards.listId, id));
    return { cardCount: impact?.cardCount ?? 0 } satisfies DeletionImpactResponse;
  });

  app.delete("/lists/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const listCards = await db.select({ id: cards.id }).from(cards).where(eq(cards.listId, id));
    const storage = await getStorageForClient(req.auth.cid);
    await deleteAttachmentFiles(storage, listCards.map((c) => c.id));

    await db.delete(lists).where(eq(lists.id, id));
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "list",
      entityId: id,
      action: "deleted",
      payload: { name: current.name },
    });
    emitToWorkspace(current.workspaceId, "list:deleted", { workspaceId: current.workspaceId, listId: id });
    return reply.status(204).send();
  });

  app.post("/lists/:id/cards/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveListCardsBody.parse(req.body);
    const [source] = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
    if (!source) throw notFound();
    if (body.boardId) {
      const access = await assertBoardAccess(req.auth, body.boardId, "editor");
      if (access.workspaceId !== source.workspaceId) throw badRequest("board not in same workspace");
    } else {
      await assertWorkspaceAccess(req.auth, source.workspaceId, "editor");
    }

    if (body.targetListId === id) throw badRequest("targetListId must differ from source list");

    const [target] = await db.select().from(lists).where(eq(lists.id, body.targetListId)).limit(1);
    if (!target || target.workspaceId !== source.workspaceId) throw badRequest("target list not in same workspace");

    const sourceCards = await db
      .select({ id: cards.id, boardId: cards.boardId, position: cards.position, completedAt: cards.completedAt })
      .from(cards)
      // Board guests may bulk-move cards on their board, but must not mutate cards on other boards
      // that happen to share this workspace-scoped list.
      .where(and(eq(cards.listId, id), isNull(cards.archivedAt), body.boardId ? eq(cards.boardId, body.boardId) : undefined))
      .orderBy(asc(cards.position));

    if (sourceCards.length === 0) return { moved: 0 };

    const [firstInTarget] = await db
      .select({ position: cards.position })
      .from(cards)
      .where(and(eq(cards.listId, body.targetListId), isNull(cards.archivedAt)))
      .orderBy(asc(cards.position))
      .limit(1);

    const moves: { id: string; boardId: string; prevPosition: string; position: string; completedAt: Date | null }[] = [];
    let nextPos: string | null = firstInTarget?.position ?? null;
    // Card positions are shared by the whole workspace list. Thread a single
    // insertion cursor so merging lists preserves cross-board priority instead
    // of minting overlapping per-board positions.
    for (const card of [...sourceCards].reverse()) {
      const { position } = between(null, nextPos);
      moves.push({ id: card.id, boardId: card.boardId, prevPosition: card.position, position, completedAt: card.completedAt });
      nextPos = position;
    }

    await db.transaction(async (tx) => {
      for (const m of moves) {
        await tx.update(cards)
          .set({
            listId: body.targetListId,
            position: m.position,
            updatedAt: new Date(),
          })
          .where(eq(cards.id, m.id));
      }
    });

    await recordActivity(db, {
      boardId: body.boardId ?? null,
      workspaceId: source.workspaceId,
      actorId: req.auth.sub,
      entityType: "list",
      entityId: id,
      action: "updated",
      payload: { cardsMoved: moves.length, toListId: body.targetListId },
    });

    const byBoard = new Map<string, typeof moves>();
    for (const m of moves) {
      const arr = byBoard.get(m.boardId) ?? [];
      arr.push(m);
      byBoard.set(m.boardId, arr);
    }
    for (const [boardId, boardMoves] of byBoard) {
      for (const m of boardMoves) {
        emitToBoard(boardId, "card:moved", {
          boardId,
          cardId: m.id,
          fromListId: id,
          toListId: body.targetListId,
          position: m.position,
          prevPosition: m.prevPosition,
        });
      }
    }
    return { moved: moves.length };
  });

  app.patch("/lists/:id/cards/archive", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.archiveListCardsBody.parse(req.body ?? {});
    const [current] = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
    if (!current) throw notFound();
    if (body.boardId) {
      const access = await assertBoardAccess(req.auth, body.boardId, "editor");
      if (access.workspaceId !== current.workspaceId) throw badRequest("board not in same workspace");
    } else {
      await assertWorkspaceAccess(req.auth, current.workspaceId, "editor");
    }

    const listCards = await db
      .select({ id: cards.id, boardId: cards.boardId, title: cards.title })
      .from(cards)
      // A board-scoped list action must not archive cards belonging to sibling boards that share
      // the workspace list. Omitting boardId preserves the public API's workspace-wide behavior.
      .where(and(eq(cards.listId, id), isNull(cards.archivedAt), body.boardId ? eq(cards.boardId, body.boardId) : undefined));

    if (listCards.length === 0) return { archived: 0 };

    const archivedAt = new Date();
    const { updatedCards, deletedNotifications } = await db.transaction(async (tx) => {
      const updated = await tx
        .update(cards)
        .set({ archivedAt, updatedAt: archivedAt })
        .where(and(eq(cards.listId, id), isNull(cards.archivedAt), body.boardId ? eq(cards.boardId, body.boardId) : undefined))
        .returning();

      await recordActivity(tx, {
        boardId: body.boardId ?? null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: "list",
        entityId: id,
        action: "updated",
        payload: { cardsArchived: listCards.length },
      });
      const deletedNotifications = await clearNotificationsForCards(tx, updated.map((card) => card.id));
      return { updatedCards: updated, deletedNotifications };
    });
    emitDeletedNotifications(deletedNotifications);

    const byBoard = new Map<string, typeof updatedCards>();
    for (const c of updatedCards) {
      const arr = byBoard.get(c.boardId) ?? [];
      arr.push(c);
      byBoard.set(c.boardId, arr);
    }
    for (const [boardId, boardCards] of byBoard) {
      for (const card of boardCards) {
        emitToBoard(boardId, "card:updated", { boardId, card });
      }
    }

    return { archived: listCards.length };
  });

  app.post("/lists/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveListBody.parse(req.body);
    const [current] = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "editor");

    const { prev, next } = await neighbourPositions(current.workspaceId, body.afterListId, body.beforeListId);
    const result = between(prev, next);
    let position = result.position;
    const prevPosition = current.position;
    await db.update(lists).set({ position, updatedAt: new Date() }).where(eq(lists.id, id));

    if (result.needsRebalance) {
      const positions = await rebalanceLists(current.workspaceId);
      position = positions.find((p) => p.id === id)?.position ?? position;
      await emitToWorkspace(current.workspaceId, "list:rebalanced", { workspaceId: current.workspaceId, positions });
    }

    // Dragging a list can generate several positions before the user settles on
    // the final order; the activity feed should show the final move, not every hop.
    await recordCoalescedActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "list",
      entityId: id,
      action: "moved",
      coalesceKey: "list:position",
      preservePayloadKeys: ["prevPosition"],
      windowMs: 60_000,
      fromValue: prevPosition,
      toValue: position,
      payload: { prevPosition, position },
    });
    emitToWorkspace(current.workspaceId, "list:moved", {
      workspaceId: current.workspaceId,
      listId: id,
      position,
      prevPosition,
    });
    return { id, position };
  });
}
