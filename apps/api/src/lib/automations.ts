import type { WireAutomation, WireCard, WireCardChecklist } from "@kanera/shared/events";
import { SERVER_EVENTS } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  automationActions,
  automationDueDateRuns,
  automationRunStats,
  automationRuns,
  automations,
  boardMembers,
  boards,
  cardAssignees,
  cardCustomFieldValues,
  cardChecklistItems,
  cardChecklists,
  cardLabelAssignments,
  cardLabels,
  cards,
  customFieldOptions,
  customFields,
  lists,
  users,
  workspaceMembers,
  workspaces,
  type ActivityEvent,
  type Automation,
  type AutomationAction,
  type Card,
  type CardCustomFieldValue,
  type CardDueDateSlot,
  type CustomField,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, type Db } from "../db.js";
import { env } from "../env.js";
import { emitToBoard } from "../realtime/emit.js";
import { emitActivityFeedItem, recordActivity } from "./activity.js";
import { enqueueCardAssignedEmails } from "./assignee-email-notifications.js";
import { applyChecklistTemplates } from "./checklist-templates.js";
import { isDueDateOverdue } from "./due-date.js";
import { createMailer } from "./mailer.js";
import { clearOverdueNotificationsForCards } from "./notifications.js";
import { createOverdueNotificationsForCards } from "./overdue-notifications.js";
import { between } from "./position.js";
import { emitCardRebalancedByBoard, rebalanceCards, type CardRebalancedPosition } from "./rebalance.js";
import { resolveSmtpConfig } from "./smtp-resolve.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

interface AutomationEffectMetadata {
  // Automation activity remains system-authored, but user-triggered automation
  // effects still need to suppress notifications back to the initiating user.
  suppressNotificationUserId?: string | null;
}

export type AutomationEffect =
  | ({ type: "labelsSet"; boardId: string; cardId: string; labelIds: string[]; activity: ActivityEvent } & AutomationEffectMetadata)
  | ({ type: "assigneesSet"; boardId: string; cardId: string; assigneeIds: string[]; activity: ActivityEvent } & AutomationEffectMetadata)
  | ({ type: "checklistCreated"; boardId: string; cardId: string; checklist: WireCardChecklist; activity: ActivityEvent } & AutomationEffectMetadata)
  | ({ type: "customFieldValueSet"; boardId: string; cardId: string; fieldId: string; value: CustomFieldValueColumns; activity: ActivityEvent } & AutomationEffectMetadata)
  | ({ type: "cardUpdated"; boardId: string; card: WireCard; activity: ActivityEvent; notify?: boolean } & AutomationEffectMetadata)
  | ({
      type: "cardMoved";
      boardId: string;
      cardId: string;
      fromListId: string;
      toListId: string;
      position: string;
      prevPosition: string;
      rebalancedPositions?: CardRebalancedPosition[] | null;
      activity?: ActivityEvent | null;
    } & AutomationEffectMetadata);

export interface AutomationEffects {
  effects: AutomationEffect[];
}

interface AutomationRunContext {
  card: Card;
  boardId: string;
  workspaceId: string;
  clientId: string;
  fireDateLocalDate: string;
  fireDate: Date;
  triggerActorId?: string | null;
}

export const EMPTY_EFFECTS: AutomationEffects = { effects: [] };
const AUTOMATION_FAILURE_MESSAGE_LIMIT = 500;

type AutomationRunStatsOutcome = "effectful" | "noop" | "failed";

function automationFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, AUTOMATION_FAILURE_MESSAGE_LIMIT);
}

async function recordAutomationRunStats(tx: Tx, automationId: string, outcome: AutomationRunStatsOutcome, err?: unknown): Promise<void> {
  const now = new Date();
  const isEffectful = outcome === "effectful";
  const isNoop = outcome === "noop";
  const isFailed = outcome === "failed";
  const failureMessage = isFailed ? automationFailureMessage(err) : null;
  // Keep append-only history beside the lifetime counters so operational dashboards can report
  // honest daily outcomes; both writes share the caller's transaction for successful/no-op runs.
  await tx.insert(automationRuns).values({ automationId, outcome, ranAt: now });
  await tx
    .insert(automationRunStats)
    .values({
      automationId,
      runCount: 1,
      effectfulRunCount: isEffectful ? 1 : 0,
      noopRunCount: isNoop ? 1 : 0,
      failedRunCount: isFailed ? 1 : 0,
      lastRunAt: now,
      lastEffectfulRunAt: isEffectful ? now : null,
      lastNoopRunAt: isNoop ? now : null,
      lastFailedRunAt: isFailed ? now : null,
      lastFailureMessage: failureMessage,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: automationRunStats.automationId,
      set: {
        runCount: sql`${automationRunStats.runCount} + 1`,
        effectfulRunCount: isEffectful ? sql`${automationRunStats.effectfulRunCount} + 1` : sql`${automationRunStats.effectfulRunCount}`,
        noopRunCount: isNoop ? sql`${automationRunStats.noopRunCount} + 1` : sql`${automationRunStats.noopRunCount}`,
        failedRunCount: isFailed ? sql`${automationRunStats.failedRunCount} + 1` : sql`${automationRunStats.failedRunCount}`,
        lastRunAt: now,
        lastEffectfulRunAt: isEffectful ? now : sql`${automationRunStats.lastEffectfulRunAt}`,
        lastNoopRunAt: isNoop ? now : sql`${automationRunStats.lastNoopRunAt}`,
        lastFailedRunAt: isFailed ? now : sql`${automationRunStats.lastFailedRunAt}`,
        lastFailureMessage: isFailed ? failureMessage : sql`${automationRunStats.lastFailureMessage}`,
        updatedAt: now,
      },
    });
}

async function recordAutomationFailureStats(automationId: string, err: unknown): Promise<void> {
  try {
    await recordAutomationRunStats(db, automationId, "failed", err);
  } catch {
    // Analytics should never mask the original automation failure.
  }
}

type CustomFieldValueColumns = Pick<CardCustomFieldValue, "valueText" | "valueNumber" | "valueCheckbox" | "valueDate" | "valueUrl" | "valueOptionIds" | "valueUserIds">;

function cardUrl(boardId: string, cardId: string): string {
  return new URL(`/b/${boardId}/c/${cardId}`, env.WEB_ORIGIN).toString();
}

function toWireCard(card: Card, _clientId: string): WireCard {
  return {
    ...card,
    url: cardUrl(card.boardId, card.id),
  };
}

function localDateInTimezone(date: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  }
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function localDateTimePartsInTimezone(date: Date, timezone: string): { year: string; month: string; day: string; hour: string; minute: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  }
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function formatAutomationDateText(date: Date, timezone: string, config: { format?: string }): string {
  const parts = localDateTimePartsInTimezone(date, timezone);
  const tokens = {
    yyyy: parts.year,
    MM: parts.month,
    dd: parts.day,
    HH: parts.hour,
    mm: parts.minute,
  } as const;
  const pattern = config.format === "month"
      ? "yyyy-MM"
      : config.format === "datetime"
        ? "yyyy-MM-dd HH:mm"
        : "yyyy-MM-dd";
  return pattern.replace(/yyyy|MM|dd|HH|mm/g, (token) => tokens[token as keyof typeof tokens]);
}

