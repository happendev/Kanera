import { dto } from "@kanera/shared";
import {
  automationActions,
  automations,
  checklistTemplateItems,
  checklistTemplates,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, type Db } from "../../db.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { loadAutomation } from "../../lib/automations.js";
import { loadChecklistTemplate } from "../../lib/checklist-templates.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { between, positionAtIndex } from "../../lib/position.js";
import { rebalanceChecklistTemplates } from "../../lib/rebalance.js";
import { emitToWorkspace } from "../../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full template scan.
async function neighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db.select({ position: checklistTemplates.position }).from(checklistTemplates).where(and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt))).orderBy(asc(checklistTemplates.position)).limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db.select({ position: checklistTemplates.position }).from(checklistTemplates).where(and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt))).orderBy(desc(checklistTemplates.position)).limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db.select({ position: checklistTemplates.position }).from(checklistTemplates).where(and(eq(checklistTemplates.id, afterId), eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt))).limit(1);
    if (!after) throw badRequest("afterTemplateId not found");
    const [nextTemplate] = await db.select({ position: checklistTemplates.position }).from(checklistTemplates).where(and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt), gt(checklistTemplates.position, after.position))).orderBy(asc(checklistTemplates.position)).limit(1);
    prev = after.position;
    next = nextTemplate?.position ?? null;
  } else if (beforeId) {
    const [before] = await db.select({ position: checklistTemplates.position }).from(checklistTemplates).where(and(eq(checklistTemplates.id, beforeId), eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt))).limit(1);
    if (!before) throw badRequest("beforeTemplateId not found");
    const [prevTemplate] = await db.select({ position: checklistTemplates.position }).from(checklistTemplates).where(and(eq(checklistTemplates.workspaceId, workspaceId), isNull(checklistTemplates.archivedAt), lt(checklistTemplates.position, before.position))).orderBy(desc(checklistTemplates.position)).limit(1);
    next = before.position;
    prev = prevTemplate?.position ?? null;
  }
  return { prev, next };
}

async function replaceItems(tx: Tx, templateId: string, items: string[]) {
  await tx.delete(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, templateId));
  if (items.length === 0) return;
  await tx.insert(checklistTemplateItems).values(
    items.map((text, index) => ({ templateId, text, position: positionAtIndex(index) })),
  );
}

async function removeTemplateFromAutomationActions(tx: Tx, workspaceId: string, templateId: string): Promise<string[]> {
  const rows = await tx
    .select({
      actionId: automationActions.id,
      automationId: automationActions.automationId,
      config: automationActions.config,
    })
    .from(automationActions)
    .innerJoin(automations, eq(automations.id, automationActions.automationId))
    .where(and(
      eq(automations.workspaceId, workspaceId),
      isNull(automations.archivedAt),
      eq(automationActions.type, "apply_checklists"),
    ));

  const affectedAutomationIds = new Set<string>();
  for (const row of rows) {
    const templateIds = "templateIds" in row.config ? row.config.templateIds : [];
    if (!templateIds.includes(templateId)) continue;
    affectedAutomationIds.add(row.automationId);
    const nextTemplateIds = templateIds.filter((id) => id !== templateId);
    if (nextTemplateIds.length === 0) {
      await tx.delete(automationActions).where(eq(automationActions.id, row.actionId));
    } else {
      await tx
        .update(automationActions)
        .set({ config: { templateIds: nextTemplateIds }, updatedAt: new Date() })
        .where(eq(automationActions.id, row.actionId));
    }
  }

  if (affectedAutomationIds.size > 0) {
    await tx
      .update(automations)
      .set({ updatedAt: new Date() })
      .where(inArray(automations.id, [...affectedAutomationIds]));
  }

  return [...affectedAutomationIds];
}

export async function checklistTemplateRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/workspaces/:wsId/checklist-templates", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.createChecklistTemplateBody.parse(req.body);

    const [last] = await db
      .select({ position: checklistTemplates.position })
      .from(checklistTemplates)
      .where(eq(checklistTemplates.workspaceId, workspaceId))
      .orderBy(desc(checklistTemplates.position))
      .limit(1);
    const { position } = between(last?.position ?? null, null);

    const templateId = await db.transaction(async (tx) => {
      const [template] = await tx
        .insert(checklistTemplates)
        .values({ workspaceId, title: body.title, position })
        .returning();
      await replaceItems(tx, template!.id, body.items);
      await recordActivity(tx, {
        boardId: null,
        workspaceId,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: workspaceId,
        action: "checklistTemplate:created",
        payload: { templateId: template!.id, title: template!.title },
      });
      return template!.id;
    });

    const template = await loadChecklistTemplate(templateId);
    emitToWorkspace(workspaceId, "checklistTemplate:created", { workspaceId, template: template! });
    return reply.status(201).send(template);
  });

  app.patch("/checklist-templates/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateChecklistTemplateBody.parse(req.body);
    const [current] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");

    await db.transaction(async (tx) => {
      await tx
        .update(checklistTemplates)
        .set({
          ...(body.title !== undefined && { title: body.title }),
          updatedAt: new Date(),
        })
        .where(eq(checklistTemplates.id, id));
      if (body.items !== undefined) await replaceItems(tx, id, body.items);
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: current.workspaceId,
        action: "checklistTemplate:updated",
        payload: { templateId: id },
      });
    });

    const template = await loadChecklistTemplate(id);
    emitToWorkspace(current.workspaceId, "checklistTemplate:updated", { workspaceId: current.workspaceId, template: template! });
    return template!;
  });

  app.delete("/checklist-templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const affectedAutomationIds = await db.transaction(async (tx) => {
      // Soft-delete: keep the row so the application ledger's FK and history stay intact.
      await tx.update(checklistTemplates).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(checklistTemplates.id, id));
      const affectedAutomationIds = await removeTemplateFromAutomationActions(tx, current.workspaceId, id);
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: current.workspaceId,
        action: "checklistTemplate:deleted",
        payload: { templateId: id, title: current.title },
      });
      return affectedAutomationIds;
    });
    emitToWorkspace(current.workspaceId, "checklistTemplate:deleted", { workspaceId: current.workspaceId, templateId: id });
    for (const automationId of affectedAutomationIds) {
      const automation = await loadAutomation(automationId);
      if (automation) emitToWorkspace(current.workspaceId, "automation:updated", { workspaceId: current.workspaceId, automation });
    }
    return reply.status(204).send();
  });

  app.post("/checklist-templates/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveChecklistTemplateBody.parse(req.body);
    const [current] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const { prev, next } = await neighbourPositions(current.workspaceId, body.afterTemplateId, body.beforeTemplateId);
    const result = between(prev, next);
    let position = result.position;
    const prevPosition = current.position;
    await db.update(checklistTemplates).set({ position, updatedAt: new Date() }).where(eq(checklistTemplates.id, id));

    if (result.needsRebalance) {
      const positions = await rebalanceChecklistTemplates(current.workspaceId);
      position = positions.find((p) => p.id === id)?.position ?? position;
      await emitToWorkspace(current.workspaceId, "checklistTemplate:rebalanced", { workspaceId: current.workspaceId, positions });
    }

    emitToWorkspace(current.workspaceId, "checklistTemplate:moved", {
      workspaceId: current.workspaceId,
      templateId: id,
      position,
      prevPosition,
    });
    return { id, position };
  });
}
