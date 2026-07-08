import { dto } from "@kanera/shared";
import { AUTOMATION_LIMIT } from "@kanera/shared/automation-limits";
import { automationActions, automations, cardLabels, checklistTemplates, customFieldOptions, customFields, lists, workspaceMembers } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, type Db } from "../../db.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { loadAutomation, loadAutomations } from "../../lib/automations.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { between, positionAtIndex } from "../../lib/position.js";
import { rebalanceAutomations } from "../../lib/rebalance.js";
import { assertEnabledAutomationLimit } from "../../lib/tier-limits.js";
import { emitToWorkspaceAdmins } from "../../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full automation scan.
async function neighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db.select({ position: automations.position }).from(automations).where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt))).orderBy(asc(automations.position)).limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db.select({ position: automations.position }).from(automations).where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt))).orderBy(desc(automations.position)).limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db.select({ position: automations.position }).from(automations).where(and(eq(automations.id, afterId), eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt))).limit(1);
    if (!after) throw badRequest("afterAutomationId not found");
    const [nextAutomation] = await db.select({ position: automations.position }).from(automations).where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt), gt(automations.position, after.position))).orderBy(asc(automations.position)).limit(1);
    prev = after.position;
    next = nextAutomation?.position ?? null;
  } else if (beforeId) {
    const [before] = await db.select({ position: automations.position }).from(automations).where(and(eq(automations.id, beforeId), eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt))).limit(1);
    if (!before) throw badRequest("beforeAutomationId not found");
    const [prevAutomation] = await db.select({ position: automations.position }).from(automations).where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt), lt(automations.position, before.position))).orderBy(desc(automations.position)).limit(1);
    next = before.position;
    prev = prevAutomation?.position ?? null;
  }
  return { prev, next };
}

async function assertListInWorkspace(workspaceId: string, listId: string | null | undefined, tx: Tx = db) {
  if (!listId) return;
  const [row] = await tx
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
    .limit(1);
  if (!row) throw badRequest("list not in workspace");
}

async function assertLabelInWorkspace(workspaceId: string, labelId: string | null | undefined, tx: Tx = db) {
  if (!labelId) return;
  const [row] = await tx
    .select({ id: cardLabels.id })
    .from(cardLabels)
    .where(and(eq(cardLabels.id, labelId), eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt)))
    .limit(1);
  if (!row) throw badRequest("label not in workspace");
}

