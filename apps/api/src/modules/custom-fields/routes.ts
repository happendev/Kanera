import { dto } from "@kanera/shared";
import { customFieldOptions, customFields } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { loadFieldOptions } from "../../lib/custom-fields.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { between } from "../../lib/position.js";
import { rebalanceCustomFieldOptions, rebalanceCustomFields } from "../../lib/rebalance.js";
import { emitToWorkspace } from "../../realtime/emit.js";

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so fields with many select options stay cheap to reorder.
async function optionNeighbourPositions(fieldId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(and(eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt))).orderBy(asc(customFieldOptions.position)).limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(and(eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt))).orderBy(desc(customFieldOptions.position)).limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(and(eq(customFieldOptions.id, afterId), eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt))).limit(1);
    if (!after) throw badRequest("afterOptionId not found");
    const [nextOption] = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(and(eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt), gt(customFieldOptions.position, after.position))).orderBy(asc(customFieldOptions.position)).limit(1);
    prev = after.position;
    next = nextOption?.position ?? null;
  } else if (beforeId) {
    const [before] = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(and(eq(customFieldOptions.id, beforeId), eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt))).limit(1);
    if (!before) throw badRequest("beforeOptionId not found");
    const [prevOption] = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(and(eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt), lt(customFieldOptions.position, before.position))).orderBy(desc(customFieldOptions.position)).limit(1);
    next = before.position;
    prev = prevOption?.position ?? null;
  }
  return { prev, next };
}

const normalizeCustomFieldName = (name: string) => name.trim().toLocaleLowerCase();

async function assertUniqueCustomFieldName(workspaceId: string, name: string, excludeId?: string) {
  const rows = await db
    .select({ id: customFields.id, name: customFields.name })
    .from(customFields)
    .where(and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt)));

  const normalizedName = normalizeCustomFieldName(name);
  const hasConflict = rows.some((row) => row.id !== excludeId && normalizeCustomFieldName(row.name) === normalizedName);
  if (hasConflict) throw conflict("custom field names must be unique within a workspace");
}

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full custom-field scan.
async function neighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db.select({ position: customFields.position }).from(customFields).where(and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt))).orderBy(asc(customFields.position)).limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db.select({ position: customFields.position }).from(customFields).where(and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt))).orderBy(desc(customFields.position)).limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db.select({ position: customFields.position }).from(customFields).where(and(eq(customFields.id, afterId), eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt))).limit(1);
    if (!after) throw badRequest("afterFieldId not found");
    const [nextField] = await db.select({ position: customFields.position }).from(customFields).where(and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt), gt(customFields.position, after.position))).orderBy(asc(customFields.position)).limit(1);
    prev = after.position;
    next = nextField?.position ?? null;
  } else if (beforeId) {
    const [before] = await db.select({ position: customFields.position }).from(customFields).where(and(eq(customFields.id, beforeId), eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt))).limit(1);
    if (!before) throw badRequest("beforeFieldId not found");
    const [prevField] = await db.select({ position: customFields.position }).from(customFields).where(and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt), lt(customFields.position, before.position))).orderBy(desc(customFields.position)).limit(1);
    next = before.position;
    prev = prevField?.position ?? null;
  }
  return { prev, next };
}

