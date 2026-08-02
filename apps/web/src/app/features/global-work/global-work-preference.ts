import type {
  WorkCatalog,
  WorkCustomFieldCondition,
  WorkDisplayMode,
  WorkFilters,
  WorkGroupBy,
  WorkSort,
  WorkTablePresentation,
  WorkViewDefinition,
} from "@kanera/shared/dto";
import type { WorkViewLens } from "@kanera/shared/schema";
import { viewPreferenceKey } from "../../core/browser/browser-contracts";

// v2: the default completion filter changed from "active" (hide completed) to
// "activeAndRecentlyCompleted". Every stored v1 preference carries the old default as if it were a
// choice, so the bump discards them and lets existing users pick up the new default; from here on a
// deliberate "Hide completed" persists.
const GLOBAL_WORK_PREFERENCE_VERSION = 2;
const GROUPS: WorkGroupBy[] = [
  "organisation", "workspace", "board", "assignee", "list", "dueDate", "completion", "none",
];
const SORTS: WorkSort[] = [
  "dueAsc", "dueDesc", "titleAsc", "titleDesc", "createdAsc", "createdDesc", "updatedAsc", "updatedDesc",
];
const DISPLAYS: WorkDisplayMode[] = ["board", "table", "calendar", "history", "summary"];
const COMPLETIONS: WorkFilters["completion"][] = ["activeAndRecentlyCompleted", "active", "completed", "all"];
/**
 * Mirrors DEFAULT_WORK_COMPLETION in `@kanera/shared/dto`. The vocabulary is duplicated here — as
 * GROUPS/SORTS/DISPLAYS above are — because importing a *value* from the dto package would pull zod
 * into the web bundle. Typing against `WorkFilters["completion"]` keeps the two from drifting: a
 * rename in the shared enum fails to compile here.
 */
export const DEFAULT_COMPLETION: WorkFilters["completion"] = "activeAndRecentlyCompleted";
const CUSTOM_FIELD_OPERATORS: WorkCustomFieldCondition["op"][] = [
  "contains", "equals", "eq", "neq", "gt", "gte", "lt", "lte", "on", "before", "after", "between",
  "checked", "unchecked", "isAnyOf", "isNoneOf", "isEmpty", "isNotEmpty",
];

export type GlobalWorkPreference = {
  definition: WorkViewDefinition;
  selectedViewId: string | null;
  drilldownLabel: string | null;
  collapsedTableGroupKeys?: string[];
  collapsedHistoryDayKeys?: string[];
  collapsedChecklistGroupIds?: string[];
};

function preferenceKey(userId: string, lens: WorkViewLens): string {
  return viewPreferenceKey("definition", `globalWork:${userId}:${lens}`);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown, max = 500): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, max)
    : [];
}

function nullableDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function nullableDateTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime()) ? value : null;
}

function customFieldConditions(value: unknown): WorkCustomFieldCondition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const condition = objectValue(entry);
    if (!condition) return [];
    const workspaceId = condition["workspaceId"];
    const fieldId = condition["fieldId"];
    const op = condition["op"];
    if (
      typeof workspaceId !== "string"
      || typeof fieldId !== "string"
      || typeof op !== "string"
      || !CUSTOM_FIELD_OPERATORS.includes(op as WorkCustomFieldCondition["op"])
    ) return [];
    return [{
      workspaceId,
      fieldId,
      op: op as WorkCustomFieldCondition["op"],
      ...(typeof condition["value"] === "string" ? { value: condition["value"] } : {}),
      ...(typeof condition["value2"] === "string" ? { value2: condition["value2"] } : {}),
      ...(Array.isArray(condition["ids"]) ? { ids: stringArray(condition["ids"], 100) } : {}),
    }];
  }).slice(0, 50);
}

function storedAggregates(value: unknown): WorkTablePresentation["aggregates"] {
  const result: WorkTablePresentation["aggregates"] = {};
  for (const [fieldId, rawMetrics] of Object.entries(objectValue(value) ?? {})) {
    if (Object.keys(result).length >= 100) break;
    if (!/^[0-9a-f-]{36}$/i.test(fieldId) || !Array.isArray(rawMetrics)) continue;
    const metric: unknown = rawMetrics[0];
    if (metric === "sum" || metric === "avg") result[fieldId] = [metric];
  }
  return result;
}

