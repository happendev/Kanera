import type { WireBoardMemberUser, WireCard, WireCardLabel, WireCardSummary, WireCustomField, WireList } from "@kanera/shared/events";
import type { Card, CardLabel, CustomField, List } from "@kanera/shared/schema";

// Lane item types live with BoardState (the canonical owner); re-export here so table-view code can
// keep importing them alongside the table-only aliases below.
export type { AnySeparator, BoardLaneItem, LaneAnchor } from "../board-state";
export type AnyCard = Card | WireCard | WireCardSummary;
export type AnyList = List | WireList;
export type AnyLabel = CardLabel | WireCardLabel;
export type AnyMember = WireBoardMemberUser;
export type AnyCustomField = CustomField | WireCustomField;

export type BuiltinGroupBy =
  | "list"
  | "assignee"
  | "label"
  | "dueDate"
  | "completion"
  | "none"
  // Cross-board dimensions. Meaningless on a single board, so board views never offer them; Global
  // Work does, and they are what makes "hours by client" expressible as an aggregate breakdown.
  | "board"
  | "workspace"
  | "organisation";

export type CustomFieldGroupBy = `cf:${string}`;

export type GroupBy = BuiltinGroupBy | CustomFieldGroupBy;

export type SortBy =
  | "position"
  | "title-asc"
  | "title-desc"
  | "due-asc"
  | "due-desc"
  | "start-asc"
  | "start-desc"
  | "created-desc"
  | "created-asc"
  | "updated-desc"
  | "updated-asc"
  /** Earliest time-in-progress start first; cards not in progress sort last. */
  | "in-progress-longest"
  | "in-progress-newest";

export type AggregateMetric = "sum" | "avg";

export type AggregateConfig = Record<string, AggregateMetric[]>;

export type DueBucket = "overdue" | "today" | "tomorrow" | "thisWeek" | "later" | "noDate";

export interface GroupMeta {
  listId?: string;
  userId?: string;
  labelId?: string;
  fieldId?: string;
  /**
   * The custom-field value this bucket represents, in the same encoding the group key uses: an
   * option/user id, `"true"`/`"false"`, a raw text/number/date value, or `NULL_GROUP_KEY` for the
   * "no value" bucket. Only meaningful alongside `fieldId`. The kanban's drag-writes-the-grouping
   * behaviour needs the value, not just which field produced the column.
   */
  fieldValueKey?: string;
  bucket?: DueBucket;
  completed?: boolean;
  boardId?: string;
  workspaceId?: string;
  organisationId?: string;
}

/** The `meta.fieldValueKey` / group-key marker for a bucket holding cards with no value set. */
export const NULL_GROUP_KEY = "__none__";

/**
 * The board / workspace / organisation chain a cross-board view resolves a card's source against.
 *
 * Deliberately structural rather than the Global Work catalog types: a table rendering rows from
 * many boards needs a name and an icon per source and nothing else, and pinning this to
 * `WorkCatalog*` would make the board table depend on the Global Work DTO.
 */
export interface SourceBoardRef {
  inProgressEnabled?: boolean;
  /** The board's workspace has start dates and the timeline on (absent means on). */
  timelineEnabled?: boolean;
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
}

export interface SourceWorkspaceRef {
  id: string;
  organisationId: string;
  name: string;
  icon: string | null;
  accentColor: string | null;
  /** The workspace's time-in-progress alert in days (0 = off); omitted, the board's own applies. */
  inProgressAlertDays?: number;
  /** The workspace's time zone, whose working hours time in progress counts; omitted, the board's. */
  timeZone?: string;
}

export interface SourceOrganisationRef {
  id: string;
  name: string;
}

export interface CardGroup {
  /** Stable identifier for @for trackBy. */
  key: string;
  /** User-visible name. */
  label: string;
  /** Tabler icon name, or null. */
  icon: string | null;
  /** Color token (e.g. "blue") or hex/rgb, or null. */
  color: string | null;
  /** Avatar URL, or null. Used only for assignee grouping. */
  avatarUrl?: string | null;
  /** When true, drag-drop targets accept this group. */
  acceptsDrop: boolean;
  /** Original entity meta — handy for "+ Add card" routing or context. */
  meta: GroupMeta;
  /** Cards inside this group after sort. */
  cards: AnyCard[];
}

