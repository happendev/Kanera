import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  ACTIVITY_ENTITY_TYPE,
  boardMembers,
  boards,
  cardAssignees,
  cardSummaryView,
  globalWorkSeparators,
  lists,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Db } from "../../db.js";
import { assertWorkspaceAccess, isOrgAdmin } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { activeCompletedCardPredicate } from "../../lib/completed-card-visibility.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { between } from "../../lib/position.js";
import { emitToGlobalWorkSeparatorAudience } from "../../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type GlobalWorkLaneItemType = "card" | "separator";
type GlobalWorkLaneAnchor = { type: GlobalWorkLaneItemType; id: string };
type GlobalWorkLaneItem = { type: GlobalWorkLaneItemType; id: string; position: string };

async function accessibleGlobalWorkBoardIds(auth: AuthClaims, workspaceId: string, tx: Tx = db): Promise<string[]> {
  // A Global Work lane can merge cards from every board the viewer can see in this workspace. The
  // position helper must use that same access boundary or an invisible card could become an anchor.
  const orgAdmin = isOrgAdmin(auth);
  const boardRows = await tx
    .select({
      id: boards.id,
      explicitMemberId: boardMembers.userId,
    })
    .from(boards)
    .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, auth.sub)))
    .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)));

  return boardRows.filter((board) => orgAdmin || board.explicitMemberId).map((board) => board.id);
}

export async function assertGlobalWorkSeparatorContext(options: {
  auth: AuthClaims;
  workspaceId: string;
  targetUserId: string;
  listId?: string;
}) {
  // These separators organise one person's cross-board lane. Aggregate team and portfolio queries
  // deliberately have no target id and therefore cannot reach this route.
  const ctx = await assertWorkspaceAccess(options.auth, options.workspaceId, "member");
  if (options.targetUserId !== options.auth.sub && ctx.role !== "admin") throw forbidden();
  const [targetMembership] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, options.workspaceId), eq(workspaceMembers.userId, options.targetUserId)))
    .limit(1);
  if (!targetMembership) throw notFound("target user not found");

  if (options.listId) {
    const [list] = await db.select().from(lists).where(eq(lists.id, options.listId)).limit(1);
    if (!list || list.workspaceId !== options.workspaceId) throw badRequest("target list not in workspace");
  }

  return ctx;
}

