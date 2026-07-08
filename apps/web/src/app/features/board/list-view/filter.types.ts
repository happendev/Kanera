import type { CustomFieldType } from "@kanera/shared/schema";

/**
 * Operators for custom-field filter conditions. Not every operator applies to every
 * field type — `OPERATORS_BY_TYPE` maps a field's type to the operators the builder UI
 * should offer, and `matchesCfConditions` in `filter.util.ts` is the single source of
 * truth for how each operator evaluates.
 */
export type CfFilterOperator =
  | "contains" | "equals"                        // text, url
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"   // number
  | "on" | "before" | "after" | "between"        // date
  | "checked" | "unchecked"                      // checkbox
  | "isAnyOf" | "isNoneOf"                        // select, user (option/member ids)
  | "isEmpty" | "isNotEmpty";                    // every type

/**
 * A single custom-field filter condition. Conditions combine with AND, and multiple
 * conditions on the same field are allowed. Only the fields relevant to the operator are
 * populated: scalar operators read `value`/`value2`, id-set operators read `ids`, and the
 * emptiness/boolean operators need no operand.
 */
export interface CfFilterCondition {
  fieldId: string;
  op: CfFilterOperator;
  /** text/url substring, number operand, or the "from" bound for date `between`/scalar date ops. */
  value?: string;
  /** date "to" bound for `between`. */
  value2?: string;
  /** select option ids / user ids for `isAnyOf` / `isNoneOf`. */
  ids?: string[];
}

/**
 * The normalized client-side filter shared by the board and assigned-work pages and driven
 * by the `k-filter-bar` component. Only dimensions that filter in the browser live here —
 * the completed-date range and the archived toggle trigger a server reload instead, so they
 * are handled by dedicated `k-filter-bar` outputs and each page's existing reload path, and
 * are intentionally NOT part of this shape.
 */
export interface FilterValue {
  labelIds: string[];
  /** Assignee filter; unused on assigned-work, where the assignee is implicit (it's the current user). */
  memberIds: string[];
  listIds: string[];
  /** Board filter; assigned-work only (spans boards), always `[]` on a single-board page. */
  boardIds: string[];
  cfConditions: CfFilterCondition[];
  showUnreadOnly: boolean;
  showOverdueOnly: boolean;
}

/** Whether an operator carries no operand (drives whether the builder shows a value control). */
export function operatorHasNoValue(op: CfFilterOperator): boolean {
  return op === "isEmpty" || op === "isNotEmpty" || op === "checked" || op === "unchecked";
}

/** Whether an operator reads the `ids` array (multi-picker) rather than `value`. */
export function operatorUsesIds(op: CfFilterOperator): boolean {
  return op === "isAnyOf" || op === "isNoneOf";
}

const CONTAINS = { op: "contains", label: "contains" } as const;
const EQUALS = { op: "equals", label: "is" } as const;
const EQ = { op: "eq", label: "=" } as const;
const NEQ = { op: "neq", label: "≠" } as const;
const GT = { op: "gt", label: ">" } as const;
const GTE = { op: "gte", label: "≥" } as const;
const LT = { op: "lt", label: "<" } as const;
const LTE = { op: "lte", label: "≤" } as const;
const ON = { op: "on", label: "on" } as const;
const BEFORE = { op: "before", label: "before" } as const;
const AFTER = { op: "after", label: "after" } as const;
const BETWEEN = { op: "between", label: "between" } as const;
const CHECKED = { op: "checked", label: "is checked" } as const;
const UNCHECKED = { op: "unchecked", label: "is unchecked" } as const;
const IS_ANY_OF = { op: "isAnyOf", label: "is any of" } as const;
const IS_NONE_OF = { op: "isNoneOf", label: "is none of" } as const;
const IS_EMPTY = { op: "isEmpty", label: "is empty" } as const;
const IS_NOT_EMPTY = { op: "isNotEmpty", label: "is not empty" } as const;

/** Operator options offered per field type; drives the builder UI's operator dropdown. */
export const OPERATORS_BY_TYPE: Record<CustomFieldType, readonly { op: CfFilterOperator; label: string }[]> = {
  text: [CONTAINS, EQUALS, IS_EMPTY, IS_NOT_EMPTY],
  url: [CONTAINS, EQUALS, IS_EMPTY, IS_NOT_EMPTY],
  number: [EQ, NEQ, GT, GTE, LT, LTE, IS_EMPTY, IS_NOT_EMPTY],
  date: [ON, BEFORE, AFTER, BETWEEN, IS_EMPTY, IS_NOT_EMPTY],
  checkbox: [CHECKED, UNCHECKED],
  select: [IS_ANY_OF, IS_NONE_OF, IS_EMPTY, IS_NOT_EMPTY],
  user: [IS_ANY_OF, IS_NONE_OF, IS_EMPTY, IS_NOT_EMPTY],
};

/** The default operator to seed a new condition with when a field is chosen. */
export function defaultOperatorFor(type: CustomFieldType): CfFilterOperator {
  return OPERATORS_BY_TYPE[type][0]!.op;
}