function emptyCustomFieldColumns(): CustomFieldValueColumns {
  return {
    valueText: null,
    valueNumber: null,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
  };
}

function hasCustomFieldValue(field: Pick<CustomField, "type">, value: CardCustomFieldValue | undefined): boolean {
  if (!value) return false;
  if (field.type === "text") return Boolean(value.valueText?.trim());
  if (field.type === "number") return value.valueNumber !== null && value.valueNumber !== undefined;
  if (field.type === "checkbox") return value.valueCheckbox !== null && value.valueCheckbox !== undefined;
  if (field.type === "date") return Boolean(value.valueDate?.trim());
  if (field.type === "url") return Boolean(value.valueUrl?.trim());
  if (field.type === "select") return Boolean(value.valueOptionIds?.length);
  if (field.type === "user") return Boolean(value.valueUserIds?.length);
  return false;
}

function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

// Compares the column we are about to write against the card's current value for the
// field's type only. Null-normalized so an unset value (null) is never treated as equal
// to an explicit false/empty write.
function customFieldColumnsUnchanged(field: Pick<CustomField, "type">, cols: CustomFieldValueColumns, current: CardCustomFieldValue | undefined): boolean {
  if (!current) return false;
  switch (field.type) {
    case "text": return (cols.valueText ?? null) === (current.valueText ?? null);
    case "number": return (cols.valueNumber ?? null) === (current.valueNumber ?? null);
    case "checkbox": return (cols.valueCheckbox ?? null) === (current.valueCheckbox ?? null);
    case "date": return (cols.valueDate ?? null) === (current.valueDate ?? null);
    case "url": return (cols.valueUrl ?? null) === (current.valueUrl ?? null);
    case "select": return arraysEqual(cols.valueOptionIds ?? null, current.valueOptionIds ?? null);
    case "user": return arraysEqual(cols.valueUserIds ?? null, current.valueUserIds ?? null);
    default: return false;
  }
}

async function describeCustomFieldValue(tx: Tx, field: Pick<CustomField, "type">, value: CustomFieldValueColumns | CardCustomFieldValue | undefined): Promise<string | null> {
  if (!value) return null;
  if (field.type === "checkbox") return String(value.valueCheckbox === true);
  if (field.type === "select") {
    const ids = value.valueOptionIds;
    if (!ids?.length) return null;
    const rows = await tx
      .select({ id: customFieldOptions.id, label: customFieldOptions.label })
      .from(customFieldOptions)
      .where(inArray(customFieldOptions.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row.label]));
    return ids.map((optionId) => byId.get(optionId) ?? "?").join(", ") || null;
  }
  if (field.type === "user") {
    const ids = value.valueUserIds;
    if (!ids?.length) return null;
    const rows = await tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row.displayName]));
    return ids.map((userId) => byId.get(userId) ?? "?").join(", ") || null;
  }
  return value.valueText ?? value.valueNumber ?? value.valueDate ?? value.valueUrl ?? null;
}

function customFieldColumnsFromAutomationValue(ctx: AutomationRunContext, action: AutomationAction): CustomFieldValueColumns | null {
  if (!("value" in action.config)) return null;
  const value = action.config.value;
  const cols = emptyCustomFieldColumns();
  if (value.kind === "text") {
    if (!value.text.trim()) return null;
    cols.valueText = value.text;
  } else if (value.kind === "number") {
    // value_number is numeric(unbounded) stored as a string in Drizzle.
    cols.valueNumber = String(value.number);
  } else if (value.kind === "text_current_date") {
    cols.valueText = formatAutomationDateText(ctx.fireDate, ctx.card.dueDateTimezone || "UTC", { format: value.format });
  } else if (value.kind === "date") {
    cols.valueDate = value.source === "current" ? localDateInTimezone(ctx.fireDate, ctx.card.dueDateTimezone || "UTC") : value.date;
  } else if (value.kind === "checkbox") {
    cols.valueCheckbox = value.checked;
  } else if (value.kind === "select") {
    cols.valueOptionIds = value.optionIds.length ? value.optionIds : null;
  } else if (value.kind === "user") {
    cols.valueUserIds = value.userIds.length ? value.userIds : null;
  } else {
    return null;
  }
  return cols;
}

// Resolve the "copy from another field" automation value: read the source field's current
// value on this card and map it onto the target field's columns. Source and target must be the
// same type. Returns null (skip, no write) when the source field is gone, mismatched, or empty
// on the card — mirroring the empty-value skips in customFieldColumnsFromAutomationValue. The
// shared apply-time re-validation in applyPopulateCustomFieldAction still enforces target-field
// option/member liveness and allowMultiple cardinality on the returned columns.
async function customFieldColumnsFromSourceField(
  tx: Tx,
  ctx: AutomationRunContext,
  targetField: Pick<CustomField, "id" | "type" | "allowMultiple">,
  sourceFieldId: string,
): Promise<CustomFieldValueColumns | null> {
  if (sourceFieldId === targetField.id) return null; // copying a field onto itself is a no-op
  const [sourceField] = await tx
    .select()
    .from(customFields)
    .where(and(eq(customFields.id, sourceFieldId), eq(customFields.workspaceId, ctx.workspaceId), isNull(customFields.archivedAt)))
    .limit(1);
  if (!sourceField || sourceField.type !== targetField.type) return null;

  const [sourceValue] = await tx
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, ctx.card.id), eq(cardCustomFieldValues.fieldId, sourceFieldId)))
    .limit(1);
  if (!sourceValue || !hasCustomFieldValue(sourceField, sourceValue)) return null;

  const cols = emptyCustomFieldColumns();
  switch (targetField.type) {
    case "text": cols.valueText = sourceValue.valueText; break;
    case "number": cols.valueNumber = sourceValue.valueNumber; break;
    case "checkbox": cols.valueCheckbox = sourceValue.valueCheckbox; break;
    case "date": cols.valueDate = sourceValue.valueDate; break;
    case "url": cols.valueUrl = sourceValue.valueUrl; break;
    case "user": cols.valueUserIds = sourceValue.valueUserIds; break;
    case "select": {
      // Select options are field-scoped, so option IDs cannot be shared between two fields.
      // Map by label instead: resolve the source card's selected option labels, then find the
      // target field's live options with matching labels. Unmatched labels are dropped.
      const sourceIds = sourceValue.valueOptionIds ?? [];
      if (!sourceIds.length) return null;
      const sourceOptions = await tx
        .select({ id: customFieldOptions.id, label: customFieldOptions.label })
        .from(customFieldOptions)
        .where(inArray(customFieldOptions.id, sourceIds));
      const labelBySourceId = new Map(sourceOptions.map((option) => [option.id, option.label]));
      const targetOptions = await tx
        .select({ id: customFieldOptions.id, label: customFieldOptions.label })
        .from(customFieldOptions)
        .where(and(eq(customFieldOptions.fieldId, targetField.id), isNull(customFieldOptions.archivedAt)));
      const targetIdByLabel = new Map(targetOptions.map((option) => [option.label, option.id]));
      const matched: string[] = [];
      for (const sourceId of sourceIds) {
        const label = labelBySourceId.get(sourceId);
        const targetId = label != null ? targetIdByLabel.get(label) : undefined;
        if (targetId && !matched.includes(targetId)) matched.push(targetId);
      }
      if (!matched.length) return null;
      cols.valueOptionIds = matched;
      break;
    }
    default: return null;
  }
  return cols;
}

