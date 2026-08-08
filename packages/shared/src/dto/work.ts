import { z } from "zod";
import type { CompactCardSummary, WireChecklistAssignment, WireCustomField, WireGlobalWorkSeparator } from "../events/index.js";
import type { ColorToken } from "../lib/colors.js";
import { WORK_VIEW_LENSES, WORK_VIEW_VISIBILITIES } from "../schema/work-view.js";
import { ianaTimeZone } from "./_time-zone.js";

export const WORK_GROUP_BY_VALUES = [
  "organisation",
  "workspace",
  "board",
  "assignee",
  "list",
  "dueDate",
  "completion",
  "none",
] as const;
export const WORK_SORT_VALUES = [
  "dueAsc",
  "dueDesc",
  "titleAsc",
  "titleDesc",
  "createdAsc",
  "createdDesc",
  "updatedAsc",
  "updatedDesc",
] as const;
/**
 * `priorities` is the Team Cards lanes display: one "Up next" queue per readable teammate, side by
 * side, so a manager reads everyone's order without focusing each person in turn. It is the one
 * display backed by the priority endpoints rather than the card query — which is also why there is
 * still no priority `WORK_SORT_VALUES` entry: rank is a property of the (user, card) pair, so under
 * `team` one card has several ranks and there is no single `ORDER BY` at all. A single focused
 * person's queue stays a docked panel over the other displays, not a display of its own.
 */
export const WORK_DISPLAY_MODES = ["board", "table", "calendar", "priorities", "history", "summary"] as const;
/**
 * Completion filters for work queries.
 *
 * `activeAndRecentlyCompleted` is the product default and mirrors a board's active view: open cards
 * plus cards completed inside their workspace's `completedCardsActiveDays` window. Completing a card
 * must not make it disappear from the list you completed it in — that rule holds on boards and here.
 * `active` is the strict "hide completed" variant.
 */
export const WORK_COMPLETION_FILTERS = ["activeAndRecentlyCompleted", "active", "completed", "all"] as const;
export type WorkCompletionFilter = (typeof WORK_COMPLETION_FILTERS)[number];
export const DEFAULT_WORK_COMPLETION: WorkCompletionFilter = "activeAndRecentlyCompleted";
export type WorkGroupBy = (typeof WORK_GROUP_BY_VALUES)[number];
export type WorkSort = (typeof WORK_SORT_VALUES)[number];
export type WorkDisplayMode = (typeof WORK_DISPLAY_MODES)[number];

const tableDimensionSchema = z.union([
  z.enum(["organisation", "workspace", "board", "assignee", "list", "label", "dueDate", "completion", "none"]),
  z.string().regex(/^cf:[0-9a-f-]{36}$/i),
]);
const tableColumnVisibilitySchema = z
  .record(z.string().min(1).max(100), z.boolean())
  .refine((value) => Object.keys(value).length <= 100, "Too many table column visibility entries");
const tableColumnWidthsSchema = z
  .record(z.string().min(1).max(100), z.number().min(48).max(1200))
  .refine((value) => Object.keys(value).length <= 100, "Too many table column width entries");
const tableAggregatesSchema = z
  .record(z.uuid(), z.array(z.enum(["sum", "avg"])).max(1))
  .refine((value) => Object.keys(value).length <= 100, "Too many table aggregate entries");

/**
 * The table-only part of a Global Work saved view.
 *
 * Grouping and sorting remain on `WorkViewDefinition` because calendar and board displays share
 * them. Everything here belongs specifically to the table and must travel with a shared saved view,
 * rather than leaking between views through one browser's localStorage.
 */
export const workTablePresentationSchema = z.object({
  columnVisibility: tableColumnVisibilitySchema.default({}),
  columnOrder: z.array(z.string().min(1).max(100)).max(100).default([]),
  columnWidths: tableColumnWidthsSchema.default({}),
  aggregates: tableAggregatesSchema.default({}),
  aggregateSplitBy: tableDimensionSchema.default("none"),
  collapsedGroupKeys: z.array(z.string().min(1).max(200)).max(500).default([]),
});
export type WorkTablePresentation = z.infer<typeof workTablePresentationSchema>;

export const workScopeSchema = z.object({
  allAccessible: z.boolean().default(true),
  organisationIds: z.array(z.uuid()).max(20).default([]),
  workspaceIds: z.array(z.uuid()).max(100).default([]),
  boardIds: z.array(z.uuid()).max(500).default([]),
});
export type WorkScope = z.infer<typeof workScopeSchema>;

export const workCustomFieldConditionSchema = z.object({
  workspaceId: z.uuid(),
  fieldId: z.uuid(),
  op: z.enum([
    "contains", "equals", "eq", "neq", "gt", "gte", "lt", "lte",
    "on", "before", "after", "between", "checked", "unchecked",
    "isAnyOf", "isNoneOf", "isEmpty", "isNotEmpty",
  ]),
  value: z.string().max(500).optional(),
  value2: z.string().max(500).optional(),
  ids: z.array(z.uuid()).max(100).optional(),
});
export type WorkCustomFieldCondition = z.infer<typeof workCustomFieldConditionSchema>;