async function validateActionTargets(workspaceId: string, actions: dto.AutomationActionBody[], tx: Tx = db) {
  const listIds = actions.flatMap((action) => action.type === "move_to_list" ? [action.config.listId] : []);
  if (listIds.length > 0) {
    const rows = await tx
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.workspaceId, workspaceId), inArray(lists.id, Array.from(new Set(listIds))), isNull(lists.archivedAt)));
    const validIds = new Set(rows.map((row) => row.id));
    if (listIds.some((id) => !validIds.has(id))) throw badRequest("one or more action list ids are invalid");
  }

  const labelIds = actions.flatMap((action) =>
    action.type === "add_labels" || action.type === "remove_labels" ? action.config.labelIds : [],
  );
  if (labelIds.length > 0) {
    const rows = await tx
      .select({ id: cardLabels.id })
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, workspaceId), inArray(cardLabels.id, Array.from(new Set(labelIds))), isNull(cardLabels.archivedAt)));
    const validIds = new Set(rows.map((row) => row.id));
    if (labelIds.some((id) => !validIds.has(id))) throw badRequest("one or more action label ids are invalid");
  }

  const userIds = actions.flatMap((action) =>
    action.type === "add_assignees" || action.type === "remove_assignees" ? action.config.userIds : [],
  );
  if (userIds.length > 0) {
    const rows = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, Array.from(new Set(userIds))),
      ));
    const validIds = new Set(rows.map((row) => row.userId));
    if (userIds.some((id) => !validIds.has(id))) throw badRequest("one or more action user ids are not assignable workspace members");
  }

  const templateIds = actions.flatMap((action) =>
    action.type === "apply_checklists" ? action.config.templateIds : [],
  );
  if (templateIds.length > 0) {
    const rows = await tx
      .select({ id: checklistTemplates.id })
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.workspaceId, workspaceId), inArray(checklistTemplates.id, Array.from(new Set(templateIds))), isNull(checklistTemplates.archivedAt)));
    const validIds = new Set(rows.map((row) => row.id));
    if (templateIds.some((id) => !validIds.has(id))) throw badRequest("one or more action checklist template ids are invalid");
  }

  const populateActions = actions.filter((action) => action.type === "populate_custom_field");
  if (populateActions.length > 0) {
    // Load both the target field and, for copy-from-field actions, the source field so we can
    // type-match them below.
    const populateFieldIds = populateActions.flatMap((action) =>
      action.config.value.kind === "field" ? [action.config.fieldId, action.config.value.sourceFieldId] : [action.config.fieldId],
    );
    const rows = await tx
      .select({ id: customFields.id, type: customFields.type, allowMultiple: customFields.allowMultiple })
      .from(customFields)
      .where(and(eq(customFields.workspaceId, workspaceId), inArray(customFields.id, Array.from(new Set(populateFieldIds))), isNull(customFields.archivedAt)));
    const fieldsById = new Map(rows.map((field) => [field.id, field]));

    const optionIds = populateActions.flatMap((action) => action.config.value.kind === "select" ? action.config.value.optionIds : []);
    const validOptionFieldById = new Map<string, string>();
    if (optionIds.length > 0) {
      const optionRows = await tx
        .select({ id: customFieldOptions.id, fieldId: customFieldOptions.fieldId })
        .from(customFieldOptions)
        .where(and(inArray(customFieldOptions.id, Array.from(new Set(optionIds))), isNull(customFieldOptions.archivedAt)));
      for (const option of optionRows) validOptionFieldById.set(option.id, option.fieldId);
    }

    const customFieldUserIds = populateActions.flatMap((action) => action.config.value.kind === "user" ? action.config.value.userIds : []);
    const validUserIds = new Set<string>();
    if (customFieldUserIds.length > 0) {
      const userRows = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, Array.from(new Set(customFieldUserIds)))));
      for (const row of userRows) validUserIds.add(row.userId);
    }

    for (const action of populateActions) {
      const field = fieldsById.get(action.config.fieldId);
      if (!field) throw badRequest("one or more set custom field ids are invalid");
      const value = action.config.value;
      if ((value.kind === "text" || value.kind === "text_current_date") && field.type !== "text") throw badRequest("set custom field value does not match field type");
      if (value.kind === "number" && field.type !== "number") throw badRequest("set custom field value does not match field type");
      if (value.kind === "date" && field.type !== "date") throw badRequest("set custom field value does not match field type");
      if (value.kind === "checkbox" && field.type !== "checkbox") throw badRequest("set custom field value does not match field type");
      if (value.kind === "select") {
        if (field.type !== "select") throw badRequest("set custom field value does not match field type");
        if (!field.allowMultiple && value.optionIds.length > 1) throw badRequest("expected a single option");
        if (value.optionIds.some((optionId) => validOptionFieldById.get(optionId) !== field.id)) throw badRequest("unknown option for set custom field action");
      }
      if (value.kind === "user") {
        if (field.type !== "user") throw badRequest("set custom field value does not match field type");
        if (!field.allowMultiple && value.userIds.length > 1) throw badRequest("expected a single user");
        if (value.userIds.some((userId) => !validUserIds.has(userId))) throw badRequest("user is not a workspace member");
      }
      if (value.kind === "field") {
        // Copy-from-field: the source field must exist in the workspace and share the target's
        // type. Per-card option/member resolution happens at apply time, not here.
        const source = fieldsById.get(value.sourceFieldId);
        if (!source) throw badRequest("set custom field copy source is invalid");
        if (source.type !== field.type) throw badRequest("set custom field value does not match field type");
      }
    }
  }
}

async function validateTriggerUsers(workspaceId: string, userIds: string[] | null | undefined, tx: Tx = db) {
  if (!userIds || userIds.length === 0) return;
  const uniqueIds = Array.from(new Set(userIds));
  const rows = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      inArray(workspaceMembers.userId, uniqueIds),
    ));
  const validIds = new Set(rows.map((row) => row.userId));
  if (uniqueIds.some((id) => !validIds.has(id))) throw badRequest("one or more trigger user ids are not assignable workspace members");
}

function assertEnabledAutomationHasActions(enabled: boolean, actionCount: number) {
  // Enabled automations must have at least one Do action; otherwise they can
  // match triggers while doing nothing, which makes audit and UI state misleading.
  if (enabled && actionCount === 0) throw badRequest("enabled automations require at least one action");
}

async function hasAutomationActions(automationId: string, tx: Tx = db) {
  const [action] = await tx
    .select({ id: automationActions.id })
    .from(automationActions)
    .where(eq(automationActions.automationId, automationId))
    .limit(1);
  return Boolean(action);
}