function customFieldValueKindMatchesField(field: Pick<CustomField, "type">, action: AutomationAction): boolean {
  if (!("value" in action.config)) return false;
  const kind = action.config.value.kind;
  if (kind === "text" || kind === "text_current_date") return field.type === "text";
  if (kind === "number") return field.type === "number";
  if (kind === "date") return field.type === "date";
  if (kind === "checkbox") return field.type === "checkbox";
  if (kind === "select") return field.type === "select";
  if (kind === "user") return field.type === "user";
  return false;
}

function addDays(localDate: string, days: number): string {
  const [yearString, monthString, dayString] = localDate.split("-");
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function unique(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

export async function loadAutomation(automationId: string, tx: Tx = db): Promise<WireAutomation | null> {
  const [automation] = await tx.select().from(automations).where(eq(automations.id, automationId)).limit(1);
  if (!automation) return null;
  const actions = await tx
    .select()
    .from(automationActions)
    .where(eq(automationActions.automationId, automationId))
    .orderBy(asc(automationActions.position));
  return { ...automation, actions };
}

export async function loadAutomations(workspaceId: string, tx: Tx = db): Promise<WireAutomation[]> {
  const rows = await tx
    .select()
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt)))
    .orderBy(asc(automations.position));
  if (rows.length === 0) return [];
  const actions = await tx
    .select()
    .from(automationActions)
    .where(inArray(automationActions.automationId, rows.map((row) => row.id)))
    .orderBy(asc(automationActions.position));
  const actionsByAutomation = new Map<string, AutomationAction[]>();
  for (const action of actions) {
    const list = actionsByAutomation.get(action.automationId);
    if (list) list.push(action);
    else actionsByAutomation.set(action.automationId, [action]);
  }
  return rows.map((automation) => ({ ...automation, actions: actionsByAutomation.get(automation.id) ?? [] }));
}

// Custom fields are hard-deleted, and populate_custom_field actions reference fields inside their
// jsonb config (no FK), so nothing cascades. When a field is deleted we proactively find any action
// that targets it (`fieldId`) or copies from it (`value.sourceFieldId`), prune those now-inert
// actions, and disable their automations so an admin must re-review before they fire again.
// Returns the ids of the automations that were disabled, so the caller can re-emit them.
export async function disableAutomationsReferencingCustomField(tx: Tx, workspaceId: string, fieldId: string): Promise<string[]> {
  const referencingActions = await tx
    .select({ id: automationActions.id, automationId: automationActions.automationId })
    .from(automationActions)
    .innerJoin(automations, eq(automations.id, automationActions.automationId))
    .where(and(
      eq(automations.workspaceId, workspaceId),
      eq(automationActions.type, "populate_custom_field"),
      sql`(${automationActions.config} ->> 'fieldId' = ${fieldId} OR ${automationActions.config} -> 'value' ->> 'sourceFieldId' = ${fieldId})`,
    ));
  if (referencingActions.length === 0) return [];

  const actionIds = referencingActions.map((row) => row.id);
  const automationIds = Array.from(new Set(referencingActions.map((row) => row.automationId)));
  await tx.delete(automationActions).where(inArray(automationActions.id, actionIds));
  await tx.update(automations).set({ enabled: false, updatedAt: new Date() }).where(inArray(automations.id, automationIds));
  return automationIds;
}

async function validWorkspaceLabels(tx: Tx, workspaceId: string, labelIds: string[]): Promise<{ id: string; name: string }[]> {
  const ids = unique(labelIds);
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: cardLabels.id, name: cardLabels.name })
    .from(cardLabels)
    .where(and(eq(cardLabels.workspaceId, workspaceId), inArray(cardLabels.id, ids), isNull(cardLabels.archivedAt)));
  const labelById = new Map(rows.map((row) => [row.id, row]));
  const validLabels: { id: string; name: string }[] = [];
  for (const id of ids) {
    const label = labelById.get(id);
    if (label) validLabels.push(label);
  }
  return validLabels;
}

async function assignableUserIds(tx: Tx, boardId: string, workspaceId: string, userIds: string[]): Promise<string[]> {
  const ids = unique(userIds);
  if (ids.length === 0) return [];
  // Automations may only assign work to explicit, non-observer members of the target board —
  // board membership is the access model, so a non-member is never a valid assignee.
  const eligible = await tx
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(
      eq(boardMembers.boardId, boardId),
      inArray(boardMembers.userId, ids),
      sql`${boardMembers.role} <> 'observer'::board_role`,
    ));
  const eligibleSet = new Set(eligible.map((row) => row.userId));
  return ids.filter((id) => eligibleSet.has(id));
}

async function applyLabelsAction(tx: Tx, ctx: AutomationRunContext, action: AutomationAction): Promise<AutomationEffect | null> {
  const labelIds = "labelIds" in action.config ? action.config.labelIds : [];
  const validLabels = await validWorkspaceLabels(tx, ctx.workspaceId, labelIds);
  if (validLabels.length === 0) return null;
  const validIds = validLabels.map((label) => label.id);
  const validLabelNameById = new Map(validLabels.map((label) => [label.id, label.name]));
  const current = await tx
    .select({ labelId: cardLabelAssignments.labelId })
    .from(cardLabelAssignments)
    .where(eq(cardLabelAssignments.cardId, ctx.card.id));
  const currentIds = current.map((row) => row.labelId);
  const currentIdSet = new Set(currentIds);
  const nextIds = action.type === "add_labels"
    ? unique([...currentIds, ...validIds])
    : currentIds.filter((id) => !validIds.includes(id));
  if (nextIds.length === currentIds.length && nextIds.every((id) => currentIds.includes(id))) return null;
  const nextIdSet = new Set(nextIds);
  const addedLabelNames = action.type === "add_labels"
    ? validIds
      .filter((id) => !currentIdSet.has(id))
      .map((id) => validLabelNameById.get(id))
      .filter((name): name is string => Boolean(name))
    : [];
  const removedLabelNames = action.type === "remove_labels"
    ? validIds
      .filter((id) => !nextIdSet.has(id))
      .map((id) => validLabelNameById.get(id))
      .filter((name): name is string => Boolean(name))
    : [];

  await tx.delete(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, ctx.card.id));
  if (nextIds.length > 0) {
    await tx.insert(cardLabelAssignments).values(nextIds.map((labelId) => ({ cardId: ctx.card.id, labelId })));
  }
  const activity = await recordActivity(tx, {
    boardId: ctx.boardId,
    workspaceId: ctx.workspaceId,
    actorId: null,
    actorKind: "system",
    entityType: "card",
    entityId: ctx.card.id,
    action: ACTIVITY_ACTION.LABELS_SET,
    payload: {
      labelIds: nextIds,
      labelNames: nextIds
        .map((id) => validLabelNameById.get(id))
        .filter((name): name is string => Boolean(name)),
      addedLabelNames,
      removedLabelNames,
      automationActionId: action.id,
    },
  });
  return { type: "labelsSet", boardId: ctx.boardId, cardId: ctx.card.id, labelIds: nextIds, activity, suppressNotificationUserId: ctx.triggerActorId };
}