async function loadGlobalWorkLaneItems(options: {
  auth: AuthClaims;
  workspaceId: string;
  targetUserId: string;
  listId: string;
  moving?: GlobalWorkLaneAnchor;
  tx: Tx;
}): Promise<GlobalWorkLaneItem[]> {
  const [workspace] = await options.tx
    .select({ completedCardsActiveDays: workspaces.completedCardsActiveDays })
    .from(workspaces)
    .where(eq(workspaces.id, options.workspaceId))
    .limit(1);
  if (!workspace) throw notFound("workspace not found");

  const boardIds = await accessibleGlobalWorkBoardIds(options.auth, options.workspaceId, options.tx);
  const [cardRows, separatorRows] = await Promise.all([
    boardIds.length === 0
      ? []
      : options.tx
          .select({ id: cardSummaryView.id, position: cardSummaryView.position })
          .from(cardSummaryView)
          .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardSummaryView.id))
          .where(
            and(
              eq(cardAssignees.userId, options.targetUserId),
              eq(cardSummaryView.listId, options.listId),
              inArray(cardSummaryView.boardId, boardIds),
              isNull(cardSummaryView.archivedAt),
              activeCompletedCardPredicate(workspace.completedCardsActiveDays),
            ),
          )
          .orderBy(asc(cardSummaryView.position), asc(cardSummaryView.id)),
    options.tx
      .select({ id: globalWorkSeparators.id, position: globalWorkSeparators.position })
      .from(globalWorkSeparators)
      .where(
        and(
          eq(globalWorkSeparators.workspaceId, options.workspaceId),
          eq(globalWorkSeparators.targetUserId, options.targetUserId),
          eq(globalWorkSeparators.listId, options.listId),
        ),
      )
      .orderBy(asc(globalWorkSeparators.position), asc(globalWorkSeparators.id)),
  ]);

  return [
    ...cardRows.map((row): GlobalWorkLaneItem => ({ type: "card", ...row })),
    ...separatorRows.map((row): GlobalWorkLaneItem => ({ type: "separator", ...row })),
  ]
    .filter((item) => item.type !== options.moving?.type || item.id !== options.moving.id)
    .sort((a, b) => Number(a.position) - Number(b.position) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

export async function positionForGlobalWorkLaneInsert(options: {
  auth: AuthClaims;
  workspaceId: string;
  targetUserId: string;
  listId: string;
  moving?: GlobalWorkLaneAnchor;
  afterItem?: GlobalWorkLaneAnchor | null;
  beforeItem?: GlobalWorkLaneAnchor | null;
  tx: Tx;
}) {
  const items = await loadGlobalWorkLaneItems(options);
  const findAnchor = (anchor: GlobalWorkLaneAnchor) => {
    const item = items.find((candidate) => candidate.type === anchor.type && candidate.id === anchor.id);
    if (!item) throw badRequest(`${anchor.type} anchor not found`);
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

  // Global Work combines board-owned card positions with personal separators. Rebalancing from this
  // virtual lane would unexpectedly rewrite source boards, so interpolation intentionally remains
  // sparse and leaves the rare precision-exhaustion case visible to the caller.
  return between(prev, next).position;
}

export async function globalWorkSeparatorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/work/workspaces/:workspaceId/users/:userId/lists/:listId/separators", async (req, reply) => {
    const { workspaceId, userId: targetUserId, listId } = req.params as { workspaceId: string; userId: string; listId: string };
    const body = dto.createSeparatorBody.parse(req.body);
    await assertGlobalWorkSeparatorContext({ auth: req.auth, workspaceId, targetUserId, listId });

    const separator = await db.transaction(async (tx) => {
      const position = await positionForGlobalWorkLaneInsert({
        auth: req.auth,
        workspaceId,
        targetUserId,
        listId,
        ...(body.atTop ? { afterItem: null } : { beforeItem: null }),
        tx,
      });
      const [created] = await tx
        .insert(globalWorkSeparators)
        .values({
          workspaceId,
          targetUserId,
          listId,
          title: body.title ?? "",
          color: body.color ?? null,
          position,
          createdById: req.auth.sub,
        })
        .returning();
      if (!created) throw notFound();
      await recordActivity(tx, {
        boardId: null,
        workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: created.id,
        action: ACTIVITY_ACTION.CREATED,
        payload: { title: created.title, color: created.color, listId, targetUserId, scope: "globalWork" },
      });
      return created;
    });

    await emitToGlobalWorkSeparatorAudience(workspaceId, targetUserId, SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_CREATED, {
      workspaceId,
      targetUserId,
      separator,
    });
    return reply.status(201).send(separator);
  });

  app.patch("/global-work-separators/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateSeparatorBody.parse(req.body);
    const [current] = await db.select().from(globalWorkSeparators).where(eq(globalWorkSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    await assertGlobalWorkSeparatorContext({
      auth: req.auth,
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
    });

    const [separator] = await db
      .update(globalWorkSeparators)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        updatedAt: new Date(),
      })
      .where(eq(globalWorkSeparators.id, id))
      .returning();
    if (!separator) throw notFound();
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
      entityId: id,
      action: ACTIVITY_ACTION.UPDATED,
      payload: { title: separator.title, color: separator.color, targetUserId: current.targetUserId, scope: "globalWork" },
    });
    await emitToGlobalWorkSeparatorAudience(current.workspaceId, current.targetUserId, SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_UPDATED, {
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
      separator,
    });
    return separator;
  });

  app.post("/global-work-separators/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveSeparatorBody.parse(req.body);
    const [current] = await db.select().from(globalWorkSeparators).where(eq(globalWorkSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    await assertGlobalWorkSeparatorContext({
      auth: req.auth,
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
      listId: body.listId,
    });

    const fromListId = current.listId;
    const prevPosition = current.position;
    const { position, noOp } = await db.transaction(async (tx) => {
      const nextPosition = await positionForGlobalWorkLaneInsert({
        auth: req.auth,
        workspaceId: current.workspaceId,
        targetUserId: current.targetUserId,
        listId: body.listId,
        moving: { type: "separator", id },
        afterItem: body.afterItem,
        beforeItem: body.beforeItem,
        tx,
      });
      if (body.listId === fromListId && nextPosition === prevPosition) {
        return { position: prevPosition, noOp: true };
      }
      await tx
        .update(globalWorkSeparators)
        .set({ listId: body.listId, position: nextPosition, updatedAt: new Date() })
        .where(eq(globalWorkSeparators.id, id));
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: id,
        action: ACTIVITY_ACTION.MOVED,
        payload: { fromListId, toListId: body.listId, prevPosition, position: nextPosition, targetUserId: current.targetUserId, scope: "globalWork" },
      });
      return { position: nextPosition, noOp: false };
    });

    if (noOp) return { id, listId: fromListId, position };
    await emitToGlobalWorkSeparatorAudience(current.workspaceId, current.targetUserId, SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_MOVED, {
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
      separatorId: id,
      fromListId,
      toListId: body.listId,
      position,
      prevPosition,
    });
    return { id, listId: body.listId, position };
  });

  app.delete("/global-work-separators/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(globalWorkSeparators).where(eq(globalWorkSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    await assertGlobalWorkSeparatorContext({
      auth: req.auth,
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
    });

    await db.transaction(async (tx) => {
      await tx.delete(globalWorkSeparators).where(eq(globalWorkSeparators.id, id));
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: id,
        action: ACTIVITY_ACTION.DELETED,
        payload: { title: current.title, color: current.color, listId: current.listId, targetUserId: current.targetUserId, scope: "globalWork" },
      });
    });
    await emitToGlobalWorkSeparatorAudience(current.workspaceId, current.targetUserId, SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_DELETED, {
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
      separatorId: id,
    });
    return reply.status(204).send();
  });
}
