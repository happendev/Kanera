import { dto } from "@kanera/shared";
import { automations } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { armInProgressAutomation, loadAutomation } from "../../lib/automations.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { assertEnabledAutomationLimit } from "../../lib/tier-limits.js";
import {
  assertEnabledAutomationHasActions,
  assertLabelInWorkspace,
  assertListInWorkspace,
  assertThresholdFieldInWorkspace,
  assertTriggerFeatureEnabled,
  hasAutomationActions,
  replaceActions,
  validateActionTargets,
  validateCustomFieldTrigger,
  validateTriggerUsers,
} from "./route-support.js";

/**
 * Patches an automation's trigger, flags and (optionally) actions. Trigger fields are resolved
 * against the current row first, then validated in the order the route always used.
 */
export async function updateAutomation({
  auth,
  automation: current,
  clientId,
  body,
}: {
  auth: AuthClaims;
  automation: typeof automations.$inferSelect;
  clientId: string;
  body: dto.UpdateAutomationBody;
}) {
  const id = current.id;
  const triggerType = body.triggerType ?? current.triggerType;
  // A rule kept from before a feature was switched off can still be edited or turned off, but not
  // switched onto, or back on for, a trigger that cannot fire.
  if (body.triggerType !== undefined || body.enabled === true) await assertTriggerFeatureEnabled(current.workspaceId, triggerType);
  const triggerListId = triggerType === "card_enters_list" || triggerType === "card_leaves_list"
    ? body.triggerListId !== undefined ? body.triggerListId : current.triggerListId
    : null;
  const triggerUserIds = triggerType === "card_assigned_to_user"
    ? body.triggerUserIds !== undefined ? body.triggerUserIds : current.triggerUserIds
    : null;
  const triggerLabelId = triggerType === "card_label_set"
    ? body.triggerLabelId !== undefined ? body.triggerLabelId : current.triggerLabelId
    : null;
  const inProgress = triggerType === "card_in_progress_too_long";
  const thresholdSource = inProgress
    ? (body.triggerThresholdSource !== undefined ? body.triggerThresholdSource : current.triggerThresholdSource) ?? "workspace"
    : null;
  const triggerCustomFieldId = triggerType === "custom_field_value_changed" || thresholdSource === "custom_field"
    ? body.triggerCustomFieldId !== undefined ? body.triggerCustomFieldId : current.triggerCustomFieldId
    : null;
  const triggerThresholdAmount = thresholdSource === "fixed"
    ? body.triggerThresholdAmount !== undefined ? body.triggerThresholdAmount : current.triggerThresholdAmount
    : null;
  const triggerThresholdUnit = thresholdSource === "fixed" || thresholdSource === "custom_field"
    ? (body.triggerThresholdUnit !== undefined ? body.triggerThresholdUnit : current.triggerThresholdUnit)
    : null;
  const triggerIncludeExisting = inProgress && (body.triggerIncludeExisting ?? current.triggerIncludeExisting);
  const triggerCustomFieldValue = triggerType === "custom_field_value_changed"
    ? body.triggerCustomFieldValue !== undefined ? body.triggerCustomFieldValue : current.triggerCustomFieldValue
    : null;
  const triggerDaysBefore = triggerType === "due_date_approaching"
    ? body.triggerDaysBefore !== undefined ? body.triggerDaysBefore : current.triggerDaysBefore
    : null;
  if ((triggerType === "card_enters_list" || triggerType === "card_leaves_list") && !triggerListId) throw badRequest("triggerListId is required");
  if (triggerType === "card_assigned_to_user" && (!triggerUserIds || triggerUserIds.length === 0)) throw badRequest("triggerUserIds is required");
  if (triggerType === "card_label_set" && !triggerLabelId) throw badRequest("triggerLabelId is required");
  if (triggerType === "due_date_approaching" && !triggerDaysBefore) throw badRequest("triggerDaysBefore is required");
  if (triggerType === "custom_field_value_changed" && (!triggerCustomFieldId || !triggerCustomFieldValue)) throw badRequest("triggerCustomFieldId and triggerCustomFieldValue are required");
  if (inProgress) {
    const issue = dto.inProgressThresholdIssue({ triggerThresholdSource: thresholdSource, triggerThresholdAmount, triggerThresholdUnit, triggerCustomFieldId });
    if (issue) throw badRequest(issue.message);
  }
  await assertThresholdFieldInWorkspace(current.workspaceId, thresholdSource === "custom_field" ? triggerCustomFieldId : null);
  // Which cards a rule has handled only means something against the limit they were handled at.
  const limitChanged = inProgress && (
    current.triggerType !== triggerType
    || (current.triggerThresholdSource ?? "workspace") !== thresholdSource
    || current.triggerThresholdAmount !== triggerThresholdAmount
    || current.triggerThresholdUnit !== triggerThresholdUnit
    || (thresholdSource === "custom_field" && current.triggerCustomFieldId !== triggerCustomFieldId)
  );
  await assertListInWorkspace(current.workspaceId, triggerListId);
  await validateTriggerUsers(current.workspaceId, triggerUserIds);
  await assertLabelInWorkspace(current.workspaceId, triggerLabelId);
  await validateCustomFieldTrigger(current.workspaceId, triggerCustomFieldId, triggerCustomFieldValue);
  if (body.actions !== undefined) await validateActionTargets(current.workspaceId, body.actions);
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
    const nextEnabled = body.enabled ?? (body.actions?.length === 0 ? false : locked.enabled);
    const nextHasActions = body.actions !== undefined
      ? body.actions.length > 0
      : await hasAutomationActions(id, tx);
    assertEnabledAutomationHasActions(nextEnabled, nextHasActions ? 1 : 0);
    // Enforce the free-tier enabled-automation cap only when turning a disabled automation on,
    // excluding this automation from the count so re-enabling the single allowed one is fine.
    // Runs inside the tx so the cap check, tenant lock, and update share one transaction.
    if (nextEnabled && !locked.enabled) await assertEnabledAutomationLimit(clientId, { excludeId: id }, tx);
    if (body.actions !== undefined) await replaceActions(tx, id, body.actions);
    await tx
      .update(automations)
      .set({
        ...(body.enabled !== undefined || body.actions?.length === 0 ? { enabled: nextEnabled } : {}),
        ...(body.triggerType !== undefined && { triggerType }),
        triggerListId,
        triggerUserIds: triggerUserIds ? Array.from(new Set(triggerUserIds)) : null,
        triggerLabelId,
        triggerCustomFieldId,
        triggerCustomFieldValue,
        triggerDaysBefore,
        triggerThresholdSource: thresholdSource,
        triggerThresholdAmount,
        triggerThresholdUnit,
        triggerIncludeExisting,
        ...(body.applyOnCreate !== undefined && { applyOnCreate: body.applyOnCreate }),
        ...(body.applyOnMove !== undefined && { applyOnMove: body.applyOnMove }),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, id));
    // A rule that is off records nothing yet: cards keep crossing while it is off, and the moment it
    // is turned on is the one that decides which of them count as existing.
    const turningOn = nextEnabled && !locked.enabled;
    if (inProgress && (limitChanged || turningOn)) {
      await armInProgressAutomation(tx, id, { limitChanged, includeExisting: triggerIncludeExisting || !nextEnabled });
    }
    await recordActivity(tx, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: auth.sub,
      entityType: "workspace",
      entityId: current.workspaceId,
      action: "automation:updated",
      payload: { automationId: id, ...(body.actions !== undefined && { actions: body.actions.length }) },
    });
  });
  const automation = await loadAutomation(id);
  return automation!;
}