async function applyAssigneesAction(tx: Tx, ctx: AutomationRunContext, action: AutomationAction): Promise<AutomationEffect | null> {
  const userIds = "userIds" in action.config ? action.config.userIds : [];
  const validIds = await assignableUserIds(tx, ctx.boardId, ctx.workspaceId, userIds);
  if (validIds.length === 0) return null;
  const current = await tx.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, ctx.card.id));
  const currentIds = current.map((row) => row.userId);
  const nextIds = action.type === "add_assignees"
    ? unique([...currentIds, ...validIds])
    : currentIds.filter((id) => !validIds.includes(id));
  if (nextIds.length === currentIds.length && nextIds.every((id) => currentIds.includes(id))) return null;

  const addedIds = nextIds.filter((id) => !currentIds.includes(id));
  await tx.delete(cardAssignees).where(eq(cardAssignees.cardId, ctx.card.id));
  if (nextIds.length > 0) await tx.insert(cardAssignees).values(nextIds.map((userId) => ({ cardId: ctx.card.id, userId })));
  const activity = await recordActivity(tx, {
    boardId: ctx.boardId,
    workspaceId: ctx.workspaceId,
    actorId: null,
    actorKind: "system",
    entityType: "card",
    entityId: ctx.card.id,
    action: ACTIVITY_ACTION.ASSIGNEES_SET,
    payload: { assigneeIds: nextIds, automationActionId: action.id },
  });
  if (addedIds.length > 0) {
    await enqueueCardAssignedEmails({
      tx,
      mailer: createMailer({
        db: tx as Db,
        resolveSmtpConfig,
        webOrigin: env.WEB_ORIGIN,
        log: { info() { }, error() { }, warn() { }, debug() { } } as never,
      }),
      webOrigin: env.WEB_ORIGIN,
      cardId: ctx.card.id,
      // Assignment notifications should treat the user action that fired the
      // automation as the actor, so assigning yourself via automation is quiet.
      actorId: ctx.triggerActorId ?? ctx.card.createdById,
      recipientUserIds: addedIds,
    }).catch(() => 0);
  }
  return { type: "assigneesSet", boardId: ctx.boardId, cardId: ctx.card.id, assigneeIds: nextIds, activity, suppressNotificationUserId: ctx.triggerActorId };
}

async function applyChecklistsAction(tx: Tx, ctx: AutomationRunContext, action: AutomationAction): Promise<AutomationEffect[]> {
  const templateIds = "templateIds" in action.config ? action.config.templateIds : [];
  if (templateIds.length === 0) return [];
  // Checklist application is ledgered per card/template, so repeated automation
  // runs do not recreate checklists the user has already received or deleted.
  const applied = await applyChecklistTemplates(tx, {
    cardId: ctx.card.id,
    boardId: ctx.boardId,
    workspaceId: ctx.workspaceId,
    actorId: null,
    templateIds,
    automationActionId: action.id,
  });
  return applied.map((item) => ({
    type: "checklistCreated" as const,
    boardId: ctx.boardId,
    cardId: ctx.card.id,
    checklist: item.checklist,
    activity: item.activity,
    suppressNotificationUserId: ctx.triggerActorId,
  }));
}

async function applyDueDateAction(tx: Tx, ctx: AutomationRunContext, action: AutomationAction): Promise<AutomationEffect | null> {
  const previousDueDateLocalDate = ctx.card.dueDateLocalDate;
  const previousDueDateSlot = ctx.card.dueDateSlot;
  const timezone = ctx.card.dueDateTimezone || "UTC";
  const next = action.type === "clear_due_date"
    ? { dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null }
    : {
        dueDateLocalDate: addDays(ctx.fireDateLocalDate, "offsetDays" in action.config ? action.config.offsetDays : 0),
        dueDateSlot: ("slot" in action.config ? action.config.slot : "anyTime") as CardDueDateSlot,
        dueDateTimezone: timezone,
      };
  if (
    previousDueDateLocalDate === next.dueDateLocalDate &&
    previousDueDateSlot === next.dueDateSlot &&
    ctx.card.dueDateTimezone === next.dueDateTimezone
  ) {
    return null;
  }
  const [card] = await tx.update(cards).set({ ...next, updatedAt: new Date() }).where(eq(cards.id, ctx.card.id)).returning();
  ctx.card = card!;
  if (next.dueDateLocalDate) await createOverdueNotificationsForCards(tx, [ctx.card.id]);
  else await clearOverdueNotificationsForCards(tx, [ctx.card.id]);
  const activity = await recordActivity(tx, {
    boardId: ctx.boardId,
    workspaceId: ctx.workspaceId,
    actorId: null,
    actorKind: "system",
    entityType: "card",
    entityId: ctx.card.id,
    action: ACTIVITY_ACTION.UPDATED,
    payload: { ...next, automationActionId: action.id },
  });
  return { type: "cardUpdated", boardId: ctx.boardId, card: toWireCard(card!, ctx.clientId), activity, suppressNotificationUserId: ctx.triggerActorId };
}

async function applyCompletionAction(tx: Tx, ctx: AutomationRunContext, action: AutomationAction): Promise<AutomationEffect | null> {
  const completed = "completed" in action.config ? action.config.completed : false;
  if (Boolean(ctx.card.completedAt) === completed) return null;
  const completedAt = completed ? new Date() : null;
  const [card] = await tx.update(cards).set({ completedAt, updatedAt: new Date() }).where(eq(cards.id, ctx.card.id)).returning();
  ctx.card = card!;
  if (completed) await clearOverdueNotificationsForCards(tx, [ctx.card.id]);
  else await createOverdueNotificationsForCards(tx, [ctx.card.id]);
  const activity = await recordActivity(tx, {
    boardId: ctx.boardId,
    workspaceId: ctx.workspaceId,
    actorId: null,
    actorKind: "system",
    entityType: "card",
    entityId: ctx.card.id,
    action: completed ? ACTIVITY_ACTION.COMPLETED : ACTIVITY_ACTION.UNCOMPLETED,
    payload: { completedAt, automationActionId: action.id },
  });
  return { type: "cardUpdated", boardId: ctx.boardId, card: toWireCard(card!, ctx.clientId), activity, notify: completed, suppressNotificationUserId: ctx.triggerActorId };
}

