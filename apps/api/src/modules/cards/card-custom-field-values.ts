import type { SetCustomFieldValueBody } from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardCustomFieldValues, cards, customFields, type Card, type CardCustomFieldValue } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertCardAccess } from "../../lib/access.js";
import { recordCoalescedActivity, type CoalescedActivityResult } from "../../lib/activity.js";
import { emitAutomationEffects, runCustomFieldValueChangedAutomations, type AutomationEffects } from "../../lib/automations.js";
import { buildCustomFieldValueColumns, customFieldValueEquals, describeCustomFieldValue, type CustomFieldValueColumns } from "../../lib/custom-fields.js";
import { notFound } from "../../lib/errors.js";
import { emitToBoard } from "../../realtime/emit.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { emitCoalescedCardActivityFeedItem } from "./route-support.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

type CustomFieldValueInput = {
  auth: AuthClaims;
  card: Card;
  ctx: CardAccessContext;
  fieldId: string;
};

type CustomFieldValueChange = {
  boardId: string;
  cardId: string;
  fieldId: string;
  activity: CoalescedActivityResult;
  automationEffects: AutomationEffects;
};

/** Custom fields are workspace-scoped, so a field id from another workspace is reported as missing. */
async function loadFieldAndCurrentValue(cardId: string, fieldId: string, workspaceId: string) {
  const [field] = await db.select().from(customFields).where(eq(customFields.id, fieldId)).limit(1);
  if (!field || field.workspaceId !== workspaceId) throw notFound("custom field not found");
  const [currentValue] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, cardId), eq(cardCustomFieldValues.fieldId, fieldId)))
    .limit(1);
  return { field, currentValue };
}

type SetCardCustomFieldValueResult =
  | { changed: false; value: CardCustomFieldValue }
  | ({ changed: true; value: CardCustomFieldValue; cols: CustomFieldValueColumns } & CustomFieldValueChange);

/** Set one custom field value on an editable, active card, recording coalesced activity and running change automations. */
export async function setCardCustomFieldValue({
  auth,
  card,
  ctx,
  fieldId,
  body,
}: CustomFieldValueInput & { body: SetCustomFieldValueBody }): Promise<SetCardCustomFieldValueResult> {
  const id = card.id;
  const { field, currentValue } = await loadFieldAndCurrentValue(id, fieldId, ctx.workspaceId);

  // Validate the value against the field type and build the all-null-plus-one columns.
  const cols = await buildCustomFieldValueColumns(field, body, { workspaceId: ctx.workspaceId });

  // Card-detail inputs save on blur, including when their value is unchanged. Match bulk
  // writes: a no-op must not inflate activity counts or trigger change automations.
  if (currentValue && customFieldValueEquals(field.type, currentValue, cols)) return { changed: false, value: currentValue };

  // Resolve human-readable strings for the activity feed (option labels / user names).
  const fromValue = await describeCustomFieldValue(field, currentValue);
  const toValue = await describeCustomFieldValue(field, cols);

  const { value, activity, automationEffects } = await db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    const [updatedValue] = await tx
      .insert(cardCustomFieldValues)
      .values({ cardId: id, fieldId, ...cols, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [cardCustomFieldValues.cardId, cardCustomFieldValues.fieldId],
        set: { ...cols, updatedAt: new Date() },
      })
      .returning();
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    const baseActivity = await recordCoalescedActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
      coalesceKey: `customField:${fieldId}`,
      windowMs: 60_000,
      fromValue,
      toValue,
      payload: { fieldId, fieldName: field.name, fieldType: field.type, fromValue, toValue },
    });
    const effects = await runCustomFieldValueChangedAutomations(tx, {
      cardId: id,
      fieldId,
      previousValue: currentValue,
      currentValue: updatedValue,
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      clientId: ctx.clientId,
      triggerActorId: auth.sub,
    });
    return { value: updatedValue!, activity: baseActivity, automationEffects: effects };
  });
  return { changed: true, value, cols, boardId: card.boardId, cardId: id, fieldId, activity, automationEffects };
}

/** Post-commit fanout for a changed value: the value event, then its feed item, then automation effects. */
export async function emitCardCustomFieldValueSet(result: Extract<SetCardCustomFieldValueResult, { changed: true }>) {
  await emitToBoard(result.boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, {
    boardId: result.boardId,
    cardId: result.cardId,
    fieldId: result.fieldId,
    ...result.cols,
  });
  await emitCoalescedCardActivityFeedItem(result.boardId, result.cardId, result.activity);
  await emitAutomationEffects(result.automationEffects);
}

type ClearCardCustomFieldValueResult = { cleared: false } | ({ cleared: true } & CustomFieldValueChange);

/** Clear one custom field value on an editable, active card, recording coalesced activity and running change automations. */
export async function clearCardCustomFieldValue({ auth, card, ctx, fieldId }: CustomFieldValueInput): Promise<ClearCardCustomFieldValueResult> {
  const id = card.id;
  const { field, currentValue } = await loadFieldAndCurrentValue(id, fieldId, ctx.workspaceId);
  // Repeated blurs of an empty input must not record another clear or trigger automations.
  if (!currentValue) return { cleared: false };

  // Clearing a checkbox returns it to the visible "No" state, which describe collapses
  // to "false"; scalar/select/user clear to null.
  const fromValue = await describeCustomFieldValue(field, currentValue);
  const toValue = await describeCustomFieldValue(field, null);

  const { activity, automationEffects } = await db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await tx
      .delete(cardCustomFieldValues)
      .where(and(eq(cardCustomFieldValues.cardId, id), eq(cardCustomFieldValues.fieldId, fieldId)));
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    const baseActivity = await recordCoalescedActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
      coalesceKey: `customField:${fieldId}`,
      windowMs: 60_000,
      fromValue,
      toValue,
      payload: { fieldId, fieldName: field.name, fieldType: field.type, fromValue, toValue },
    });
    const effects = await runCustomFieldValueChangedAutomations(tx, {
      cardId: id,
      fieldId,
      previousValue: currentValue,
      currentValue: null,
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      clientId: ctx.clientId,
      triggerActorId: auth.sub,
    });
    return { activity: baseActivity, automationEffects: effects };
  });
  return { cleared: true, boardId: card.boardId, cardId: id, fieldId, activity, automationEffects };
}

/** Post-commit fanout for a cleared value: the clear event, then its feed item, then automation effects. */
export async function emitCardCustomFieldValueCleared(result: Extract<ClearCardCustomFieldValueResult, { cleared: true }>) {
  await emitToBoard(result.boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, { boardId: result.boardId, cardId: result.cardId, fieldId: result.fieldId });
  await emitCoalescedCardActivityFeedItem(result.boardId, result.cardId, result.activity);
  await emitAutomationEffects(result.automationEffects);
}
