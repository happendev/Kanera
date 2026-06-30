import type { WireBoardMemberUser, WireCard, WireCardLabel, WireCardSummary, WireCustomField, WireList } from "@kanera/shared/events";
import type { Card, CardLabel, CustomField, List } from "@kanera/shared/schema";

// Lane item types live with BoardState (the canonical owner); re-export here so list-view code can
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
  | "none";

export type CustomFieldGroupBy = `cf:${string}`;

export type GroupBy = BuiltinGroupBy | CustomFieldGroupBy;

export type SortBy =
  | "position"
  | "title-asc"
  | "title-desc"
  | "due-asc"
  | "due-desc"
  | "created-desc"
  | "created-asc"
  | "updated-desc"
  | "updated-asc";

export type AggregateMetric = "sum" | "avg";

export type AggregateConfig = Record<string, AggregateMetric[]>;

export type DueBucket = "overdue" | "today" | "tomorrow" | "thisWeek" | "later" | "noDate";

export interface GroupMeta {
  listId?: string;
  userId?: string;
  labelId?: string;
  fieldId?: string;
  bucket?: DueBucket;
  completed?: boolean;
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
  "status",
  "board",
  "assignees",
  "due",
  "labels",
  "checklist",
  "updated",
  "created",
  "description",
] as const;

export type BuiltinColumnId = typeof BUILTIN_COLUMN_IDS[number];

export interface ColumnDef {
  id: string;
  label: string;
  icon: string;
}

export const GROUP_BY_OPTIONS: { value: BuiltinGroupBy; label: string; icon: string }[] = [
  { value: "list", label: "List", icon: "layout-list" },
  { value: "assignee", label: "Assignee", icon: "user" },
  { value: "label", label: "Label", icon: "tag" },
  { value: "dueDate", label: "Due date", icon: "calendar-event" },
  { value: "completion", label: "Completion", icon: "circle-check" },
  { value: "none", label: "No grouping", icon: "minus" },
];

export const SORT_BY_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "position", label: "Manual (position)" },
  { value: "title-asc", label: "Title A → Z" },
  { value: "title-desc", label: "Title Z → A" },
  { value: "due-asc", label: "Due date (soonest)" },
  { value: "due-desc", label: "Due date (latest)" },
  { value: "created-desc", label: "Created (newest)" },
  { value: "created-asc", label: "Created (oldest)" },
  { value: "updated-desc", label: "Updated (newest)" },
  { value: "updated-asc", label: "Updated (oldest)" },
];

export const DUE_BUCKET_ORDER: DueBucket[] = ["overdue", "today", "tomorrow", "thisWeek", "later", "noDate"];

export const DUE_BUCKET_META: Record<DueBucket, { label: string; icon: string; color: string | null }> = {
  overdue: { label: "Overdue", icon: "alert-circle", color: "red" },
  today: { label: "Today", icon: "calendar-event", color: "orange" },
  tomorrow: { label: "Tomorrow", icon: "calendar-plus", color: "amber" },
  thisWeek: { label: "This week", icon: "calendar-week", color: "amber" },
  later: { label: "Later", icon: "calendar", color: "blue" },
  noDate: { label: "No due date", icon: "calendar-off", color: "gray" },
};