async function replaceActions(tx: Tx, automationId: string, actions: dto.AutomationActionBody[]) {
  await tx.delete(automationActions).where(eq(automationActions.automationId, automationId));
  if (actions.length === 0) return;
  await tx.insert(automationActions).values(
    actions.map((action, index) => ({
      automationId,
      type: action.type,
      config: action.config,
      position: positionAtIndex(index),
    })),
  );
}

async function assertWorkspaceAutomationLimit(workspaceId: string, tx: Tx = db) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt)));
  if ((row?.count ?? 0) >= AUTOMATION_LIMIT) {
    throw badRequest(`Workspaces can have up to ${AUTOMATION_LIMIT} automations. Contact support if you need more.`);
  }
}

export async function automationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:wsId/automations", async (req) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    return loadAutomations(workspaceId);
  });

  app.post("/workspaces/:wsId/automations", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.createAutomationBody.parse(req.body);
    await assertListInWorkspace(workspaceId, body.triggerType === "card_enters_list" ? body.triggerListId : null);
    await validateTriggerUsers(workspaceId, body.triggerType === "card_assigned_to_user" ? body.triggerUserIds : null);
    await assertLabelInWorkspace(workspaceId, body.triggerType === "card_label_set" ? body.triggerLabelId : null);
    await validateActionTargets(workspaceId, body.actions);
    assertEnabledAutomationHasActions(body.enabled, body.actions.length);
    const [first] = await db
      .select({ position: automations.position })
      .from(automations)
      .where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt)))
      .orderBy(asc(automations.position))
      .limit(1);
    // New automations should be immediately visible where the user created them:
    // the automations page renders ascending positions, so insert before the first active rule.
    const { position } = between(null, first?.position ?? null);
    const id = await db.transaction(async (tx) => {
      // Keep automation lists operationally bounded; support can help with heavier workflow needs.
      await assertWorkspaceAutomationLimit(workspaceId, tx);
      // Free-tier hosted orgs may only have one enabled automation at a time. Enforce inside the tx
      // so the cap check and insert share one transaction; the helper takes a tenant row lock to
      // serialize concurrent enables against the free cap.
      if (body.enabled) await assertEnabledAutomationLimit(clientId, {}, tx);
      const [automation] = await tx
        .insert(automations)
        .values({
          workspaceId,
          enabled: body.enabled,
          position,
          triggerType: body.triggerType,
          triggerListId: body.triggerType === "card_enters_list" ? body.triggerListId! : null,
          triggerUserIds: body.triggerType === "card_assigned_to_user" ? Array.from(new Set(body.triggerUserIds ?? [])) : null,
          triggerLabelId: body.triggerType === "card_label_set" ? body.triggerLabelId! : null,
          applyOnCreate: body.applyOnCreate,
          applyOnMove: body.applyOnMove,
        })
        .returning();
      await replaceActions(tx, automation!.id, body.actions);
      await recordActivity(tx, {
        boardId: null,
        workspaceId,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: workspaceId,
        action: "automation:created",
        payload: { automationId: automation!.id },
      });
      return automation!.id;
    });
    const automation = await loadAutomation(id);
    await emitToWorkspaceAdmins(workspaceId, "automation:created", { workspaceId, automation: automation! });
    return reply.status(201).send(automation);
  });

  app.patch("/automations/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateAutomationBody.parse(req.body);
    const [current] = await db.select().from(automations).where(eq(automations.id, id)).limit(1);
    if (!current) throw notFound();
    const { clientId } = await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const triggerType = body.triggerType ?? current.triggerType;
    const triggerListId = triggerType === "card_enters_list"
      ? body.triggerListId !== undefined ? body.triggerListId : current.triggerListId
      : null;
    const triggerUserIds = triggerType === "card_assigned_to_user"
      ? body.triggerUserIds !== undefined ? body.triggerUserIds : current.triggerUserIds
      : null;
    const triggerLabelId = triggerType === "card_label_set"
      ? body.triggerLabelId !== undefined ? body.triggerLabelId : current.triggerLabelId
      : null;
    if (triggerType === "card_enters_list" && !triggerListId) throw badRequest("triggerListId is required");
    if (triggerType === "card_assigned_to_user" && (!triggerUserIds || triggerUserIds.length === 0)) throw badRequest("triggerUserIds is required");
    if (triggerType === "card_label_set" && !triggerLabelId) throw badRequest("triggerLabelId is required");
    await assertListInWorkspace(current.workspaceId, triggerListId);
    await validateTriggerUsers(current.workspaceId, triggerUserIds);
    await assertLabelInWorkspace(current.workspaceId, triggerLabelId);
    await db.transaction(async (tx) => {
      // Action replacement also updates this row, so locking it before re-reading actions
      // serializes enable toggles with action clears and preserves the enabled/action invariant.
      const [locked] = await tx
        .select({ enabled: automations.enabled })
        .from(automations)
        .where(eq(automations.id, id))
        .for("update")
        .limit(1);
      if (!locked) throw notFound();
      if (body.enabled === true) {
        assertEnabledAutomationHasActions(true, await hasAutomationActions(id, tx) ? 1 : 0);
      }
      // Enforce the free-tier enabled-automation cap only when turning a disabled automation on,
      // excluding this automation from the count so re-enabling the single allowed one is fine.
      // Runs inside the tx so the cap check, tenant lock, and update share one transaction.
      if (body.enabled === true && !locked.enabled) await assertEnabledAutomationLimit(clientId, { excludeId: id }, tx);
      await tx
        .update(automations)
        .set({
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          ...(body.triggerType !== undefined && { triggerType }),
          triggerListId,
          triggerUserIds: triggerUserIds ? Array.from(new Set(triggerUserIds)) : null,
          triggerLabelId,
          ...(body.applyOnCreate !== undefined && { applyOnCreate: body.applyOnCreate }),
          ...(body.applyOnMove !== undefined && { applyOnMove: body.applyOnMove }),
          updatedAt: new Date(),
        })
        .where(eq(automations.id, id));
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: current.workspaceId,
        action: "automation:updated",
        payload: { automationId: id },
      });
    });
    const automation = await loadAutomation(id);
    await emitToWorkspaceAdmins(current.workspaceId, "automation:updated", { workspaceId: current.workspaceId, automation: automation! });
    return automation!;
  });

  app.put("/automations/:id/actions", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setAutomationActionsBody.parse(req.body);
    const [current] = await db.select().from(automations).where(eq(automations.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    await validateActionTargets(current.workspaceId, body.actions);
    await db.transaction(async (tx) => {
      await replaceActions(tx, id, body.actions);
      await tx
        .update(automations)
        .set({
          // Removing the final Do action must also disable the automation so it
          // cannot keep matching triggers with an empty effect set.
          ...(body.actions.length === 0 && { enabled: false }),
          updatedAt: new Date(),
        })
        .where(eq(automations.id, id));
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: current.workspaceId,
        action: "automation:updated",
        payload: { automationId: id, actions: body.actions.length },
      });
    });
    const automation = await loadAutomation(id);
    await emitToWorkspaceAdmins(current.workspaceId, "automation:updated", { workspaceId: current.workspaceId, automation: automation! });
    return automation!;
  });

  app.post("/automations/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveAutomationBody.parse(req.body);
    const [current] = await db.select().from(automations).where(eq(automations.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const { prev, next } = await neighbourPositions(current.workspaceId, body.afterAutomationId, body.beforeAutomationId);
    const result = between(prev, next);
    const prevPosition = current.position;
    const { position, rebalancedPositions } = await db.transaction(async (tx) => {
      let position = result.position;
      await tx.update(automations).set({ position, updatedAt: new Date() }).where(eq(automations.id, id));

      // Keep the move, any full reorder, and its audit row atomic so the recorded position
      // always describes the committed automation order.
      const rebalancedPositions = result.needsRebalance
        ? await rebalanceAutomations(current.workspaceId, tx)
        : null;
      position = rebalancedPositions?.find((row) => row.id === id)?.position ?? position;
      await recordActivity(tx, {
        boardId: null,
        workspaceId: current.workspaceId,
        actorId: req.auth.sub,
        entityType: "workspace",
        entityId: current.workspaceId,
        action: "moved",
        payload: { automationId: id, prevPosition, position },
      });
      return { position, rebalancedPositions };
    });
    if (rebalancedPositions) {
      await emitToWorkspaceAdmins(current.workspaceId, "automation:rebalanced", { workspaceId: current.workspaceId, positions: rebalancedPositions });
    }
    await emitToWorkspaceAdmins(current.workspaceId, "automation:moved", { workspaceId: current.workspaceId, automationId: id, position, prevPosition });
    return { id, position };
  });

  app.delete("/automations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(automations).where(eq(automations.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    await db.update(automations).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(automations.id, id));
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "workspace",
      entityId: current.workspaceId,
      action: "automation:deleted",
      payload: { automationId: id },
    });
    await emitToWorkspaceAdmins(current.workspaceId, "automation:deleted", { workspaceId: current.workspaceId, automationId: id });
    return reply.status(204).send();
  });
}
