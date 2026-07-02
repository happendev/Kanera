import type { WireCustomField, WireCustomFieldOption } from "@kanera/shared/events";
import type { CardCustomFieldValue, CustomField, CustomFieldType } from "@kanera/shared/schema";
import { customFieldOptions, customFields, users, workspaceMembers } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { badRequest } from "./errors.js";

// Accepts the base connection or an open transaction, so these helpers can run inside
// a bulk `db.transaction(...)` as well as on their own.
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Active options for a single field, ordered by position. */
export async function loadFieldOptions(fieldId: string, tx: Db = db): Promise<WireCustomFieldOption[]> {
  return tx
    .select()
    .from(customFieldOptions)
    .where(and(eq(customFieldOptions.fieldId, fieldId), isNull(customFieldOptions.archivedAt)))
    .orderBy(asc(customFieldOptions.position));
}

/** Attach active options to already-loaded field rows, producing wire fields. */
export async function attachFieldOptions(fields: CustomField[], tx: Db = db): Promise<WireCustomField[]> {
  if (fields.length === 0) return [];
  const optionRows = await tx
    .select()
    .from(customFieldOptions)
    .where(and(inArray(customFieldOptions.fieldId, fields.map((f) => f.id)), isNull(customFieldOptions.archivedAt)))
    .orderBy(asc(customFieldOptions.position));
  const byField = new Map<string, WireCustomFieldOption[]>();
  for (const option of optionRows) {
    const list = byField.get(option.fieldId);
    if (list) list.push(option);
    else byField.set(option.fieldId, [option]);
  }
  return fields.map((field) => ({ ...field, options: byField.get(field.id) ?? [] }));
}

/** Load a workspace's active custom fields with their options as wire fields. */
export async function loadWorkspaceCustomFields(workspaceId: string, tx: Db = db): Promise<WireCustomField[]> {
  const fields = await tx
    .select()
    .from(customFields)
    .where(and(eq(customFields.workspaceId, workspaceId), isNull(customFields.archivedAt)))
    .orderBy(asc(customFields.position));
  return attachFieldOptions(fields, tx);
}

/** Build a single wire field from a row plus its options (empty for non-select types). */
export function toWireCustomField(field: CustomField, options: WireCustomFieldOption[]): WireCustomField {
  return { ...field, options };
}

// The typed value column that backs each custom field type. Kept here (not in the
// route module) so the single-card and bulk write paths share one source of truth.
export const CUSTOM_FIELD_VALUE_COLUMN_BY_TYPE = {
  text: "valueText",
  number: "valueNumber",
  checkbox: "valueCheckbox",
  date: "valueDate",
  url: "valueUrl",
  select: "valueOptionIds",
  user: "valueUserIds",
} as const satisfies Record<CustomFieldType, keyof CardCustomFieldValue>;

export const CUSTOM_FIELD_VALUE_COLUMNS = [
  "valueText",
  "valueNumber",
  "valueCheckbox",
  "valueDate",
  "valueUrl",
  "valueOptionIds",
  "valueUserIds",
] as const satisfies readonly (keyof CardCustomFieldValue)[];

/** All-null value columns for a custom field value row. */
export type CustomFieldValueColumns = {
  valueText: string | null;
  valueNumber: string | null;
  valueCheckbox: boolean | null;
  valueDate: string | null;
  valueUrl: string | null;
  valueOptionIds: string[] | null;
  valueUserIds: string[] | null;
};

/** The subset of a request body carrying typed custom field value columns. */
export type CustomFieldValueInput = {
  valueText?: string | null;
  valueNumber?: number | string | null;
  valueCheckbox?: boolean | null;
  valueDate?: string | null;
  valueUrl?: string | null;
  valueOptionIds?: string[] | null;
  valueUserIds?: string[] | null;
};