export const workFiltersSchema = z.object({
  q: z.string().trim().max(200).default(""),
  assigneeIds: z.array(z.uuid()).max(100).default([]),
  listIds: z.array(z.uuid()).max(200).default([]),
  labelIds: z.array(z.uuid()).max(200).default([]),
  customFieldConditions: z.array(workCustomFieldConditionSchema).max(50).default([]),
  completion: z.enum(WORK_COMPLETION_FILTERS).default(DEFAULT_WORK_COMPLETION),
  unassignedOnly: z.boolean().default(false),
  dueFrom: z.iso.date().nullable().default(null),
  dueTo: z.iso.date().nullable().default(null),
  overdueOnly: z.boolean().default(false),
  overdueChecklistOnly: z.boolean().default(false),
  unreadOnly: z.boolean().default(false),
  archived: z.boolean().default(false),
  completedFrom: z.iso.datetime().nullable().default(null),
  completedTo: z.iso.datetime().nullable().default(null),
  // Agent/reporting projections use these to find stale work without enumerating card histories.
  // They remain optional on the app surface and compose with the existing card filters.
  lastActivityBefore: z.iso.datetime().nullable().default(null),
  lastMovedBefore: z.iso.datetime().nullable().default(null),
});
export type WorkFilters = z.infer<typeof workFiltersSchema>;

export const workViewDefinitionSchema = z.object({
  scope: workScopeSchema.default({ allAccessible: true, organisationIds: [], workspaceIds: [], boardIds: [] }),
  filters: workFiltersSchema.default({
    q: "",
    assigneeIds: [],
    listIds: [],
    labelIds: [],
    customFieldConditions: [],
    completion: DEFAULT_WORK_COMPLETION,
    unassignedOnly: false,
    dueFrom: null,
    dueTo: null,
    overdueOnly: false,
    overdueChecklistOnly: false,
    unreadOnly: false,
    archived: false,
    completedFrom: null,
    completedTo: null,
    lastActivityBefore: null,
    lastMovedBefore: null,
  }),
  groupBy: z.enum(WORK_GROUP_BY_VALUES).default("dueDate"),
  sort: z.enum(WORK_SORT_VALUES).default("dueAsc"),
  display: z.enum(WORK_DISPLAY_MODES).default("table"),
  columns: z.array(z.string().min(1).max(100)).max(50).default([]),
  table: workTablePresentationSchema.default({
    columnVisibility: {},
    columnOrder: [],
    columnWidths: {},
    aggregates: {},
    aggregateSplitBy: "none",
    collapsedGroupKeys: [],
  }),
  portfolioDays: z.number().int().min(1).max(60).default(30),
  // Collapse state is view layout, not transient component state: saved views and per-lens browser
  // preferences restore the same workspace/section shape the user was looking at.
  // The portfolio summary tree reuses collapsedWorkspaceIds for its workspace rows (the portfolio
  // lens has no board display, so the two consumers never share a lens) and pairs it with
  // collapsedOrganisationIds for the level above.
  collapsedOrganisationIds: z.array(z.uuid()).max(20).default([]),
  collapsedWorkspaceIds: z.array(z.uuid()).max(100).default([]),
  collapsedSectionIds: z.array(z.string().min(1).max(100)).max(500).default([]),
});
export type WorkViewDefinition = z.infer<typeof workViewDefinitionSchema>;