async function applyMoveAction(tx: Tx, ctx: AutomationRunContext, action: AutomationAction): Promise<AutomationEffect | null> {
  const listId = action.type === "move_to_top" || action.type === "move_to_bottom"
    ? ctx.card.listId
    : "listId" in action.config ? action.config.listId : null;
  const placement = action.type === "move_to_top"
    ? "top"
    : action.type === "move_to_bottom"
      ? "bottom"
      : "placement" in action.config && action.config.placement === "top" ? "top" : "bottom";
  if (!listId) return null;
  if (listId === ctx.card.listId && action.type === "move_to_list" && placement !== "top") return null;
  const [targetList] = await tx
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspaceId, ctx.workspaceId), isNull(lists.archivedAt)))
    // Serialize destination position computation with user and automation moves.
    .for("update")
    .limit(1);
  if (!targetList) return null;
  const [edgeCard] = await tx
    .select({ position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, listId), ne(cards.id, ctx.card.id), isNull(cards.archivedAt)))
    .orderBy(placement === "top" ? asc(cards.position) : desc(cards.position))
    .limit(1);
  const prevPosition = ctx.card.position;
  const fromListId = ctx.card.listId;
  const result = placement === "top"
    ? between(null, edgeCard?.position ?? null)
    : between(edgeCard?.position ?? null, null);
  let position = result.position;
  if (listId === ctx.card.listId && position === ctx.card.position) return null;
  await tx.update(cards).set({ listId, position, updatedAt: new Date() }).where(eq(cards.id, ctx.card.id));
  const rebalancedPositions = result.needsRebalance ? await rebalanceCards(listId, tx) : null;
  if (rebalancedPositions) position = rebalancedPositions.find((row) => row.id === ctx.card.id)?.position ?? position;
  const [card] = await tx.select().from(cards).where(eq(cards.id, ctx.card.id)).limit(1);
  ctx.card = card!;
  const activity = fromListId === listId
    ? null
    : await recordActivity(tx, {
      boardId: ctx.boardId,
      workspaceId: ctx.workspaceId,
      actorId: null,
      actorKind: "system",
      entityType: "card",
      entityId: ctx.card.id,
      action: ACTIVITY_ACTION.MOVED,
      payload: { fromListId, toListId: listId, prevPosition, position, automationActionId: action.id },
    });
  return {
    type: "cardMoved",
    boardId: ctx.boardId,
    cardId: ctx.card.id,
    fromListId,
    toListId: listId,
    position,
    prevPosition,
    rebalancedPositions,
    activity,
    suppressNotificationUserId: ctx.triggerActorId,
  };
}

async function applyPopulateCustomFieldAction(tx: Tx, ctx: AutomationRunContext, action: AutomationAction): Promise<AutomationEffect | null> {
  const fieldId = "fieldId" in action.config ? action.config.fieldId : null;
  if (!fieldId) return null;
  const [field] = await tx
    .select()
    .from(customFields)
    .where(and(eq(customFields.id, fieldId), eq(customFields.workspaceId, ctx.workspaceId), isNull(customFields.archivedAt)))
    .limit(1);
  if (!field) return null;
  const value = "value" in action.config ? action.config.value : null;
  if (!value) return null;
  // Literal/computed values must statically match the target field type. The "field"
  // (copy from another field) kind is instead validated against the source field loaded
  // below, so it is allowed through here.
  if (value.kind !== "field" && !customFieldValueKindMatchesField(field, action)) return null;

  const [currentValue] = await tx
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, ctx.card.id), eq(cardCustomFieldValues.fieldId, fieldId)))
    .limit(1);
  const onlyIfEmpty = "onlyIfEmpty" in action.config ? action.config.onlyIfEmpty : true;
  if (onlyIfEmpty && hasCustomFieldValue(field, currentValue)) return null;

  const cols =
    value.kind === "field"
      ? await customFieldColumnsFromSourceField(tx, ctx, field, value.sourceFieldId)
      : customFieldColumnsFromAutomationValue(ctx, action);
  if (!cols) return null;

  // Automation configs are long-lived: select options can be archived and users can
  // leave the workspace after the action was saved, and a field can be toggled from
  // multi to single. Re-validate at apply time (mirroring applyLabelsAction /
  // applyAssigneesAction) so we never persist dangling or over-cardinality ids.
  if (field.type === "select" && cols.valueOptionIds?.length) {
    const liveOptions = await tx
      .select({ id: customFieldOptions.id })
      .from(customFieldOptions)
      .where(and(eq(customFieldOptions.fieldId, fieldId), inArray(customFieldOptions.id, cols.valueOptionIds), isNull(customFieldOptions.archivedAt)));
    const liveIds = new Set(liveOptions.map((row) => row.id));
    const filtered = cols.valueOptionIds.filter((id) => liveIds.has(id));
    cols.valueOptionIds = filtered.length ? (field.allowMultiple ? filtered : filtered.slice(0, 1)) : null;
    if (!cols.valueOptionIds) return null;
  }
  if (field.type === "user" && cols.valueUserIds?.length) {
    const members = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), inArray(workspaceMembers.userId, cols.valueUserIds)));
    const memberIds = new Set(members.map((row) => row.userId));
    const filtered = cols.valueUserIds.filter((id) => memberIds.has(id));
    cols.valueUserIds = filtered.length ? (field.allowMultiple ? filtered : filtered.slice(0, 1)) : null;
    if (!cols.valueUserIds) return null;
  }

  // Skip no-op writes so a repeatedly-firing trigger (e.g. card re-enters a list with
  // overwrite enabled) does not spam the activity feed and realtime clients with
  // identical values, matching the no-change guards in the other apply* actions.
  if (customFieldColumnsUnchanged(field, cols, currentValue)) return null;

  const now = new Date();

  await tx
    .insert(cardCustomFieldValues)
    .values({ cardId: ctx.card.id, fieldId, ...cols, updatedAt: now })
    .onConflictDoUpdate({
      target: [cardCustomFieldValues.cardId, cardCustomFieldValues.fieldId],
      set: { ...cols, updatedAt: now },
    });
  await tx.update(cards).set({ updatedAt: now }).where(eq(cards.id, ctx.card.id));

  const fromValue = await describeCustomFieldValue(tx, field, currentValue);
  const toValue = await describeCustomFieldValue(tx, field, cols);

  const activity = await recordActivity(tx, {
    boardId: ctx.boardId,
    workspaceId: ctx.workspaceId,
    actorId: null,
    actorKind: "system",
    entityType: "card",
    entityId: ctx.card.id,
    action: ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
    payload: {
      fieldId,
      fieldName: field.name,
      fieldType: field.type,
      fromValue,
      toValue,
      automationActionId: action.id,
    },
  });
  return { type: "customFieldValueSet", boardId: ctx.boardId, cardId: ctx.card.id, fieldId, value: cols, activity, suppressNotificationUserId: ctx.triggerActorId };
}

async function applyAutomationActions(tx: Tx, ctx: AutomationRunContext, actions: AutomationAction[]): Promise<AutomationEffects> {
  const effects: AutomationEffect[] = [];
  for (const action of actions) {
    if (action.type === "apply_checklists") {
      effects.push(...await applyChecklistsAction(tx, ctx, action));
      continue;
    }
    const effect =
      action.type === "add_labels" || action.type === "remove_labels"
        ? await applyLabelsAction(tx, ctx, action)
        : action.type === "add_assignees" || action.type === "remove_assignees"
          ? await applyAssigneesAction(tx, ctx, action)
          : action.type === "set_due_date" || action.type === "clear_due_date"
            ? await applyDueDateAction(tx, ctx, action)
            : action.type === "set_completion"
              ? await applyCompletionAction(tx, ctx, action)
              : action.type === "move_to_list" || action.type === "move_to_top" || action.type === "move_to_bottom"
                ? await applyMoveAction(tx, ctx, action)
                : action.type === "populate_custom_field"
                  ? await applyPopulateCustomFieldAction(tx, ctx, action)
                  : null;
    if (effect) effects.push(effect);
  }
  return { effects };
}