function storedTablePresentation(value: unknown): WorkTablePresentation {
  const table = objectValue(value);
  const visibility = objectValue(table?.["columnVisibility"]);
  const widths = objectValue(table?.["columnWidths"]);
  const aggregates = objectValue(table?.["aggregates"]);
  const aggregateSplitBy = table?.["aggregateSplitBy"];
  const validSplit = typeof aggregateSplitBy === "string" && (
    [
      "organisation", "workspace", "board", "assignee", "list", "label",
      "dueDate", "completion", "none",
    ].includes(aggregateSplitBy)
    || /^cf:[0-9a-f-]{36}$/i.test(aggregateSplitBy)
  );
  return {
    columnVisibility: Object.fromEntries(
      Object.entries(visibility ?? {})
        .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
        .slice(0, 100),
    ),
    columnOrder: stringArray(table?.["columnOrder"], 100),
    columnWidths: Object.fromEntries(
      Object.entries(widths ?? {})
        .filter((entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 48 && entry[1] <= 1200
        )
        .slice(0, 100),
    ),
    aggregates: storedAggregates(aggregates),
    aggregateSplitBy: validSplit ? aggregateSplitBy : "none",
    collapsedGroupKeys: stringArray(table?.["collapsedGroupKeys"], 500),
  };
}

function storedDefinition(value: unknown): WorkViewDefinition | null {
  const definition = objectValue(value);
  const scope = objectValue(definition?.["scope"]);
  const filters = objectValue(definition?.["filters"]);
  const groupBy = definition?.["groupBy"];
  const sort = definition?.["sort"];
  const display = definition?.["display"];
  if (
    !definition
    || !scope
    || !filters
    || typeof scope["allAccessible"] !== "boolean"
    || typeof groupBy !== "string"
    || !GROUPS.includes(groupBy as WorkGroupBy)
    || typeof sort !== "string"
    || !SORTS.includes(sort as WorkSort)
    || typeof display !== "string"
    || !DISPLAYS.includes(display as WorkDisplayMode)
  ) return null;
  const completion = filters["completion"];
  const portfolioDays = definition["portfolioDays"];
  const parsedFilters: WorkFilters = {
    q: typeof filters["q"] === "string" ? filters["q"].slice(0, 200) : "",
    assigneeIds: stringArray(filters["assigneeIds"], 100),
    listIds: stringArray(filters["listIds"], 200),
    labelIds: stringArray(filters["labelIds"], 200),
    customFieldConditions: customFieldConditions(filters["customFieldConditions"]),
    completion: COMPLETIONS.includes(completion as WorkFilters["completion"])
      ? completion as WorkFilters["completion"]
      : DEFAULT_COMPLETION,
    unassignedOnly: filters["unassignedOnly"] === true,
    dueFrom: nullableDate(filters["dueFrom"]),
    dueTo: nullableDate(filters["dueTo"]),
    overdueOnly: filters["overdueOnly"] === true,
    overdueChecklistOnly: filters["overdueChecklistOnly"] === true,
    unreadOnly: filters["unreadOnly"] === true,
    archived: filters["archived"] === true,
    completedFrom: nullableDateTime(filters["completedFrom"]),
    completedTo: nullableDateTime(filters["completedTo"]),
    lastActivityBefore: nullableDateTime(filters["lastActivityBefore"]),
    lastMovedBefore: nullableDateTime(filters["lastMovedBefore"]),
  };
  return {
    scope: {
      allAccessible: scope["allAccessible"],
      organisationIds: stringArray(scope["organisationIds"], 20),
      workspaceIds: stringArray(scope["workspaceIds"], 100),
      boardIds: stringArray(scope["boardIds"], 500),
    },
    filters: parsedFilters,
    groupBy: groupBy as WorkGroupBy,
    sort: sort as WorkSort,
    display: display as WorkDisplayMode,
    columns: stringArray(definition["columns"], 50),
    table: storedTablePresentation(definition["table"]),
    portfolioDays: typeof portfolioDays === "number" && Number.isFinite(portfolioDays)
      ? Math.max(1, Math.min(60, Math.round(portfolioDays)))
      : 30,
    collapsedOrganisationIds: stringArray(definition["collapsedOrganisationIds"], 20),
    collapsedWorkspaceIds: stringArray(definition["collapsedWorkspaceIds"], 100),
    collapsedSectionIds: stringArray(definition["collapsedSectionIds"], 500),
  };
}

export function readGlobalWorkPreference(
  userId: string,
  lens: WorkViewLens,
): GlobalWorkPreference | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(preferenceKey(userId, lens));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (value["version"] !== GLOBAL_WORK_PREFERENCE_VERSION) return null;
    const definition = storedDefinition(value["definition"]);
    if (!definition) return null;
    // v2 stored table folds outside the definition. Carry them into the new saved-view-owned shape
    // once, so upgrading does not unexpectedly expand a carefully folded table.
    if (!objectValue(objectValue(value["definition"])?.["table"])) {
      definition.table.collapsedGroupKeys = stringArray(value["collapsedTableGroupKeys"]);
    }
    return {
      definition,
      selectedViewId: typeof value["selectedViewId"] === "string" ? value["selectedViewId"] : null,
      drilldownLabel: typeof value["drilldownLabel"] === "string"
        ? value["drilldownLabel"].slice(0, 250)
        : null,
      collapsedTableGroupKeys: stringArray(value["collapsedTableGroupKeys"]),
      collapsedHistoryDayKeys: stringArray(value["collapsedHistoryDayKeys"], 60),
      collapsedChecklistGroupIds: stringArray(value["collapsedChecklistGroupIds"], 5),
    };
  } catch {
    return null;
  }
}