export const workCardsQueryBody = z.object({
  lens: z.enum(WORK_VIEW_LENSES),
  scope: workScopeSchema.optional(),
  filters: workFiltersSchema.optional(),
  sort: z.enum(WORK_SORT_VALUES).default("dueAsc"),
  cursor: z.string().min(1).max(500_000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  // Cursor pages only add cards. Callers that already hold first-page metadata can skip the
  // invariant totals, checklist assignments, and separator queries on every continuation.
  includeMetadata: z.boolean().default(true),
});
export type WorkCardsQuery = z.infer<typeof workCardsQueryBody>;

export const workPortfolioQueryBody = z.object({
  scope: workScopeSchema.optional(),
  filters: workFiltersSchema.optional(),
  days: z.number().int().min(1).max(60).default(30),
  // The activity strips bucket events into calendar days, so they must be bucketed in the viewer's
  // zone or a late-evening update lands on the wrong column.
  timeZone: ianaTimeZone,
});
export type WorkPortfolioQuery = z.infer<typeof workPortfolioQueryBody>;

export const globalWorkDoneQueryBody = z.object({
  lens: z.enum(["my", "team"]),
  scope: workScopeSchema.optional(),
  filters: workFiltersSchema.optional(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  // Needed because the window may now span several days: move coalescing is closed at each local
  // day boundary so a card moved on two days reads as two rows. See lib/work-done.ts.
  timeZone: ianaTimeZone,
});
export type GlobalWorkDoneQuery = z.infer<typeof globalWorkDoneQueryBody>;

/** Per-day activity counts for the global work-done activity strip. */
export const globalWorkDoneSummaryQueryBody = z.object({
  lens: z.enum(["my", "team"]),
  scope: workScopeSchema.optional(),
  filters: workFiltersSchema.optional(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  timeZone: ianaTimeZone,
});
export type GlobalWorkDoneSummaryQuery = z.infer<typeof globalWorkDoneSummaryQueryBody>;

export const createWorkViewBody = z.object({
  name: z.string().trim().min(1).max(120),
  lens: z.enum(WORK_VIEW_LENSES),
  visibility: z.enum(WORK_VIEW_VISIBILITIES).default("private"),
  definition: workViewDefinitionSchema,
});
export const updateWorkViewBody = createWorkViewBody.partial().refine((body) => Object.keys(body).length > 0);
export const shareWorkViewBody = z.object({ userId: z.uuid() });
export type CreateWorkViewBody = z.infer<typeof createWorkViewBody>;
export type UpdateWorkViewBody = z.infer<typeof updateWorkViewBody>;

export type WorkCatalogOrganisation = {
  id: string;
  name: string;
  external: boolean;
};

export type WorkCatalogWorkspace = {
  id: string;
  organisationId: string;
  name: string;
  icon: string | null;
  accentColor: string | null;
  kind: "standard" | "board";
  viewerCanAccessWorkspace: boolean;
};

export type WorkCatalogBoard = {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  iconColor: ColorToken | null;
  viewerRole: "editor" | "observer";
  assignedItemsOnly: boolean;
};

export type WorkCatalogList = {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  color: ColorToken | null;
  position: string;
};

export type WorkCatalogLabel = {
  id: string;
  workspaceId: string;
  name: string;
  color: ColorToken | null;
  position: string;
};

export type WorkCatalogPerson = {
  userId: string;
  organisationId: string;
  displayName: string;
  avatarUrl: string | null;
  boardIds: string[];
};

export type WorkViewShareCandidate = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
};

export type WorkCatalog = {
  organisations: WorkCatalogOrganisation[];
  workspaces: WorkCatalogWorkspace[];
  boards: WorkCatalogBoard[];
  lists: WorkCatalogList[];
  labels: WorkCatalogLabel[];
  customFields: WireCustomField[];
  people: WorkCatalogPerson[];
};

export type WorkCard = CompactCardSummary & {
  workspaceId: string;
  /**
   * 1-based rank in the *requesting viewer's own* "Up next" queue, null when the card is not in it.
   * Always the caller's queue regardless of lens — a manager reading team cards sees their own
   * sequencing, never the assignee's (that would leak another person's curation; read it via the
   * priorities endpoint instead). Optional because the priorities endpoint's own items omit it:
   * there the entry already wears its rank.
   */
  viewerPriorityRank?: number | null;
};

export type WorkTotals = {
  cards: number;
  overdue: number;
  dueSoon: number;
  completed: number;
  checklistItems: number;
  overdueChecklistItems: number;
};

export type WorkQueryResponse = {
  cards: WorkCard[];
  /** Present only when My Cards or one teammate supplies a stable owner for the merged lanes. */
  separators: WireGlobalWorkSeparator[];
  /** Workspaces where the viewer may create or mutate the returned personal separators. */
  separatorWorkspaceIds: string[];
  checklistItems: WireChecklistAssignment[];
  totals: WorkTotals;
  nextCursor: string | null;
};

export type PortfolioBucket = {
  organisationId: string;
  organisationName: string;
  workspaceId: string;
  workspaceName: string;
  boardId: string;
  boardName: string;
  active: number;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  completed: number;
  overdueChecklistItems: number;
};

/**
 * One day of the portfolio activity heatmaps. `date` is a local calendar day (YYYY-MM-DD).
 * Movement and completion are reported separately: a busy board that ships nothing and a quiet board
 * that closes work steadily are different stories, and one blended count hides both.
 */
export type PortfolioActivityDay = {
  date: string;
  moved: number;
  completed: number;
};

export type PortfolioSummary = {
  days: number;
  totals: Omit<WorkTotals, "checklistItems"> & { unassigned: number };
  buckets: PortfolioBucket[];
  /** Length of the heatmap window in days. Fixed, and independent of the `days` reporting period. */
  activityDays: number;
  /** Only days with activity are sent; the client fills the rest of the window with zeroes. */
  activity: PortfolioActivityDay[];
};

export type SavedWorkView = {
  id: string;
  clientId: string;
  ownerId: string;
  ownerName: string;
  name: string;
  lens: (typeof WORK_VIEW_LENSES)[number];
  visibility: (typeof WORK_VIEW_VISIBILITIES)[number];
  definitionVersion: number;
  definition: WorkViewDefinition;
  editable: boolean;
  sharedUserIds: string[];
  createdAt: string | Date;
  updatedAt: string | Date;
};