async function applyAutomationActionsAndRecordStats(tx: Tx, automationId: string, ctx: AutomationRunContext, actions: AutomationAction[]): Promise<AutomationEffects> {
  try {
    const result = await applyAutomationActions(tx, ctx, actions);
    await recordAutomationRunStats(tx, automationId, result.effects.length > 0 ? "effectful" : "noop");
    return result;
  } catch (err) {
    await recordAutomationFailureStats(automationId, err);
    throw err;
  }
}

export async function runListEntryAutomations(
  tx: Tx,
  opts: { cardId: string; listId: string; boardId: string; workspaceId: string; clientId: string; trigger: "create" | "move"; triggerActorId?: string | null },
): Promise<AutomationEffects> {
  const triggerColumn = opts.trigger === "create" ? automations.applyOnCreate : automations.applyOnMove;
  const rows = await tx
    .select()
    .from(automations)
    .where(and(
      eq(automations.workspaceId, opts.workspaceId),
      eq(automations.enabled, true),
      isNull(automations.archivedAt),
      eq(automations.triggerType, "card_enters_list"),
      eq(automations.triggerListId, opts.listId),
      eq(triggerColumn, true),
    ))
    .orderBy(asc(automations.position));
  if (rows.length === 0) return EMPTY_EFFECTS;
  const actions = await tx
    .select()
    .from(automationActions)
    .where(inArray(automationActions.automationId, rows.map((row) => row.id)))
    .orderBy(asc(automationActions.position));
  const actionsByAutomation = new Map<string, AutomationAction[]>();
  for (const action of actions) {
    const list = actionsByAutomation.get(action.automationId);
    if (list) list.push(action);
    else actionsByAutomation.set(action.automationId, [action]);
  }
  const [card] = await tx.select().from(cards).where(eq(cards.id, opts.cardId)).limit(1);
  if (!card) return EMPTY_EFFECTS;
  const ctx: AutomationRunContext = {
    card,
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    fireDateLocalDate: localDateInTimezone(new Date(), card.dueDateTimezone || "UTC"),
    fireDate: new Date(),
    triggerActorId: opts.triggerActorId,
  };
  const effects: AutomationEffect[] = [];
  for (const automation of rows) {
    const automationActions = actionsByAutomation.get(automation.id);
    if (!automationActions?.length) continue;
    const result = await applyAutomationActionsAndRecordStats(tx, automation.id, ctx, automationActions);
    effects.push(...result.effects);
  }
  return { effects };
}

export async function runChecklistCompletionAutomations(
  tx: Tx,
  opts: { cardId: string; boardId: string; workspaceId: string; clientId: string; triggerActorId?: string | null },
): Promise<AutomationEffects> {
  const rows = await tx
    .select()
    .from(automations)
    .where(and(
      eq(automations.workspaceId, opts.workspaceId),
      eq(automations.enabled, true),
      isNull(automations.archivedAt),
      eq(automations.triggerType, "all_checklist_items_complete"),
    ))
    .orderBy(asc(automations.position));
  if (rows.length === 0) return EMPTY_EFFECTS;

  const items = await tx
    .select({ completedAt: cardChecklistItems.completedAt })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .where(eq(cardChecklists.cardId, opts.cardId));
  if (items.length === 0 || items.some((item) => !item.completedAt)) return EMPTY_EFFECTS;

  const actions = await tx
    .select()
    .from(automationActions)
    .where(inArray(automationActions.automationId, rows.map((row) => row.id)))
    .orderBy(asc(automationActions.position));
  const actionsByAutomation = new Map<string, AutomationAction[]>();
  for (const action of actions) {
    const list = actionsByAutomation.get(action.automationId);
    if (list) list.push(action);
    else actionsByAutomation.set(action.automationId, [action]);
  }
  const [card] = await tx.select().from(cards).where(eq(cards.id, opts.cardId)).limit(1);
  if (!card) return EMPTY_EFFECTS;
  const ctx: AutomationRunContext = {
    card,
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    fireDateLocalDate: localDateInTimezone(new Date(), card.dueDateTimezone || "UTC"),
    fireDate: new Date(),
    triggerActorId: opts.triggerActorId,
  };
  const effects: AutomationEffect[] = [];
  for (const automation of rows) {
    const automationActions = actionsByAutomation.get(automation.id);
    if (!automationActions?.length) continue;
    const result = await applyAutomationActionsAndRecordStats(tx, automation.id, ctx, automationActions);
    effects.push(...result.effects);
  }
  return { effects };
}

export async function runCardMarkedCompleteAutomations(
  tx: Tx,
  opts: { cardId: string; boardId: string; workspaceId: string; clientId: string; triggerActorId?: string | null },
): Promise<AutomationEffects> {
  // This runner is called only by user/API completion routes. Completion performed
  // inside an automation action must not recursively trigger more automations.
  const rows = await tx
    .select()
    .from(automations)
    .where(and(
      eq(automations.workspaceId, opts.workspaceId),
      eq(automations.enabled, true),
      isNull(automations.archivedAt),
      eq(automations.triggerType, "card_marked_complete"),
    ))
    .orderBy(asc(automations.position));
  if (rows.length === 0) return EMPTY_EFFECTS;

  const actions = await tx
    .select()
    .from(automationActions)
    .where(inArray(automationActions.automationId, rows.map((row) => row.id)))
    .orderBy(asc(automationActions.position));
  const actionsByAutomation = new Map<string, AutomationAction[]>();
  for (const action of actions) {
    const list = actionsByAutomation.get(action.automationId);
    if (list) list.push(action);
    else actionsByAutomation.set(action.automationId, [action]);
  }
  const [card] = await tx.select().from(cards).where(eq(cards.id, opts.cardId)).limit(1);
  if (!card?.completedAt) return EMPTY_EFFECTS;
  const ctx: AutomationRunContext = {
    card,
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    fireDateLocalDate: localDateInTimezone(new Date(), card.dueDateTimezone || "UTC"),
    fireDate: new Date(),
    triggerActorId: opts.triggerActorId,
  };
  const effects: AutomationEffect[] = [];
  for (const automation of rows) {
    const automationActions = actionsByAutomation.get(automation.id);
    if (!automationActions?.length) continue;
    const result = await applyAutomationActionsAndRecordStats(tx, automation.id, ctx, automationActions);
    effects.push(...result.effects);
  }
  return { effects };
}

