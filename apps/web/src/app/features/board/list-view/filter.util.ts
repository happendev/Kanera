import type { CardCustomFieldValue, CustomFieldType } from "@kanera/shared/schema";
import type { CfFilterCondition, FilterValue } from "./filter.types";
import type { AnyCustomField } from "./list-view.types";

/**
 * Whether any client-side filter dimension is active. Used by both `k-filter-bar` (to show
 * "Clear all" / active state) and the pages (empty-state messaging). Kept as the single
 * definition so the component and pages never disagree on what "filtered" means. Completed
 * range and archived are excluded here — they are server-reload dimensions, so callers that
 * care about them (the pages) OR them in separately.
 */
export function hasActiveFilter(v: FilterValue): boolean {
  return (
    v.labelIds.length > 0 ||
    v.memberIds.length > 0 ||
    v.listIds.length > 0 ||
    v.boardIds.length > 0 ||
    v.cfConditions.length > 0 ||
    v.showUnreadOnly ||
    v.showOverdueOnly
  );
}

/**
 * Whether a card satisfies every custom-field condition (conditions AND together).
 *
 * This mirrors the typed value columns and the emptiness semantics used elsewhere
 * (`group-by.util.ts`'s `valueFor`, `card.component.ts`, and the API's
 * `hasCustomFieldValue`) so board filtering agrees with grouping and the server. A
 * condition whose field no longer exists is ignored rather than hiding all cards, so a
 * stale persisted filter cannot silently blank the board.
 */
export function matchesCfConditions(
  cardId: string,
  conditions: CfFilterCondition[],
  fieldsById: Map<string, AnyCustomField>,
  valuesByCardAndField: Map<string, Map<string, CardCustomFieldValue>>,
): boolean {
  if (!conditions.length) return true;
  const cardValues = valuesByCardAndField.get(cardId);
  for (const condition of conditions) {
    const field = fieldsById.get(condition.fieldId);
    if (!field) continue; // stale condition — ignore rather than hide everything
    const value = cardValues?.get(condition.fieldId) ?? null;
    if (!matchesOne(field.type, condition, value)) return false;
  }
  return true;
}

function matchesOne(
  type: CustomFieldType,
  condition: CfFilterCondition,
  value: CardCustomFieldValue | null,
): boolean {
  // Emptiness applies to every type and short-circuits before type-specific handling.
  if (condition.op === "isEmpty") return !hasValue(type, value);
  if (condition.op === "isNotEmpty") return hasValue(type, value);

  switch (type) {
    case "text":
      return matchesString(value?.valueText, condition);
    case "url":
      return matchesString(value?.valueUrl, condition);
    case "number":
      return matchesNumber(value?.valueNumber, condition);
    case "date":
      return matchesDate(value?.valueDate, condition);
    case "checkbox":
      // Only an explicit `true` counts as checked; null/false is unchecked.
      if (condition.op === "checked") return value?.valueCheckbox === true;
      if (condition.op === "unchecked") return value?.valueCheckbox !== true;
      return true;
    case "select":
      return matchesIds(value?.valueOptionIds, condition);
    case "user":
      return matchesIds(value?.valueUserIds, condition);
  }
}

function matchesString(raw: string | null | undefined, condition: CfFilterCondition): boolean {
  const haystack = (raw ?? "").trim().toLowerCase();
  const needle = (condition.value ?? "").trim().toLowerCase();
  if (!needle) return true; // no operand entered yet — treat as inactive
  if (condition.op === "contains") return haystack.includes(needle);
  if (condition.op === "equals") return haystack === needle;
  return true;
}

function matchesNumber(raw: string | null | undefined, condition: CfFilterCondition): boolean {
  const operand = condition.value?.trim();
  if (!operand) return true; // no operand entered yet
  const target = Number(operand);
  if (Number.isNaN(target)) return true;
  if (raw == null || raw === "") return false;
  const actual = Number(raw);
  if (Number.isNaN(actual)) return false;
  switch (condition.op) {
    case "eq": return actual === target;
    case "neq": return actual !== target;
    case "gt": return actual > target;
    case "gte": return actual >= target;
    case "lt": return actual < target;
    case "lte": return actual <= target;
    default: return true;
  }
}

function matchesDate(raw: string | null | undefined, condition: CfFilterCondition): boolean {
  // Dates are stored as `YYYY-MM-DD`, which sorts correctly under lexical comparison.
  const actual = raw?.trim() ?? "";
  const from = condition.value?.trim() ?? "";
  if (condition.op === "between") {
    const to = condition.value2?.trim() ?? "";
    if (!from && !to) return true; // no operand yet
    if (!actual) return false;
    if (from && actual < from) return false;
    if (to && actual > to) return false;
    return true;
  }
  if (!from) return true; // no operand yet
  if (!actual) return false;
  switch (condition.op) {
    case "on": return actual === from;
    case "before": return actual < from;
    case "after": return actual > from;
    default: return true;
  }
}

function matchesIds(raw: string[] | null | undefined, condition: CfFilterCondition): boolean {
  const selected = condition.ids ?? [];
  if (!selected.length) return true; // nothing picked yet — inactive
  const actual = raw ?? [];
  const intersects = actual.some((id) => selected.includes(id));
  if (condition.op === "isAnyOf") return intersects;
  if (condition.op === "isNoneOf") return !intersects;
  return true;
}

/** Emptiness per field type — replicates the API's `hasCustomFieldValue` on the client. */
function hasValue(type: CustomFieldType, value: CardCustomFieldValue | null): boolean {
  if (!value) return false;
  switch (type) {
    case "text": return value.valueText != null && value.valueText !== "";
    case "number": return value.valueNumber != null;
    case "checkbox": return value.valueCheckbox != null;
    case "date": return value.valueDate != null;
    case "url": return value.valueUrl != null && value.valueUrl !== "";
    case "select": return (value.valueOptionIds?.length ?? 0) > 0;
    case "user": return (value.valueUserIds?.length ?? 0) > 0;
  }
}