export function writeGlobalWorkPreference(
  userId: string,
  lens: WorkViewLens,
  preference: GlobalWorkPreference,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    // Match board/list preferences: free-text search and archived mode are useful transient state,
    // but should not unexpectedly reappear when the user returns later.
    const definition: WorkViewDefinition = {
      ...preference.definition,
      filters: {
        ...preference.definition.filters,
        q: "",
        archived: false,
      },
    };
    localStorage.setItem(preferenceKey(userId, lens), JSON.stringify({
      version: GLOBAL_WORK_PREFERENCE_VERSION,
      definition,
      selectedViewId: preference.selectedViewId,
      drilldownLabel: preference.drilldownLabel,
      collapsedTableGroupKeys: preference.collapsedTableGroupKeys ?? [],
      collapsedHistoryDayKeys: preference.collapsedHistoryDayKeys ?? [],
      collapsedChecklistGroupIds: preference.collapsedChecklistGroupIds ?? [],
    }));
  } catch {
    // Storage can be unavailable in privacy mode or over quota; in-memory settings still work.
  }
}

export function sanitizeGlobalWorkDefinition(
  definition: WorkViewDefinition,
  lens: WorkViewLens,
  catalog: WorkCatalog,
  currentUserId: string | null,
): WorkViewDefinition {
  const organisationIds = new Set(catalog.organisations.map((organisation) => organisation.id));
  const workspaceIds = new Set(catalog.workspaces.map((workspace) => workspace.id));
  const boardIds = new Set(catalog.boards.map((board) => board.id));
  const listIds = new Set(catalog.lists.map((list) => list.id));
  const labelIds = new Set(catalog.labels.map((label) => label.id));
  const fieldsById = new Map(catalog.customFields.map((field) => [field.id, field]));
  const peopleIds = new Set(catalog.people.map((person) => person.userId));
  if (currentUserId) peopleIds.add(currentUserId);
  const validSectionIds = (() => {
    switch (definition.groupBy) {
      case "organisation": return organisationIds;
      case "workspace": return workspaceIds;
      case "board": return boardIds;
      case "assignee": return new Set([...peopleIds, "unassigned"]);
      case "list": return listIds;
      case "completion": return new Set(["active", "completed"]);
      case "dueDate": return new Set(["0-overdue", "1-today", "2-upcoming", "3-later", "5-undated"]);
      case "none": return new Set(["all"]);
    }
  })();
  const scope = {
    ...definition.scope,
    organisationIds: definition.scope.organisationIds.filter((id) => organisationIds.has(id)),
    workspaceIds: definition.scope.workspaceIds.filter((id) => workspaceIds.has(id)),
    boardIds: definition.scope.boardIds.filter((id) => boardIds.has(id)),
  };
  const hasExplicitScope =
    scope.organisationIds.length > 0 || scope.workspaceIds.length > 0 || scope.boardIds.length > 0;
  // Portfolio is a rollup lens: a summary, plus the table its metric drill-downs land in. It has no
  // board, history, or calendar display, so a stored definition naming one falls back to the summary.
  const allowedDisplays = lens === "portfolio"
    ? new Set(["summary", "table"])
    : new Set(["board", "table", "calendar", "history"]);
  const builtinTableColumns = new Set([
    "status", "board", "assignees", "due", "labels", "checklist", "description", "created", "updated",
  ]);
  const validTableColumn = (id: string) => {
    if (builtinTableColumns.has(id)) return true;
    if (!id.startsWith("cf:")) return false;
    const field = fieldsById.get(id.slice(3));
    return Boolean(field && !field.archivedAt);
  };
  const validAggregateField = (id: string) => {
    const field = fieldsById.get(id);
    return field?.type === "number" && !field.archivedAt;
  };
  const split = definition.table.aggregateSplitBy;
  const validSplit = !split.startsWith("cf:") || Boolean(fieldsById.get(split.slice(3)) && !fieldsById.get(split.slice(3))?.archivedAt);
  const validCollapsedTableGroupKeys = (() => {
    switch (definition.groupBy) {
      case "organisation": return new Set([...organisationIds, "__none__"].map((id) => `organisation:${id}`));
      case "workspace": return new Set([...workspaceIds, "__none__"].map((id) => `workspace:${id}`));
      case "board": return new Set([...boardIds, "__none__"].map((id) => `board:${id}`));
      case "assignee": return new Set([...peopleIds, "__none__"].map((id) => `assignee:${id}`));
      case "list": return new Set([...listIds].map((id) => `list:${id}`));
      case "dueDate": return new Set(["overdue", "today", "tomorrow", "thisWeek", "later", "noDate"].map((id) => `due:${id}`));
      case "completion": return new Set(["completion:open", "completion:done"]);
      case "none": return new Set(["all"]);
    }
  })();

  return {
    ...definition,
    scope: {
      ...scope,
      // If the one remembered source was revoked, return to accessible work instead of leaving an
      // apparently "All boards" picker backed by an empty explicit scope.
      allAccessible: definition.scope.allAccessible || !hasExplicitScope,
    },
    filters: {
      ...definition.filters,
      assigneeIds: lens === "my"
        ? []
        : definition.filters.assigneeIds.filter((id) =>
            peopleIds.has(id) && (lens !== "team" || id !== currentUserId)
          ),
      listIds: definition.filters.listIds.filter((id) => listIds.has(id)),
      labelIds: definition.filters.labelIds.filter((id) => labelIds.has(id)),
      customFieldConditions: definition.filters.customFieldConditions.filter((condition) => {
        const field = fieldsById.get(condition.fieldId);
        return field?.workspaceId === condition.workspaceId && !field.archivedAt;
      }),
    },
    display: allowedDisplays.has(definition.display)
      ? definition.display
      : lens === "portfolio" ? "summary" : lens === "team" ? "board" : "table",
    table: {
      ...definition.table,
      columnVisibility: Object.fromEntries(
        Object.entries(definition.table.columnVisibility).filter(([id]) => validTableColumn(id)),
      ),
      columnOrder: definition.table.columnOrder.filter(validTableColumn),
      columnWidths: Object.fromEntries(
        Object.entries(definition.table.columnWidths).filter(([id]) => id === "title" || validTableColumn(id)),
      ),
      aggregates: Object.fromEntries(
        Object.entries(definition.table.aggregates).filter(([fieldId]) => validAggregateField(fieldId)),
      ),
      aggregateSplitBy: validSplit ? split : "none",
      collapsedGroupKeys: definition.table.collapsedGroupKeys.filter((key) => validCollapsedTableGroupKeys.has(key)),
    },
    collapsedOrganisationIds: definition.collapsedOrganisationIds.filter((id) => organisationIds.has(id)),
    collapsedWorkspaceIds: definition.collapsedWorkspaceIds.filter((id) => workspaceIds.has(id)),
    collapsedSectionIds: definition.collapsedSectionIds.filter((id) => validSectionIds.has(id)),
  };
}