/** Visibility map keyed by column id. Custom fields use `cf:<fieldId>`. */
export type ColumnVisibility = Record<string, boolean>;

export const BUILTIN_COLUMN_IDS = [
  "priority",
  "status",
  "board",
  "assignees",
  "start",
  "due",
  "inProgress",
  "labels",
  "checklist",
  "updated",
  "created",
] as const;


export const GROUP_BY_OPTIONS: { value: BuiltinGroupBy; label: string; icon: string }[] = [
  { value: "list", label: $localize`:Group-by option - group cards by list:List`, icon: "layout-list" },
  { value: "assignee", label: $localize`:Group-by option - group cards by assignee:Assignee`, icon: "user" },
  { value: "label", label: $localize`:Group-by option - group cards by label:Label`, icon: "tag" },
  { value: "dueDate", label: $localize`:Group-by option - group cards by due date:Due date`, icon: "calendar-event" },
  { value: "completion", label: $localize`:Group-by option - group cards by completed or not:Completion`, icon: "circle-check" },
  { value: "none", label: $localize`:Group-by option - show cards ungrouped:No grouping`, icon: "minus" },
];

/**
 * Offered on top of GROUP_BY_OPTIONS by cross-board surfaces only. Ordered outermost first so the
 * menu reads as a containment chain rather than an alphabetical pile.
 */
export const CROSS_BOARD_GROUP_BY_OPTIONS: { value: BuiltinGroupBy; label: string; icon: string }[] = [
  { value: "organisation", label: $localize`:Group-by option - group cards by organisation:Organisation`, icon: "building" },
  { value: "workspace", label: $localize`:Group-by option - group cards by workspace:Workspace`, icon: "layout-grid" },
  { value: "board", label: $localize`:Group-by option - group cards by board:Board`, icon: "layout-kanban" },
];

export const SORT_BY_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "position", label: $localize`:Sort option - the order cards were arranged in by hand:Manual (position)` },
  { value: "title-asc", label: $localize`:Sort option - by title alphabetically:Title A → Z` },
  { value: "title-desc", label: $localize`:Sort option - by title reverse alphabetically:Title Z → A` },
  { value: "due-asc", label: $localize`:Sort option:Due date (soonest)` },
  { value: "due-desc", label: $localize`:Sort option:Due date (latest)` },
  { value: "start-asc", label: $localize`:Sort option - by planned start date, earliest first:Start date (earliest)` },
  { value: "start-desc", label: $localize`:Sort option - by planned start date, latest first:Start date (latest)` },
  { value: "created-desc", label: $localize`:Sort option - by creation date, newest first:Created (newest)` },
  { value: "created-asc", label: $localize`:Sort option - by creation date, oldest first:Created (oldest)` },
  { value: "updated-desc", label: $localize`:Sort option - by last update, newest first:Updated (newest)` },
  { value: "updated-asc", label: $localize`:Sort option - by last update, oldest first:Updated (oldest)` },
  { value: "in-progress-longest", label: $localize`:Sort option - cards in progress longest first:In progress (longest)` },
  { value: "in-progress-newest", label: $localize`:Sort option - cards that most recently started progress first:In progress (newest)` },
];

export const DUE_BUCKET_ORDER: DueBucket[] = ["overdue", "today", "tomorrow", "thisWeek", "later", "noDate"];

export const DUE_BUCKET_META: Record<DueBucket, { label: string; icon: string; color: string | null }> = {
  overdue: { label: $localize`:Due-date group heading - cards past their due date:Overdue`, icon: "alert-circle", color: "red" },
  today: { label: $localize`:Due-date group heading - cards due today:Today`, icon: "calendar-event", color: "orange" },
  tomorrow: { label: $localize`:Due-date group heading - cards due tomorrow:Tomorrow`, icon: "calendar-plus", color: "amber" },
  thisWeek: { label: $localize`:Due-date group heading - cards due later this week:This week`, icon: "calendar-week", color: "amber" },
  later: { label: $localize`:Due-date group heading - cards due after this week:Later`, icon: "calendar", color: "blue" },
  noDate: { label: $localize`:Due-date group heading - cards with no due date:No due date`, icon: "calendar-off", color: "gray" },
};
