import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardCustomFieldValues, cards, customFields } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type TxOnly } from "../../db.js";
import type { assertBoardAccess } from "../../lib/access.js";
import { recordCoalescedActivity, type CoalescedActivityResult } from "../../lib/activity.js";
import { emitAutomationEffects, runCustomFieldValueChangedAutomations, type AutomationEffects } from "../../lib/automations.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { assertValidOptionIds, assertWorkspaceMemberIds, buildCustomFieldValueColumns, customFieldValueEquals, describeCustomFieldValue, emptyValueColumns, hasCustomFieldValue, type CustomFieldValueColumns } from "../../lib/custom-fields.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { emitToBoard } from "../../realtime/emit.js";
import { emitCoalescedCardActivityFeedItem, orderedUniqueIds, sortedIds } from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;
type Card = typeof cards.$inferSelect;
type CustomField = typeof customFields.$inferSelect;

type BulkCustomFieldChanges = {
  set: { value: typeof cardCustomFieldValues.$inferSelect; activity: CoalescedActivityResult; automationEffects: AutomationEffects }[];
  cleared: { cardId: string; activity: CoalescedActivityResult; automationEffects: AutomationEffects }[];
};

/** Loads the workspace's field and rejects modes its type does not support. */
export async function loadBulkCustomField(ctx: BoardAccessContext, body: dto.BulkSetCardCustomFieldBody): Promise<CustomField> {
  const [field] = await db.select().from(customFields).where(eq(customFields.id, body.fieldId)).limit(1);
  if (!field || field.workspaceId !== ctx.workspaceId) throw notFound("custom field not found");

  // Mode ↔ type compatibility: add/remove tri-state operates on multi-value select/user only;
  // setAll/fillEmpty write a whole value (scalar + single-value select/user); clear applies to all.
  const isMultiValue = (field.type === "select" || field.type === "user") && field.allowMultiple;
  if ((body.mode === "add" || body.mode === "remove") && !isMultiValue)
    throw badRequest("add/remove is only valid for multi-value select or user fields");
  if ((body.mode === "setAll" || body.mode === "fillEmpty") && isMultiValue)
    throw badRequest("use add/remove for multi-value fields");
  return field;
}

/**
 * Bulk-sets one custom field across the given active cards. Mirrors the single-card PUT/DELETE
 * path: per changed card we upsert/delete the value and record a coalesced bulk activity entry.
 */
