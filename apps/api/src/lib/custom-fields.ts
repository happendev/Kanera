import type { WireCustomField, WireCustomFieldOption } from "@kanera/shared/events";
import type { CustomField } from "@kanera/shared/schema";
import { customFieldOptions, customFields } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, type Db } from "../db.js";

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
