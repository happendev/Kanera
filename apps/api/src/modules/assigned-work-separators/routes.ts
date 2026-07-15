import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  ACTIVITY_ENTITY_TYPE,
  assignedWorkSeparators,
  boardMembers,
  boards,
  cardAssignees,
  cardSummaryView,
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
import { emitToAssignedWorkSeparatorAudience } from "../../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type AssignedLaneItemType = "card" | "separator";
type AssignedLaneAnchor = { type: AssignedLaneItemType; id: string };
type AssignedLaneItem = { type: AssignedLaneItemType; id: string; position: string };

function toWireAssignedWorkSeparator(separator: typeof assignedWorkSeparators.$inferSelect) {
  return separator;
}

async function accessibleAssignedWorkBoardIds(auth: AuthClaims, workspaceId: string, tx: Tx = db): Promise<string[]> {
  // Mirror accessibleAssignedWorkBoards: board membership is the access model, so restrict to
  // boards the viewer explicitly belongs to, plus every board for org admins.
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

export async function assertAssignedWorkSeparatorContext(options: {
  auth: AuthClaims;
  workspaceId: string;
  targetUserId: string;
  listId?: string;
}) {
  if (options.targetUserId === "all") throw badRequest("aggregate assigned-work view does not support separators");
  // Assigned-work separators are per-user view organization, not a shared workspace setting, so any
  // workspace member may manage their own; only admins may manage another user's view.
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

async function loadAssignedLaneItems(options: {
  auth: AuthClaims;
  workspaceId: string;
  targetUserId: string;
  listId: string;
  moving?: AssignedLaneAnchor;
  tx: Tx;
}): Promise<AssignedLaneItem[]> {
  const [workspace] = await options.tx
    .select({ completedCardsActiveDays: workspaces.completedCardsActiveDays })
    .from(workspaces)
    .where(eq(workspaces.id, options.workspaceId))
    .limit(1);
  if (!workspace) throw notFound("workspace not found");

  const boardIds = await accessibleAssignedWorkBoardIds(options.auth, options.workspaceId, options.tx);
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
      .select({ id: assignedWorkSeparators.id, position: assignedWorkSeparators.position })
      .from(assignedWorkSeparators)
      .where(
        and(
          eq(assignedWorkSeparators.workspaceId, options.workspaceId),
          eq(assignedWorkSeparators.targetUserId, options.targetUserId),
          eq(assignedWorkSeparators.listId, options.listId),
        ),
      )
      .orderBy(asc(assignedWorkSeparators.position), asc(assignedWorkSeparators.id)),
  ]);

  return [
    ...cardRows.map((row): AssignedLaneItem => ({ type: "card", ...row })),
    ...separatorRows.map((row): AssignedLaneItem => ({ type: "separator", ...row })),
  ]
    .filter((item) => item.type !== options.moving?.type || item.id !== options.moving.id)
    .sort((a, b) => Number(a.position) - Number(b.position) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

export async function positionForAssignedLaneInsert(options: {
  auth: AuthClaims;
  workspaceId: string;
  targetUserId: string;
  listId: string;
  moving?: AssignedLaneAnchor;
  afterItem?: AssignedLaneAnchor | null;
  beforeItem?: AssignedLaneAnchor | null;
  tx: Tx;
}) {
  const items = await loadAssignedLaneItems(options);
  const findAnchor = (anchor: AssignedLaneAnchor) => {
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

  // Assigned Work mixes real board-card positions with personal separator positions. Rebalancing
  // the whole lane from here would mutate board cards from a user-scoped virtual view, while
  // renumbering only separators would not widen a collapsed card/card gap. For now we keep the
  // same sparse-position behavior as normal moves and accept the rare precision-exhaustion case
  // as a validation/retry problem rather than hiding cross-scope writes in this route.
  return between(prev, next).position;
}

export async function assignedWorkSeparatorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/workspaces/:workspaceId/assignees/:userId/lists/:listId/separators", async (req, reply) => {
    const { workspaceId, userId: targetUserId, listId } = req.params as { workspaceId: string; userId: string; listId: string };
    const body = dto.createSeparatorBody.parse(req.body);
    await assertAssignedWorkSeparatorContext({ auth: req.auth, workspaceId, targetUserId, listId });

    const separator = await db.transaction(async (tx) => {
      const position = await positionForAssignedLaneInsert({
        auth: req.auth,
        workspaceId,
        targetUserId,
        listId,
        ...(body.atTop ? { afterItem: null } : { beforeItem: null }),
        tx,
      });
      const [created] = await tx
        .insert(assignedWorkSeparators)
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
        payload: { title: created.title, color: created.color, listId, targetUserId, scope: "assignedWork" },
      });
      return created;
    });

    await emitToAssignedWorkSeparatorAudience(workspaceId, targetUserId, SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_CREATED, {
      workspaceId,
      targetUserId,
      separator: toWireAssignedWorkSeparator(separator),
    });
    return reply.status(201).send(toWireAssignedWorkSeparator(separator));
  });

  app.patch("/assigned-work-separators/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateSeparatorBody.parse(req.body);
    const [current] = await db.select().from(assignedWorkSeparators).where(eq(assignedWorkSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    await assertAssignedWorkSeparatorContext({
      auth: req.auth,
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
    });

    const [separator] = await db
      .update(assignedWorkSeparators)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        updatedAt: new Date(),
      })
      .where(eq(assignedWorkSeparators.id, id))
      .returning();
    if (!separator) throw notFound();

    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
      entityId: id,
      action: ACTIVITY_ACTION.UPDATED,
      payload: { title: separator.title, color: separator.color, targetUserId: current.targetUserId, scope: "assignedWork" },
    });
    await emitToAssignedWorkSeparatorAudience(current.workspaceId, current.targetUserId, SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_UPDATED, {
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
      separator: toWireAssignedWorkSeparator(separator),
    });
    return toWireAssignedWorkSeparator(separator);
  });

  app.post("/assigned-work-separators/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveSeparatorBody.parse(req.body);
    const [current] = await db.select().from(assignedWorkSeparators).where(eq(assignedWorkSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    await assertAssignedWorkSeparatorContext({
      auth: req.auth,
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
      listId: body.listId,
    });

    const fromListId = current.listId;
    const prevPosition = current.position;
    const { position, noOp } = await db.transaction(async (tx) => {
      const nextPosition = await positionForAssignedLaneInsert({
        auth: req.auth,
        workspaceId: current.workspaceId,
        targetUserId: current.targetUserId,
        listId: body.listId,
        moving: { type: "separator", id },
        afterItem: body.afterItem,
        beforeItem: body.beforeItem,
        tx,
      });
      // An exact location match is idempotent: do not touch timestamps, audit history, or outbox.
      if (body.listId === fromListId && nextPosition === prevPosition) {
        return { position: prevPosition, noOp: true };
      }
      await tx
        .update(assignedWorkSeparators)
        .set({ listId: body.listId, position: nextPosition, updatedAt: new Date() })
        .where(eq(assignedWorkSeparators.id, id));
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: id,
        action: ACTIVITY_ACTION.MOVED,
        payload: { fromListId, toListId: body.listId, prevPosition, position: nextPosition, targetUserId: current.targetUserId, scope: "assignedWork" },
      });
      return { position: nextPosition, noOp: false };
    });

    if (noOp) return { id, listId: fromListId, position };
    await emitToAssignedWorkSeparatorAudience(current.workspaceId, current.targetUserId, SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_MOVED, {
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

  app.delete("/assigned-work-separators/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(assignedWorkSeparators).where(eq(assignedWorkSeparators.id, id)).limit(1);
    if (!current) throw notFound();
    await assertAssignedWorkSeparatorContext({
      auth: req.auth,
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
    });

    await db.transaction(async (tx) => {
      await tx.delete(assignedWorkSeparators).where(eq(assignedWorkSeparators.id, id));
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: ACTIVITY_ENTITY_TYPE.SEPARATOR,
        entityId: id,
        action: ACTIVITY_ACTION.DELETED,
        payload: { title: current.title, color: current.color, listId: current.listId, targetUserId: current.targetUserId, scope: "assignedWork" },
      });
    });
    await emitToAssignedWorkSeparatorAudience(current.workspaceId, current.targetUserId, SERVER_EVENTS.ASSIGNED_WORK_SEPARATOR_DELETED, {
      workspaceId: current.workspaceId,
      targetUserId: current.targetUserId,
      separatorId: id,
    });
    return reply.status(204).send();
  });
}
