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
  // Time in progress, by start: `inProgressAsc` is the earliest start first, i.e. longest in
  // progress for open work. Cards not in progress sort last in both directions.
  "inProgressAsc",
  "inProgressDesc",
] as const;
/**
 * `priorities` is retired: it was a Team Cards display of every readable teammate's "Up next" queue
 * side by side. It stays in the enum only so saved views and preferences that still name it parse;
 * the web client opens Team overview in its place, where a docked panel curates one person's queue.
 * There is still no priority `WORK_SORT_VALUES` entry: rank is a property of the (user, card) pair,
 * so under `team` one card has several ranks and there is no single `ORDER BY` at all.
 *
 * `overview` is the Team Cards manager overview: one panel per teammate combining their work in
 * progress (cards in In progress lists), their own recent activity, their Up next head, their other
 * open cards by due date and their recent completions, plus in-progress work nobody owns. It composes
 * the card query, the priority batch and the team work-done feed on the client, so it adds no
 * endpoint of its own.
 *
 * `dependencies` maps the blocking chains the lens's loaded cards sit in, across boards: the same
 * view a board offers, seeded with the loaded cards instead of one board's.
 *
 * `timeline` is the board Timeline (Gantt) over the loaded cards, grouped by board by default, with
 * one schedule read per workspace in view.
 */
export const WORK_DISPLAY_MODES = ["board", "table", "calendar", "timeline", "priorities", "overview", "history", "summary", "dependencies"] as const;
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

export const WORK_CUSTOM_FIELD_CONDITION_OPS = [
  "contains", "equals", "eq", "neq", "gt", "gte", "lt", "lte",
  "on", "before", "after", "between", "checked", "unchecked",
  "isAnyOf", "isNoneOf", "isEmpty", "isNotEmpty",
] as const;