export async function customFieldRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/workspaces/:wsId/custom-fields", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "editor");
    const body = dto.createCustomFieldBody.parse(req.body);
    await assertUniqueCustomFieldName(workspaceId, body.name);
    const [last] = await db
      .select({ position: customFields.position })
      .from(customFields)
      .where(eq(customFields.workspaceId, workspaceId))
      .orderBy(desc(customFields.position))
      .limit(1);
    const { position } = between(last?.position ?? null, null);
    const { options: optionSeeds, ...fieldValues } = body;
    const [customField] = await db
      .insert(customFields)
      .values({ workspaceId, ...fieldValues, position })
      .returning();
    // Seed select options if provided; ignored for non-select types.
    if (customField!.type === "select" && optionSeeds?.length) {
      let prev: string | null = null;
      const rows = optionSeeds.map((seed) => {
        const pos = between(prev, null).position;
        prev = pos;
        return { fieldId: customField!.id, label: seed.label, color: seed.color ?? null, position: pos };
      });
      await db.insert(customFieldOptions).values(rows);
    }
    const options = await loadFieldOptions(customField!.id);
    const wireField = { ...customField!, options };
    await recordActivity(db, {
      boardId: null,
      workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: customField!.id,
      action: "created",
      payload: { name: customField!.name, icon: customField!.icon, type: customField!.type },
    });
    emitToWorkspace(workspaceId, "customField:created", { workspaceId, customField: wireField });
    return reply.status(201).send(wireField);
  });

  app.patch("/custom-fields/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateCustomFieldBody.parse(req.body);
    const [current] = await db.select().from(customFields).where(eq(customFields.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    if (body.name !== undefined) {
      await assertUniqueCustomFieldName(current.workspaceId, body.name, id);
    }
    const [customField] = await db
      .update(customFields)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.showOnCard !== undefined && { showOnCard: body.showOnCard }),
        ...(body.allowMultiple !== undefined && { allowMultiple: body.allowMultiple }),
        updatedAt: new Date(),
      })
      .where(eq(customFields.id, id))
      .returning();
    // Existing stored card values are not rewritten when multi→single; single-value
    // pickers cap display/edit to the first id and new writes are validated to one.
    const options = await loadFieldOptions(id);
    const wireField = { ...customField!, options };
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: id,
      action: "updated",
      payload: body,
    });
    emitToWorkspace(current.workspaceId, "customField:updated", { workspaceId: current.workspaceId, customField: wireField });
    return wireField;
  });

  app.delete("/custom-fields/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(customFields).where(eq(customFields.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    await db.delete(customFields).where(eq(customFields.id, id));
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: id,
      action: "deleted",
      payload: { name: current.name, type: current.type },
    });
    emitToWorkspace(current.workspaceId, "customField:deleted", { workspaceId: current.workspaceId, fieldId: id });
    return reply.status(204).send();
  });

  app.post("/custom-fields/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCustomFieldBody.parse(req.body);
    const [current] = await db.select().from(customFields).where(eq(customFields.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const { prev, next } = await neighbourPositions(current.workspaceId, body.afterFieldId, body.beforeFieldId);
    const result = between(prev, next);
    let position = result.position;
    const prevPosition = current.position;
    await db.update(customFields).set({ position, updatedAt: new Date() }).where(eq(customFields.id, id));

    if (result.needsRebalance) {
      const positions = await rebalanceCustomFields(current.workspaceId);
      position = positions.find((p) => p.id === id)?.position ?? position;
      await emitToWorkspace(current.workspaceId, "customField:rebalanced", { workspaceId: current.workspaceId, positions });
    }

    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: id,
      action: "moved",
      payload: { prevPosition, position },
    });
    emitToWorkspace(current.workspaceId, "customField:moved", {
      workspaceId: current.workspaceId,
      fieldId: id,
      position,
      prevPosition,
    });
    return { id, position };
  });

  // --- Select field options ---

  app.post("/custom-fields/:id/options", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.createCustomFieldOptionBody.parse(req.body);
    const [field] = await db.select().from(customFields).where(eq(customFields.id, id)).limit(1);
    if (!field) throw notFound("custom field not found");
    await assertWorkspaceAccess(req.auth, field.workspaceId, "admin");
    if (field.type !== "select") throw badRequest("options are only valid for select fields");
    const [last] = await db
      .select({ position: customFieldOptions.position })
      .from(customFieldOptions)
      .where(and(eq(customFieldOptions.fieldId, id), isNull(customFieldOptions.archivedAt)))
      .orderBy(desc(customFieldOptions.position))
      .limit(1);
    const { position } = between(last?.position ?? null, null);
    const [option] = await db
      .insert(customFieldOptions)
      .values({ fieldId: id, label: body.label, color: body.color ?? null, position })
      .returning();
    await recordActivity(db, {
      boardId: null,
      workspaceId: field.workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: id,
      action: "updated",
      payload: { optionAdded: option!.label },
    });
    emitToWorkspace(field.workspaceId, "customFieldOption:created", {
      workspaceId: field.workspaceId,
      fieldId: id,
      option: option!,
    });
    return reply.status(201).send(option);
  });

  app.patch("/options/:optionId", async (req) => {
    const { optionId } = req.params as { optionId: string };
    const body = dto.updateCustomFieldOptionBody.parse(req.body);
    const { field, workspaceId } = await loadOptionField(optionId);
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [option] = await db
      .update(customFieldOptions)
      .set({
        ...(body.label !== undefined && { label: body.label }),
        ...(body.color !== undefined && { color: body.color }),
        updatedAt: new Date(),
      })
      .where(eq(customFieldOptions.id, optionId))
      .returning();
    await recordActivity(db, {
      boardId: null,
      workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: field.id,
      action: "updated",
      payload: { optionUpdated: option!.label, ...body },
    });
    emitToWorkspace(workspaceId, "customFieldOption:updated", {
      workspaceId,
      fieldId: field.id,
      option: option!,
    });
    return option!;
  });

  app.delete("/options/:optionId", async (req, reply) => {
    const { optionId } = req.params as { optionId: string };
    const { field, workspaceId } = await loadOptionField(optionId);
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    // Soft archive so cards still referencing the option keep resolving its label.
    await db
      .update(customFieldOptions)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(customFieldOptions.id, optionId));
    await recordActivity(db, {
      boardId: null,
      workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: field.id,
      action: "updated",
      payload: { optionDeleted: optionId },
    });
    emitToWorkspace(workspaceId, "customFieldOption:deleted", { workspaceId, fieldId: field.id, optionId });
    return reply.status(204).send();
  });

  app.post("/options/:optionId/move", async (req) => {
    const { optionId } = req.params as { optionId: string };
    const body = dto.moveCustomFieldOptionBody.parse(req.body);
    const { field, workspaceId, option: current } = await loadOptionField(optionId);
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const { prev, next } = await optionNeighbourPositions(field.id, body.afterOptionId, body.beforeOptionId);
    const result = between(prev, next);
    let position = result.position;
    const prevPosition = current.position;
    await db
      .update(customFieldOptions)
      .set({ position, updatedAt: new Date() })
      .where(eq(customFieldOptions.id, optionId));
    await recordActivity(db, {
      boardId: null,
      workspaceId,
      actorId: req.auth.sub,
      entityType: "customField",
      entityId: field.id,
      action: "updated",
      payload: { optionMoved: current.label, optionId, fromPosition: prevPosition, toPosition: position },
    });

    if (result.needsRebalance) {
      const positions = await rebalanceCustomFieldOptions(field.id);
      position = positions.find((p) => p.id === optionId)?.position ?? position;
      await emitToWorkspace(workspaceId, "customFieldOption:rebalanced", { workspaceId, fieldId: field.id, positions });
    }

    emitToWorkspace(workspaceId, "customFieldOption:moved", {
      workspaceId,
      fieldId: field.id,
      optionId,
      position,
      prevPosition,
    });
    return { id: optionId, position };
  });
}

/** Load an option plus its owning field/workspace for access checks. */
async function loadOptionField(optionId: string) {
  const [option] = await db
    .select()
    .from(customFieldOptions)
    .where(eq(customFieldOptions.id, optionId))
    .limit(1);
  if (!option) throw notFound("option not found");
  const [field] = await db.select().from(customFields).where(eq(customFields.id, option.fieldId)).limit(1);
  if (!field) throw notFound("custom field not found");
  return { option, field, workspaceId: field.workspaceId };
}