export async function runCardAssignedAutomations(
  tx: Tx,
  opts: { cardId: string; addedUserIds: string[]; boardId: string; workspaceId: string; clientId: string; triggerActorId?: string | null },
): Promise<AutomationEffects> {
  const addedUserIdSet = new Set(opts.addedUserIds);
  if (addedUserIdSet.size === 0) return EMPTY_EFFECTS;
  const rows = (await tx
    .select()
    .from(automations)
    .where(and(
      eq(automations.workspaceId, opts.workspaceId),
      eq(automations.enabled, true),
      isNull(automations.archivedAt),
      eq(automations.triggerType, "card_assigned_to_user"),
    ))
    .orderBy(asc(automations.position)))
    .filter((automation) => (automation.triggerUserIds ?? []).some((userId) => addedUserIdSet.has(userId)));
  if (rows.length === 0) return EMPTY_EFFECTS;

  const actions = await tx
    .select()
    .from(automationActions)
    .where(inArray(automationActions.automationId, rows.map((row) => row.id)))
    .orderBy(asc(automationActions.position));
  const actionsByAutomation = new Map<string, AutomationAction[]>();
  for (const action of actions) {
    const list = actionsByAutomation.get(action.automationId);
    if (list) list.push(action);
    else actionsByAutomation.set(action.automationId, [action]);
  }
  const [card] = await tx.select().from(cards).where(eq(cards.id, opts.cardId)).limit(1);
  if (!card) return EMPTY_EFFECTS;
  const ctx: AutomationRunContext = {
    card,
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    fireDateLocalDate: localDateInTimezone(new Date(), card.dueDateTimezone || "UTC"),
    fireDate: new Date(),
    triggerActorId: opts.triggerActorId,
  };
  const effects: AutomationEffect[] = [];
  for (const automation of rows) {
    const automationActions = actionsByAutomation.get(automation.id);
    if (!automationActions?.length) continue;
    const result = await applyAutomationActionsAndRecordStats(tx, automation.id, ctx, automationActions);
    effects.push(...result.effects);
  }
  return { effects };
}

export async function runCardLabelSetAutomations(
  tx: Tx,
  opts: { cardId: string; addedLabelIds: string[]; boardId: string; workspaceId: string; clientId: string; triggerActorId?: string | null },
): Promise<AutomationEffects> {
  const addedLabelIdSet = new Set(opts.addedLabelIds);
  if (addedLabelIdSet.size === 0) return EMPTY_EFFECTS;
  const rows = await tx
    .select()
    .from(automations)
    .where(and(
      eq(automations.workspaceId, opts.workspaceId),
      eq(automations.enabled, true),
      isNull(automations.archivedAt),
      eq(automations.triggerType, "card_label_set"),
      inArray(automations.triggerLabelId, Array.from(addedLabelIdSet)),
    ))
    .orderBy(asc(automations.position));
  if (rows.length === 0) return EMPTY_EFFECTS;

  const actions = await tx
    .select()
    .from(automationActions)
    .where(inArray(automationActions.automationId, rows.map((row) => row.id)))
    .orderBy(asc(automationActions.position));
  const actionsByAutomation = new Map<string, AutomationAction[]>();
  for (const action of actions) {
    const list = actionsByAutomation.get(action.automationId);
    if (list) list.push(action);
    else actionsByAutomation.set(action.automationId, [action]);
  }
  const [card] = await tx.select().from(cards).where(eq(cards.id, opts.cardId)).limit(1);
  if (!card) return EMPTY_EFFECTS;
  const ctx: AutomationRunContext = {
    card,
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    fireDateLocalDate: localDateInTimezone(new Date(), card.dueDateTimezone || "UTC"),
    fireDate: new Date(),
    triggerActorId: opts.triggerActorId,
  };
  const effects: AutomationEffect[] = [];
  for (const automation of rows) {
    const actionsForAutomation = actionsByAutomation.get(automation.id);
    if (!actionsForAutomation?.length) continue;
    const result = await applyAutomationActionsAndRecordStats(tx, automation.id, ctx, actionsForAutomation);
    effects.push(...result.effects);
  }
  return { effects };
}

export async function emitAutomationEffects(effects: AutomationEffects): Promise<void> {
  for (const effect of effects.effects) {
    // Awaits here preserve authored automation effect order in the durable outbox/webhook replay.
    // emitToBoard/emitActivityFeedItem still log publish failures and resolve, so realtime remains fail-open.
    if (effect.type === "labelsSet") {
      await emitToBoard(effect.boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId: effect.boardId, cardId: effect.cardId, labelIds: effect.labelIds });
      await emitActivityFeedItem(effect.boardId, effect.cardId, effect.activity, { suppressNotificationUserId: effect.suppressNotificationUserId });
    } else if (effect.type === "assigneesSet") {
      await emitToBoard(effect.boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId: effect.boardId, cardId: effect.cardId, assigneeIds: effect.assigneeIds });
      await emitActivityFeedItem(effect.boardId, effect.cardId, effect.activity, { suppressNotificationUserId: effect.suppressNotificationUserId });
    } else if (effect.type === "checklistCreated") {
      await emitToBoard(effect.boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId: effect.boardId, cardId: effect.cardId, checklist: effect.checklist });
      await emitActivityFeedItem(effect.boardId, effect.cardId, effect.activity, { suppressNotificationUserId: effect.suppressNotificationUserId });
    } else if (effect.type === "customFieldValueSet") {
      await emitToBoard(effect.boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, {
        boardId: effect.boardId,
        cardId: effect.cardId,
        fieldId: effect.fieldId,
        ...effect.value,
      });
      await emitActivityFeedItem(effect.boardId, effect.cardId, effect.activity, { suppressNotificationUserId: effect.suppressNotificationUserId });
    } else if (effect.type === "cardUpdated") {
      await emitToBoard(effect.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: effect.boardId, card: effect.card });
      await emitActivityFeedItem(effect.boardId, effect.card.id, effect.activity, { notify: effect.notify, suppressNotificationUserId: effect.suppressNotificationUserId });
    } else {
      if (effect.rebalancedPositions) {
        await emitCardRebalancedByBoard(effect.toListId, effect.rebalancedPositions);
      }
      await emitToBoard(effect.boardId, SERVER_EVENTS.CARD_MOVED, {
        boardId: effect.boardId,
        cardId: effect.cardId,
        fromListId: effect.fromListId,
        toListId: effect.toListId,
        position: effect.position,
        prevPosition: effect.prevPosition,
      });
      if (effect.activity) await emitActivityFeedItem(effect.boardId, effect.cardId, effect.activity, { suppressNotificationUserId: effect.suppressNotificationUserId });
    }
  }
}

// Cards are paged through in keyset batches of this size rather than a single capped
// query, so every overdue candidate is eventually processed regardless of backlog size.
const DUE_DATE_SWEEP_BATCH_SIZE = 500;

interface DueDateWorkspaceAutomation {
  automation: Automation;
  actions: AutomationAction[];
}

interface DueDateCandidate {
  card: Card;
  workspaceId: string;
  clientId: string;
}