export function emptyValueColumns(): CustomFieldValueColumns {
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

/**
 * Whether a stored value row holds a non-empty value for the field's type. Used by the
 * bulk `fillEmpty` mode to leave already-populated cards untouched. An explicit checkbox
 * value (true or false) counts as populated; a missing row does not.
 */
export function hasCustomFieldValue(type: CustomFieldType, value: CardCustomFieldValue | null | undefined): boolean {
  if (!value) return false;
  switch (type) {
    case "text":
      return value.valueText != null && value.valueText !== "";
    case "number":
      return value.valueNumber != null;
    case "checkbox":
      return value.valueCheckbox != null;
    case "date":
      return value.valueDate != null;
    case "url":
      return value.valueUrl != null && value.valueUrl !== "";
    case "select":
      return (value.valueOptionIds?.length ?? 0) > 0;
    case "user":
      return (value.valueUserIds?.length ?? 0) > 0;
  }
}

/** Whether two value column sets are equal for the field's type, so no-op writes can be skipped. */
export function customFieldValueEquals(
  type: CustomFieldType,
  a: Partial<CustomFieldValueColumns> | null | undefined,
  b: Partial<CustomFieldValueColumns> | null | undefined,
): boolean {
  switch (type) {
    case "text":
      return (a?.valueText ?? null) === (b?.valueText ?? null);
    case "number":
      return (a?.valueNumber ?? null) === (b?.valueNumber ?? null);
    case "checkbox":
      return (a?.valueCheckbox ?? null) === (b?.valueCheckbox ?? null);
    case "date":
      return (a?.valueDate ?? null) === (b?.valueDate ?? null);
    case "url":
      return (a?.valueUrl ?? null) === (b?.valueUrl ?? null);
    case "select":
      return JSON.stringify(a?.valueOptionIds ?? null) === JSON.stringify(b?.valueOptionIds ?? null);
    case "user":
      return JSON.stringify(a?.valueUserIds ?? null) === JSON.stringify(b?.valueUserIds ?? null);
  }
}

/** Reject option ids that are archived or do not belong to the field. */
export async function assertValidOptionIds(fieldId: string, ids: string[], tx: DbOrTx = db): Promise<void> {
  if (ids.length === 0) return;
  const valid = await tx
    .select({ id: customFieldOptions.id })
    .from(customFieldOptions)
    .where(and(
      eq(customFieldOptions.fieldId, fieldId),
      inArray(customFieldOptions.id, ids),
      isNull(customFieldOptions.archivedAt),
    ));
  const validSet = new Set(valid.map((o) => o.id));
  if (ids.some((optionId) => !validSet.has(optionId))) throw badRequest("unknown option for this field");
}

/** Reject user ids that are not members of the workspace. */
export async function assertWorkspaceMemberIds(workspaceId: string, ids: string[], tx: DbOrTx = db): Promise<void> {
  if (ids.length === 0) return;
  const valid = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, ids)));
  const validSet = new Set(valid.map((m) => m.userId));
  if (ids.some((userId) => !validSet.has(userId))) throw badRequest("user is not a workspace member");
}

/**
 * Validate a value input against a field's type and produce the all-null-plus-one
 * value columns to persist. Shared by the single-card PUT route and the bulk endpoint
 * so option/user validation and the single-value cap stay identical across both.
 */
export async function buildCustomFieldValueColumns(
  field: CustomField,
  body: CustomFieldValueInput,
  ctx: { workspaceId: string; tx?: DbOrTx },
): Promise<CustomFieldValueColumns> {
  const tx = ctx.tx ?? db;
  const expectedKey = CUSTOM_FIELD_VALUE_COLUMN_BY_TYPE[field.type];
  if (CUSTOM_FIELD_VALUE_COLUMNS.some((key) => key !== expectedKey && body[key] !== undefined))
    throw badRequest(`expected ${field.type} value`);

  const cols = emptyValueColumns();
  switch (field.type) {
    case "text":
      cols.valueText = body.valueText ?? null;
      break;
    case "number":
      cols.valueNumber = body.valueNumber == null ? null : String(body.valueNumber);
      break;
    case "checkbox":
      cols.valueCheckbox = body.valueCheckbox ?? null;
      break;
    case "date":
      cols.valueDate = body.valueDate ?? null;
      break;
    case "url":
      cols.valueUrl = body.valueUrl ?? null;
      break;
    case "select": {
      const ids = body.valueOptionIds ?? null;
      if (ids?.length) {
        if (!field.allowMultiple && ids.length > 1) throw badRequest("expected a single option");
        await assertValidOptionIds(field.id, ids, tx);
      }
      cols.valueOptionIds = ids?.length ? ids : null;
      break;
    }
    case "user": {
      const ids = body.valueUserIds ?? null;
      if (ids?.length) {
        if (!field.allowMultiple && ids.length > 1) throw badRequest("expected a single user");
        await assertWorkspaceMemberIds(ctx.workspaceId, ids, tx);
      }
      cols.valueUserIds = ids?.length ? ids : null;
      break;
    }
  }
  return cols;
}

async function describeOptionIds(ids: string[] | null | undefined, tx: DbOrTx): Promise<string | null> {
  if (!ids?.length) return null;
  const rows = await tx
    .select({ id: customFieldOptions.id, label: customFieldOptions.label })
    .from(customFieldOptions)
    .where(inArray(customFieldOptions.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r.label]));
  return ids.map((optionId) => byId.get(optionId) ?? "?").join(", ") || null;
}

async function describeUserIds(ids: string[] | null | undefined, tx: DbOrTx): Promise<string | null> {
  if (!ids?.length) return null;
  const rows = await tx
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r.displayName]));
  return ids.map((userId) => byId.get(userId) ?? "?").join(", ") || null;
}

/**
 * Human-readable string for the activity feed for a value (or `null`/absent value).
 * A missing checkbox collapses to "false" so clearing it reads the same as the visible
 * "No" state. Shared by single-card and bulk custom field writes.
 */
export async function describeCustomFieldValue(
  field: Pick<CustomField, "type">,
  value: Partial<CustomFieldValueColumns> | null | undefined,
  tx: DbOrTx = db,
): Promise<string | null> {
  switch (field.type) {
    case "checkbox":
      return String(value?.valueCheckbox === true);
    case "select":
      return describeOptionIds(value?.valueOptionIds, tx);
    case "user":
      return describeUserIds(value?.valueUserIds, tx);
    default:
      return (
        value?.valueText ??
        value?.valueNumber ??
        value?.valueDate ??
        value?.valueUrl ??
        null
      );
  }
}
