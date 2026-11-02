import type { dto } from "@kanera/shared";
import { AUTOMATION_LIMIT } from "@kanera/shared/automation-limits";
import { automationActions, automations, cardLabels, checklistTemplates, customFieldOptions, customFields, lists, webhookEndpoints, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { automationTriggerBlockedBy } from "@kanera/shared/workspace-features";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "../../db.js";
import { env } from "../../env.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { positionAtIndex } from "../../lib/position.js";
import { capturePremiumFeatureUsed } from "../../lib/product-analytics.js";
import { featureDisabledError, loadWorkspaceFeatures } from "../../lib/workspace-features.js";

/** Loads the automation row for the `/automations/:id` mutations, 404ing when it does not exist. */
export async function loadAutomationRow(id: string) {
  const [current] = await db.select().from(automations).where(eq(automations.id, id)).limit(1);
  if (!current) throw notFound();
  return current;
}

export async function capturePremiumAutomationRuleUse(input: {
  clientId: string;
  workspaceId: string;
  actorId: string;
  supportSession: boolean;
}): Promise<void> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(automations)
    .innerJoin(workspaces, eq(workspaces.id, automations.workspaceId))
    .where(and(eq(workspaces.clientId, input.clientId), eq(automations.enabled, true), isNull(automations.archivedAt)));
  const count = row?.count ?? 0;
  if (count <= env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS) return;
  await capturePremiumFeatureUsed({
    organizationId: input.clientId,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    premiumFeature: "automation_rules",
    currentUsage: count,
    supportSession: input.supportSession,
  });
}

export async function assertListInWorkspace(workspaceId: string, listId: string | null | undefined, tx: Tx = db) {
  if (!listId) return;
  const [row] = await tx
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
    .limit(1);
  if (!row) throw badRequest("list not in workspace");
}

export async function assertLabelInWorkspace(workspaceId: string, labelId: string | null | undefined, tx: Tx = db) {
  if (!labelId) return;
  const [row] = await tx
    .select({ id: cardLabels.id })
    .from(cardLabels)
    .where(and(eq(cardLabels.id, labelId), eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt)))
    .limit(1);
  if (!row) throw badRequest("label not in workspace");
}

export async function validateCustomFieldTrigger(
  workspaceId: string,
  fieldId: string | null | undefined,
  value: dto.AutomationTriggerCustomFieldValueDto | null | undefined,
  tx: Tx = db,
) {
  if (!fieldId || !value) return;
  const [field] = await tx
    .select({ id: customFields.id, type: customFields.type })
    .from(customFields)
    .where(and(eq(customFields.id, fieldId), eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt)))
    .limit(1);
  if (!field) throw badRequest("custom field trigger field is invalid");
  if (field.type !== value.kind) throw badRequest("custom field trigger value does not match field type");
  if (value.kind === "select") {
    const [option] = await tx
      .select({ id: customFieldOptions.id })
      .from(customFieldOptions)
      .where(and(eq(customFieldOptions.id, value.optionId), eq(customFieldOptions.fieldId, field.id), isNull(customFieldOptions.archivedAt)))
      .limit(1);
    if (!option) throw badRequest("unknown option for custom field trigger");
  }
  if (value.kind === "user") {
    const [member] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, value.userId)))
      .limit(1);
    if (!member) throw badRequest("custom field trigger user is not a workspace member");
  }
}

// An "over the estimate" limit reads a number field on each card; any other type has no amount.
export async function assertThresholdFieldInWorkspace(workspaceId: string, fieldId: string | null | undefined, tx: Tx = db) {
  if (!fieldId) return;
  const [field] = await tx
    .select({ type: customFields.type })
    .from(customFields)
    .where(and(eq(customFields.id, fieldId), eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt)))
    .limit(1);
  if (!field) throw badRequest("custom field trigger field is invalid");
  if (field.type !== "number") throw badRequest("in-progress limit field must be a number field");
}

export async function validateActionTargets(workspaceId: string, actions: dto.AutomationActionBody[], tx: Tx = db) {
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

  // call_webhook references an endpoint rather than a URL so the endpoint's secret, SSRF-checked
  // URL, and delivery log are reused. Only generic (non-chat) endpoints of this workspace qualify;
  // a disabled endpoint may still be selected, it simply no-ops until re-enabled.
  const endpointIds = actions.flatMap((action) => action.type === "call_webhook" ? [action.config.endpointId] : []);
  if (endpointIds.length > 0) {
    const rows = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic"), inArray(webhookEndpoints.id, Array.from(new Set(endpointIds)))));
    const validIds = new Set(rows.map((row) => row.id));
    if (endpointIds.some((id) => !validIds.has(id))) throw badRequest("one or more action webhook endpoint ids are invalid");
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

export async function validateTriggerUsers(workspaceId: string, userIds: string[] | null | undefined, tx: Tx = db) {
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

export function assertEnabledAutomationHasActions(enabled: boolean, actionCount: number) {
  // Enabled automations must have at least one Do action; otherwise they can
  // match triggers while doing nothing, which makes audit and UI state misleading.
  if (enabled && actionCount === 0) throw badRequest("enabled automations require at least one action");
}

export async function hasAutomationActions(automationId: string, tx: Tx = db) {
  const [action] = await tx
    .select({ id: automationActions.id })
    .from(automationActions)
    .where(eq(automationActions.automationId, automationId))
    .limit(1);
  return Boolean(action);
}

export async function replaceActions(tx: Tx, automationId: string, actions: dto.AutomationActionBody[]) {
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

export async function assertWorkspaceAutomationLimit(workspaceId: string, tx: Tx = db) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt)));
  if ((row?.count ?? 0) >= AUTOMATION_LIMIT) {
    throw badRequest(`Workspaces can have up to ${AUTOMATION_LIMIT} automations. Contact support if you need more.`);
  }
}

export async function assertTriggerFeatureEnabled(workspaceId: string, triggerType: string): Promise<void> {
  const blockedBy = automationTriggerBlockedBy(triggerType, await loadWorkspaceFeatures(workspaceId));
  if (blockedBy) throw featureDisabledError(blockedBy);
}