export async function runDueDateAutomationSweep(
  log?: FastifyBaseLogger,
  now = new Date(),
  batchSize = DUE_DATE_SWEEP_BATCH_SIZE,
): Promise<number> {
  // Broad SQL prefilter: include tomorrow in UTC so timezone-specific due-date
  // boundaries are decided by isDueDateOverdue without starving overdue cards.
  const cutoffLocalDate = addDays(localDateInTimezone(now, "UTC"), 1);

  // Per-workspace due-date automations + actions, cached across batches. One workspace
  // can own many overdue cards spanning several batches, and its automation set is
  // bounded by AUTOMATION_LIMIT, so we load each workspace once and reuse it. A
  // workspace with no due-date automations is cached as [] to avoid re-querying.
  const automationsByWorkspace = new Map<string, DueDateWorkspaceAutomation[]>();
  const ensureWorkspacesLoaded = async (workspaceIds: string[]): Promise<void> => {
    const missing = workspaceIds.filter((id) => !automationsByWorkspace.has(id));
    if (missing.length === 0) return;
    for (const id of missing) automationsByWorkspace.set(id, []);
    const dueAutomations = await db
      .select()
      .from(automations)
      .where(and(
        inArray(automations.workspaceId, missing),
        eq(automations.enabled, true),
        isNull(automations.archivedAt),
        eq(automations.triggerType, "due_date_arrives"),
      ))
      .orderBy(asc(automations.workspaceId), asc(automations.position));
    if (dueAutomations.length === 0) return;
    const actions = await db
      .select()
      .from(automationActions)
      .where(inArray(automationActions.automationId, dueAutomations.map((automation) => automation.id)))
      .orderBy(asc(automationActions.position));
    const actionsByAutomation = new Map<string, AutomationAction[]>();
    for (const action of actions) {
      const list = actionsByAutomation.get(action.automationId);
      if (list) list.push(action);
      else actionsByAutomation.set(action.automationId, [action]);
    }
    for (const automation of dueAutomations) {
      automationsByWorkspace.get(automation.workspaceId)!.push({
        automation,
        actions: actionsByAutomation.get(automation.id) ?? [],
      });
    }
  };

  // A set_due_date action can push a card's due date forward, moving it ahead of the
  // keyset cursor so it would otherwise reappear in a later batch. Tracking handled
  // cards keeps each card processed at most once per sweep (the prior snapshot semantics).
  const seen = new Set<string>();
  let ran = 0;
  let cursorDate: string | null = null;
  let cursorId: string | null = null;

  for (;;) {
    // Keyset pagination over (due_date_local_date, id) — exactly the column order of
    // cards_active_incomplete_due_date_idx, so each batch is an index range scan with
    // no growing OFFSET cost.
    const afterCursor: SQL | undefined = cursorDate !== null && cursorId !== null
      ? sql`(${cards.dueDateLocalDate}, ${cards.id}) > (${cursorDate}::date, ${cursorId}::uuid)`
      : undefined;
    const candidates: DueDateCandidate[] = await db
      .select({
        card: cards,
        workspaceId: lists.workspaceId,
        clientId: workspaces.clientId,
      })
      .from(cards)
      .innerJoin(lists, eq(lists.id, cards.listId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, lists.workspaceId))
      .where(and(
        isNull(cards.archivedAt),
        isNull(cards.completedAt),
        isNull(lists.archivedAt),
        isNull(boards.archivedAt),
        sql`${cards.dueDateLocalDate} is not null`,
        sql`${cards.dueDateLocalDate} <= ${cutoffLocalDate}`,
        afterCursor,
        sql`exists (
          select 1 from automation a
          inner join automation_action aa on aa.automation_id = a.id
          where a.workspace_id = ${lists.workspaceId}
            and a.enabled = true
            and a.archived_at is null
            and a.trigger_type = 'due_date_arrives'
        )`,
      ))
      .orderBy(asc(cards.dueDateLocalDate), asc(cards.id))
      .limit(batchSize);
    if (candidates.length === 0) break;

    // Advance the cursor before any per-card mutation so the next batch resumes after
    // this batch's last row even if actions change due dates mid-sweep.
    const last = candidates[candidates.length - 1]!;
    cursorDate = last.card.dueDateLocalDate;
    cursorId = last.card.id;

    await ensureWorkspacesLoaded(Array.from(new Set(candidates.map((candidate) => candidate.workspaceId))));

    for (const candidate of candidates) {
      if (seen.has(candidate.card.id)) continue;
      seen.add(candidate.card.id);
      if (!isDueDateOverdue(candidate.card, now) || !candidate.card.dueDateLocalDate) continue;
      for (const { automation, actions: automationActions } of automationsByWorkspace.get(candidate.workspaceId) ?? []) {
        if (!automationActions.length) continue;
        try {
          const effects = await db.transaction(async (tx) => {
            const [existing] = await tx
              .select()
              .from(automationDueDateRuns)
              .where(and(eq(automationDueDateRuns.automationId, automation.id), eq(automationDueDateRuns.cardId, candidate.card.id)))
              .limit(1);
            if (existing?.dueDateLocalDate === candidate.card.dueDateLocalDate) return EMPTY_EFFECTS;
            const [card] = await tx.select().from(cards).where(eq(cards.id, candidate.card.id)).limit(1);
            if (!card?.dueDateLocalDate || !isDueDateOverdue(card, now)) return EMPTY_EFFECTS;
            const result = await applyAutomationActionsAndRecordStats(tx, automation.id, {
              card,
              boardId: card.boardId,
              workspaceId: candidate.workspaceId,
              clientId: candidate.clientId,
              fireDateLocalDate: card.dueDateLocalDate,
              fireDate: now,
            }, automationActions);
            await tx
              .insert(automationDueDateRuns)
              .values({ automationId: automation.id, cardId: card.id, dueDateLocalDate: card.dueDateLocalDate })
              .onConflictDoUpdate({
                target: [automationDueDateRuns.automationId, automationDueDateRuns.cardId],
                set: { dueDateLocalDate: card.dueDateLocalDate, firedAt: new Date() },
              });
            return result;
          });
          if (effects.effects.length > 0) {
            await emitAutomationEffects(effects);
            ran += 1;
          }
        } catch (err) {
          log?.error({ err, automationId: automation.id, cardId: candidate.card.id }, "due date automation failed");
        }
      }
    }

    // A short final page means the index range is exhausted; stop without an extra
    // empty round-trip.
    if (candidates.length < batchSize) break;
  }
  return ran;
}

export function startDueDateAutomationScheduler(log?: FastifyBaseLogger): () => void {
  const dueDateSweep = startSweepScheduler({
    name: "due-date-automation",
    task: () => runDueDateAutomationSweep(log),
    nextDelayMs: 60 * 60 * 1000,
    log,
  });
  const cleanup = startSweepScheduler({
    name: "automation-run-cleanup",
    task: () => cleanupAutomationRuns(log),
    nextDelayMs: 24 * 60 * 60 * 1000,
    log,
  });
  return () => {
    dueDateSweep.stop();
    cleanup.stop();
  };
}

export async function cleanupAutomationRuns(log?: FastifyBaseLogger, now = new Date()): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  // Lifetime counters remain in automation_run_stats; only the high-volume daily history expires.
  const deleted = await db.delete(automationRuns).where(lt(automationRuns.ranAt, cutoff)).returning({ id: automationRuns.id });
  if (deleted.length > 0) log?.info({ deletedCount: deleted.length }, "purged old automation run rows");
  return deleted.length;
}
