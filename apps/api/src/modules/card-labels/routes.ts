import { dto } from "@kanera/shared";
import { cardLabels } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { between } from "../../lib/position.js";
import { rebalanceCardLabels } from "../../lib/rebalance.js";
import { emitToWorkspace } from "../../realtime/emit.js";

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full label scan.
async function neighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db.select({ position: cardLabels.position }).from(cardLabels).where(and(eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt))).orderBy(asc(cardLabels.position)).limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db.select({ position: cardLabels.position }).from(cardLabels).where(and(eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt))).orderBy(desc(cardLabels.position)).limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db.select({ position: cardLabels.position }).from(cardLabels).where(and(eq(cardLabels.id, afterId), eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt))).limit(1);
    if (!after) throw badRequest("afterLabelId not found");
    const [nextLabel] = await db.select({ position: cardLabels.position }).from(cardLabels).where(and(eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt), gt(cardLabels.position, after.position))).orderBy(asc(cardLabels.position)).limit(1);
    prev = after.position;
    next = nextLabel?.position ?? null;
  } else if (beforeId) {
    const [before] = await db.select({ position: cardLabels.position }).from(cardLabels).where(and(eq(cardLabels.id, beforeId), eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt))).limit(1);
    if (!before) throw badRequest("beforeLabelId not found");
    const [prevLabel] = await db.select({ position: cardLabels.position }).from(cardLabels).where(and(eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt), lt(cardLabels.position, before.position))).orderBy(desc(cardLabels.position)).limit(1);
    next = before.position;
    prev = prevLabel?.position ?? null;
  }
  return { prev, next };
}

export async function cardLabelRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/workspaces/:wsId/card-labels", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.createCardLabelBody.parse(req.body);

    const [last] = await db
      .select({ position: cardLabels.position })
      .from(cardLabels)
      .where(eq(cardLabels.workspaceId, workspaceId))
      .orderBy(desc(cardLabels.position))
      .limit(1);
    const { position } = between(last?.position ?? null, null);

    const [label] = await db
      .insert(cardLabels)
      .values({ workspaceId, name: body.name, color: body.color ?? null, position })
      .returning();

    await recordActivity(db, {
      boardId: null,
      workspaceId,
      actorId: req.auth.sub,
      entityType: "cardLabel",
      entityId: label!.id,
      action: "created",
      payload: { name: label!.name },
    });
    emitToWorkspace(workspaceId, "cardLabel:created", { workspaceId, cardLabel: label! });
    return reply.status(201).send(label);
  });

  app.patch("/card-labels/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateCardLabelBody.parse(req.body);
    const [current] = await db.select().from(cardLabels).where(eq(cardLabels.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");

    const [label] = await db
      .update(cardLabels)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.color !== undefined && { color: body.color }),
        updatedAt: new Date(),
      })
      .where(eq(cardLabels.id, id))
      .returning();

    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "cardLabel",
      entityId: id,
      action: "updated",
      payload: body,
    });
    emitToWorkspace(current.workspaceId, "cardLabel:updated", { workspaceId: current.workspaceId, cardLabel: label! });
    return label!;
  });

  app.delete("/card-labels/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(cardLabels).where(eq(cardLabels.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    await db.delete(cardLabels).where(eq(cardLabels.id, id));
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "cardLabel",
      entityId: id,
      action: "deleted",
      payload: { name: current.name },
    });
    emitToWorkspace(current.workspaceId, "cardLabel:deleted", { workspaceId: current.workspaceId, labelId: id });
    return reply.status(204).send();
  });

  app.post("/card-labels/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardLabelBody.parse(req.body);
    const [current] = await db.select().from(cardLabels).where(eq(cardLabels.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");

    const { prev, next } = await neighbourPositions(current.workspaceId, body.afterLabelId, body.beforeLabelId);
    const result = between(prev, next);
    let position = result.position;
    const prevPosition = current.position;
    await db.update(cardLabels).set({ position, updatedAt: new Date() }).where(eq(cardLabels.id, id));

    if (result.needsRebalance) {
      const positions = await rebalanceCardLabels(current.workspaceId);
      position = positions.find((p) => p.id === id)?.position ?? position;
      await emitToWorkspace(current.workspaceId, "cardLabel:rebalanced", { workspaceId: current.workspaceId, positions });
    }

    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "cardLabel",
      entityId: id,
      action: "moved",
      payload: { prevPosition, position },
    });
    emitToWorkspace(current.workspaceId, "cardLabel:moved", {
      workspaceId: current.workspaceId,
      labelId: id,
      position,
      prevPosition,
    });
    return { id, position };
  });
}
