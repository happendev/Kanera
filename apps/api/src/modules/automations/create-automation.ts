import type { dto } from "@kanera/shared";
import { automations } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { armInProgressAutomation, loadAutomation } from "../../lib/automations.js";
import { between } from "../../lib/position.js";
import { assertEnabledAutomationLimit } from "../../lib/tier-limits.js";
import {
  assertEnabledAutomationHasActions,
  assertLabelInWorkspace,
  assertListInWorkspace,
  assertThresholdFieldInWorkspace,
  assertTriggerFeatureEnabled,
  assertWorkspaceAutomationLimit,
  replaceActions,
  validateActionTargets,
  validateCustomFieldTrigger,
  validateTriggerUsers,
} from "./route-support.js";

/**
 * Creates a workspace automation with its actions. The trigger and action target checks run in
 * the order the route always ran them, since that order decides which error wins.
 */
export async function createAutomation({
  auth,
  workspaceId,
  clientId,
  body,
}: {
  auth: AuthClaims;
  workspaceId: string;
  clientId: string;
  body: dto.CreateAutomationBody;
}) {
  await assertTriggerFeatureEnabled(workspaceId, body.triggerType);
  await assertListInWorkspace(workspaceId, body.triggerType === "card_enters_list" || body.triggerType === "card_leaves_list" ? body.triggerListId : null);
  await validateTriggerUsers(workspaceId, body.triggerType === "card_assigned_to_user" ? body.triggerUserIds : null);
  await assertLabelInWorkspace(workspaceId, body.triggerType === "card_label_set" ? body.triggerLabelId : null);
  await validateCustomFieldTrigger(workspaceId, body.triggerType === "custom_field_value_changed" ? body.triggerCustomFieldId : null, body.triggerType === "custom_field_value_changed" ? body.triggerCustomFieldValue : null);
  const inProgress = body.triggerType === "card_in_progress_too_long";
  const thresholdSource = inProgress ? body.triggerThresholdSource ?? "workspace" : null;
  await assertThresholdFieldInWorkspace(workspaceId, thresholdSource === "custom_field" ? body.triggerCustomFieldId : null);
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
    // Free-tier hosted orgs have a capped number of active rules. Enforce inside the tx
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
        triggerListId: body.triggerType === "card_enters_list" || body.triggerType === "card_leaves_list" ? body.triggerListId! : null,
        triggerUserIds: body.triggerType === "card_assigned_to_user" ? Array.from(new Set(body.triggerUserIds ?? [])) : null,
        triggerLabelId: body.triggerType === "card_label_set" ? body.triggerLabelId! : null,
        triggerCustomFieldId: body.triggerType === "custom_field_value_changed" || thresholdSource === "custom_field" ? body.triggerCustomFieldId! : null,
        triggerCustomFieldValue: body.triggerType === "custom_field_value_changed" ? body.triggerCustomFieldValue! : null,
        triggerDaysBefore: body.triggerType === "due_date_approaching" ? body.triggerDaysBefore! : null,
        triggerThresholdSource: thresholdSource,
        triggerThresholdAmount: thresholdSource === "fixed" ? body.triggerThresholdAmount! : null,
        triggerThresholdUnit: thresholdSource === "fixed" || thresholdSource === "custom_field" ? body.triggerThresholdUnit! : null,
        triggerIncludeExisting: inProgress && body.triggerIncludeExisting,
        applyOnCreate: body.applyOnCreate,
        applyOnMove: body.applyOnMove,
      })
      .returning();
    await replaceActions(tx, automation!.id, body.actions);
    if (inProgress && body.enabled) await armInProgressAutomation(tx, automation!.id, { limitChanged: false, includeExisting: body.triggerIncludeExisting });
    await recordActivity(tx, {
      boardId: null,
      workspaceId,
      actorId: auth.sub,
      entityType: "workspace",
      entityId: workspaceId,
      action: "automation:created",
      payload: { automationId: automation!.id },
    });
    return automation!.id;
  });
  const automation = await loadAutomation(id);
  return automation!;
}