export async function setBulkCardCustomField({
  auth,
  ctx,
  boardId,
  field,
  cards: targetCards,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  field: CustomField;
  cards: Card[];
  body: dto.BulkSetCardCustomFieldBody;
}): Promise<BulkCustomFieldChanges> {
  // Validate/build the whole-value target once for setAll/fillEmpty, and validate the
  // incoming ids once for add/remove. The per-card loop below only diffs and merges.
  const multiColumnKey = field.type === "user" ? "valueUserIds" : "valueOptionIds";
  let setCols: CustomFieldValueColumns | null = null;
  if (body.mode === "setAll" || body.mode === "fillEmpty") {
    setCols = await buildCustomFieldValueColumns(field, body, { workspaceId: ctx.workspaceId });
  }
  let deltaIds: string[] = [];
  if (body.mode === "add" || body.mode === "remove") {
    deltaIds = orderedUniqueIds((field.type === "user" ? body.valueUserIds : body.valueOptionIds) ?? []);
    if (deltaIds.length === 0) throw badRequest("provide ids to add or remove");
    if (field.type === "user") await assertWorkspaceMemberIds(ctx.workspaceId, deltaIds);
    else await assertValidOptionIds(field.id, deltaIds);
  }

  const recordCustomFieldActivity = (tx: TxOnly, cardId: string, fromValue: string | null, toValue: string | null) =>
    recordCoalescedActivity(tx, {
      boardId,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: cardId,
      action: ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
      coalesceKey: `customField:${field.id}`,
      windowMs: 60_000,
      fromValue,
      toValue,
      payload: { fieldId: field.id, fieldName: field.name, fieldType: field.type, fromValue, toValue, bulk: true },
    });
  const clearedToValue = await describeCustomFieldValue(field, null);
  return db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await lockCardsForWrite(tx, targetCards.map((card) => card.id));
    const set: BulkCustomFieldChanges["set"] = [];
    const cleared: BulkCustomFieldChanges["cleared"] = [];
    for (const card of targetCards) {
      const [currentValue] = await tx
        .select()
        .from(cardCustomFieldValues)
        .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
        .limit(1);

      // Resolve the next columns (or a clear) for this card.
      let nextCols: CustomFieldValueColumns | null;
      if (body.mode === "clear") {
        nextCols = null;
      } else if (body.mode === "setAll") {
        nextCols = setCols;
      } else if (body.mode === "fillEmpty") {
        // Only write cards with no existing value; leave populated cards untouched.
        if (hasCustomFieldValue(field.type, currentValue)) continue;
        nextCols = setCols;
      } else {
        // add / remove on a multi-value id array.
        const current = (currentValue?.[multiColumnKey] as string[] | null) ?? [];
        const currentSet = new Set(current);
        const deltaSet = new Set(deltaIds);
        const nextIds = body.mode === "add"
          ? [...current, ...deltaIds.filter((idv) => !currentSet.has(idv))]
          : current.filter((idv) => !deltaSet.has(idv));
        if (sortedIds(current).join("\0") === sortedIds(nextIds).join("\0")) continue;
        // Removing the last id clears the row entirely.
        nextCols = nextIds.length === 0 ? null : { ...emptyValueColumns(), [multiColumnKey]: nextIds };
      }

      const fromValue = await describeCustomFieldValue(field, currentValue, tx);

      if (nextCols === null) {
        if (!currentValue) continue; // nothing to clear
        await tx
          .delete(cardCustomFieldValues)
          .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)));
        await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, card.id));
        const activity = await recordCustomFieldActivity(tx, card.id, fromValue, clearedToValue);
        const automationEffects = await runCustomFieldValueChangedAutomations(tx, {
          cardId: card.id,
          fieldId: field.id,
          previousValue: currentValue,
          currentValue: null,
          boardId,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          triggerActorId: auth.sub,
        });
        cleared.push({ cardId: card.id, activity, automationEffects });
        continue;
      }

      // Skip no-op writes (e.g. setAll to an already-identical value).
      if (currentValue && customFieldValueEquals(field.type, currentValue, nextCols)) continue;
      const [value] = await tx
        .insert(cardCustomFieldValues)
        .values({ cardId: card.id, fieldId: field.id, ...nextCols, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [cardCustomFieldValues.cardId, cardCustomFieldValues.fieldId],
          set: { ...nextCols, updatedAt: new Date() },
        })
        .returning();
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, card.id));
      const toValue = await describeCustomFieldValue(field, nextCols, tx);
      const activity = await recordCustomFieldActivity(tx, card.id, fromValue, toValue);
      const automationEffects = await runCustomFieldValueChangedAutomations(tx, {
        cardId: card.id,
        fieldId: field.id,
        previousValue: currentValue,
        currentValue: value,
        boardId,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        triggerActorId: auth.sub,
      });
      set.push({ value: value!, activity, automationEffects });
    }
    return { set, cleared };
  });
}

/**
 * Post-commit fanout for `setBulkCardCustomField`: one card:customFieldValue:set|cleared event per
 * card (reconciled by BoardState), its coalesced feed item, then its automations.
 */
export async function emitBulkCardCustomField(changes: BulkCustomFieldChanges, opts: { boardId: string; field: CustomField }): Promise<void> {
  const { boardId, field } = opts;
  for (const { value, activity, automationEffects } of changes.set) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, {
      boardId,
      cardId: value.cardId,
      fieldId: field.id,
      valueText: value.valueText,
      valueNumber: value.valueNumber,
      valueCheckbox: value.valueCheckbox,
      valueDate: value.valueDate,
      valueUrl: value.valueUrl,
      valueOptionIds: value.valueOptionIds,
      valueUserIds: value.valueUserIds,
    });
    await emitCoalescedCardActivityFeedItem(boardId, value.cardId, activity);
    await emitAutomationEffects(automationEffects);
  }
  for (const { cardId, activity, automationEffects } of changes.cleared) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, { boardId, cardId, fieldId: field.id });
    await emitCoalescedCardActivityFeedItem(boardId, cardId, activity);
    await emitAutomationEffects(automationEffects);
  }
}
