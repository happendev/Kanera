import {
  type AnyCard,
  type AnyCustomField,
  type AnyList,
  type AnyLabel,
  type AnyMember,
  type CardGroup,
  type DueBucket,
  DUE_BUCKET_META,
  DUE_BUCKET_ORDER,
  type GroupBy,
  type SortBy,
} from "./list-view.types";
import type { CardCustomFieldValue } from "@kanera/shared/schema";

export interface GroupingContext {
  lists: AnyList[];
  labels: AnyLabel[];
  members: AnyMember[];
  customFields?: AnyCustomField[];
  labelsByCard: Map<string, AnyLabel[]>;
  assigneesByCard: Map<string, AnyMember[]>;
  customFieldValuesByCardAndField?: Map<string, Map<string, CardCustomFieldValue>>;
  currentUserId: string | null;
  now?: Date;
}

const NULL_GROUP_KEY = "__none__";

/** Classify a card's due date into a coarse bucket for grouping. */
export function dueBucket(card: AnyCard, now: Date = new Date()): DueBucket {
  const date = card.dueDateLocalDate;
  if (!date) return "noDate";
  const today = formatLocalYMD(now);
  if (date < today) return card.completedAt ? "later" : "overdue";
  if (date === today) return "today";
  const tomorrow = formatLocalYMD(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (date === tomorrow) return "tomorrow";
  // Within the next 7 days (inclusive of today + 6).
  const sixDaysAhead = formatLocalYMD(new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000));
  if (date <= sixDaysAhead) return "thisWeek";
  return "later";
}

function formatLocalYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Group + sort the given cards by the requested dimensions. */
export function groupCards(
  cards: AnyCard[],
  mode: GroupBy,
  sortMode: SortBy,
  ctx: GroupingContext,
): CardGroup[] {
  if (mode.startsWith("cf:")) {
    return groupByCustomField(cards, mode.slice(3), ctx, sortMode);
  }

  switch (mode) {
    case "list":
      return groupByList(cards, ctx, sortMode);
    case "assignee":
      return groupByAssignee(cards, ctx, sortMode);
    case "label":
      return groupByLabel(cards, ctx, sortMode);
    case "dueDate":
      return groupByDueDate(cards, ctx, sortMode);
    case "completion":
      return groupByCompletion(cards, sortMode);
    case "none":
    default:
      return groupByNoGrouping(cards, sortMode);
  }
}

function groupByNoGrouping(cards: AnyCard[], sortMode: SortBy): CardGroup[] {
  return [
    {
      key: "all",
      label: "All cards",
      icon: null,
      color: null,
      acceptsDrop: false,
      meta: {},
      cards: sortGroupCards(cards, sortMode),
    },
  ];
}

function groupByCustomField(cards: AnyCard[], fieldId: string, ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const field = ctx.customFields?.find((f) => f.id === fieldId);
  if (!field) return groupByNoGrouping(cards, sortMode);

  switch (field.type) {
    case "checkbox":
      return groupByCheckboxField(cards, field, ctx, sortMode);
    case "number":
      return groupByNumberField(cards, field, ctx, sortMode);
    case "select":
      return groupBySelectField(cards, field, ctx, sortMode);
    case "user":
      return groupByUserField(cards, field, ctx, sortMode);
    case "date":
      return groupByDateField(cards, field, ctx, sortMode);
    case "url":
      // URL values are effectively unique per card; grouping by them is not useful.
      return groupByNoGrouping(cards, sortMode);
    case "text":
    default:
      return groupByTextField(cards, field, ctx, sortMode);
  }
}

function groupBySelectField(cards: AnyCard[], field: AnyCustomField, ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const options = "options" in field ? field.options : [];
  const byOption = new Map<string, AnyCard[]>();
  const empty: AnyCard[] = [];

  for (const card of cards) {
    const ids = valueFor(ctx, card.id, field.id)?.valueOptionIds ?? [];
    if (!ids.length) {
      empty.push(card);
      continue;
    }
    // Multi-value cards appear under each selected option.
    for (const id of ids) appendGroupCard(byOption, id, card);
  }

  // Render groups in the field's configured option order; skip empty option buckets.
  const groups = options
    .filter((option) => byOption.has(option.id))
    .map((option) => customFieldGroup(field, option.id, option.label, byOption.get(option.id) ?? [], sortMode));
  appendEmptyCustomFieldGroup(groups, field, empty, sortMode);
  return groups;
}

function groupByUserField(cards: AnyCard[], field: AnyCustomField, ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const byUser = new Map<string, AnyCard[]>();
  const empty: AnyCard[] = [];

  for (const card of cards) {
    const ids = valueFor(ctx, card.id, field.id)?.valueUserIds ?? [];
    if (!ids.length) {
      empty.push(card);
      continue;
    }
    for (const id of ids) appendGroupCard(byUser, id, card);
  }

  const memberById = new Map(ctx.members.map((member) => [member.userId, member]));
  const orderedUserIds = [...byUser.keys()].sort((a, b) =>
    (memberById.get(a)?.displayName ?? "").localeCompare(memberById.get(b)?.displayName ?? ""),
  );
  const groups = orderedUserIds.map((userId) => {
    const member = memberById.get(userId);
    const group = customFieldGroup(field, userId, member?.displayName ?? "Unknown", byUser.get(userId) ?? [], sortMode);
    return { ...group, icon: null, avatarUrl: member?.avatarUrl ?? null };
  });
  appendEmptyCustomFieldGroup(groups, field, empty, sortMode);
  return groups;
}

function groupByDateField(cards: AnyCard[], field: AnyCustomField, ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const byValue = new Map<string, AnyCard[]>();
  const empty: AnyCard[] = [];

  for (const card of cards) {
    const value = valueFor(ctx, card.id, field.id)?.valueDate?.trim() ?? "";
    if (!value) empty.push(card);
    else appendGroupCard(byValue, value, card);
  }

  const groups = [...byValue.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => customFieldGroup(field, value, value, byValue.get(value) ?? [], sortMode));
  appendEmptyCustomFieldGroup(groups, field, empty, sortMode);
  return groups;
}

function groupByTextField(cards: AnyCard[], field: AnyCustomField, ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const byValue = new Map<string, AnyCard[]>();
  const empty: AnyCard[] = [];

  for (const card of cards) {
    const value = valueFor(ctx, card.id, field.id)?.valueText?.trim() ?? "";
    if (!value) empty.push(card);
    else appendGroupCard(byValue, value, card);
  }

  const groups = [...byValue.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => customFieldGroup(field, value, value, byValue.get(value) ?? [], sortMode));
  appendEmptyCustomFieldGroup(groups, field, empty, sortMode);
  return groups;
}

function groupByNumberField(cards: AnyCard[], field: AnyCustomField, ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const byValue = new Map<string, AnyCard[]>();
  const empty: AnyCard[] = [];

  for (const card of cards) {
    const raw = valueFor(ctx, card.id, field.id)?.valueNumber;
    if (raw === null || raw === undefined || raw === "") empty.push(card);
    else appendGroupCard(byValue, String(raw), card);
  }

  const groups = [...byValue.keys()]
    .sort((a, b) => Number(a) - Number(b))
    .map((value) => customFieldGroup(field, value, value, byValue.get(value) ?? [], sortMode));
  appendEmptyCustomFieldGroup(groups, field, empty, sortMode);
  return groups;
}

function groupByCheckboxField(cards: AnyCard[], field: AnyCustomField, ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const yes: AnyCard[] = [];
  const no: AnyCard[] = [];
  const empty: AnyCard[] = [];

  for (const card of cards) {
    const value = valueFor(ctx, card.id, field.id)?.valueCheckbox;
    if (value === true) yes.push(card);
    else if (value === false) no.push(card);
    else empty.push(card);
  }

  const groups: CardGroup[] = [];
  if (yes.length) groups.push(customFieldGroup(field, "true", "Yes", yes, sortMode, "checkbox"));
  if (no.length) groups.push(customFieldGroup(field, "false", "No", no, sortMode, "square"));
  appendEmptyCustomFieldGroup(groups, field, empty, sortMode);
  return groups;
}

function customFieldGroup(
  field: AnyCustomField,
  valueKey: string,
  label: string,
  cards: AnyCard[],
  sortMode: SortBy,
  icon = field.icon || "forms",
): CardGroup {
  return {
    key: `cf:${field.id}:${valueKey}`,
    label,
    icon,
    color: null,
    acceptsDrop: false,
    meta: { fieldId: field.id },
    cards: sortGroupCards(cards, sortMode),
  };
}

function appendEmptyCustomFieldGroup(groups: CardGroup[], field: AnyCustomField, cards: AnyCard[], sortMode: SortBy) {
  if (!cards.length) return;
  groups.push(customFieldGroup(field, NULL_GROUP_KEY, `No ${field.name}`, cards, sortMode, "forms-off"));
}

function appendGroupCard(map: Map<string, AnyCard[]>, key: string, card: AnyCard) {
  const bucket = map.get(key);
  if (bucket) bucket.push(card);
  else map.set(key, [card]);
}

function valueFor(ctx: GroupingContext, cardId: string, fieldId: string): CardCustomFieldValue | null {
  return ctx.customFieldValuesByCardAndField?.get(cardId)?.get(fieldId) ?? null;
}

function groupByList(cards: AnyCard[], ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const sortedLists = [...ctx.lists]
    .filter((list) => !list.archivedAt)
    .sort((a, b) => Number(a.position) - Number(b.position));
  const byList = new Map<string, AnyCard[]>();
  for (const card of cards) {
    const bucket = byList.get(card.listId);
    if (bucket) bucket.push(card);
    else byList.set(card.listId, [card]);
  }
  return sortedLists.map((list) => ({
    key: `list:${list.id}`,
    label: list.name,
    icon: list.icon ?? "layout-list",
    color: list.color ?? null,
    acceptsDrop: true,
    meta: { listId: list.id },
    cards: sortGroupCards(byList.get(list.id) ?? [], sortMode),
  }));
}

function groupByAssignee(cards: AnyCard[], ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const byUser = new Map<string, AnyCard[]>();
  const unassigned: AnyCard[] = [];
  for (const card of cards) {
    const assignees = ctx.assigneesByCard.get(card.id);
    if (!assignees || assignees.length === 0) {
      unassigned.push(card);
      continue;
    }
    for (const member of assignees) {
      const bucket = byUser.get(member.userId);
      if (bucket) bucket.push(card);
      else byUser.set(member.userId, [card]);
    }
  }

  const memberById = new Map(ctx.members.map((member) => [member.userId, member]));
  const seen = new Set<string>();
  const groups: CardGroup[] = [];

  const orderedMembers = [...ctx.members].sort((a, b) => {
    if (a.userId === ctx.currentUserId) return -1;
    if (b.userId === ctx.currentUserId) return 1;
    return (a.displayName ?? "").localeCompare(b.displayName ?? "");
  });

  for (const member of orderedMembers) {
    if (!byUser.has(member.userId)) continue;
    seen.add(member.userId);
    groups.push({
      key: `assignee:${member.userId}`,
      label: member.userId === ctx.currentUserId ? "Me" : member.displayName,
      icon: null,
      color: null,
      avatarUrl: member.avatarUrl,
      acceptsDrop: false,
      meta: { userId: member.userId },
      cards: sortGroupCards(byUser.get(member.userId) ?? [], sortMode),
    });
  }

  // Any unknown user ids (e.g. removed members) — render after known ones.
  for (const [userId, list] of byUser) {
    if (seen.has(userId)) continue;
    const member = memberById.get(userId);
    groups.push({
      key: `assignee:${userId}`,
      label: member?.displayName ?? "Unknown",
      icon: null,
      color: null,
      avatarUrl: member?.avatarUrl ?? null,
      acceptsDrop: false,
      meta: { userId },
      cards: sortGroupCards(list, sortMode),
    });
  }

  if (unassigned.length > 0) {
    groups.push({
      key: `assignee:${NULL_GROUP_KEY}`,
      label: "Unassigned",
      icon: "user-off",
      color: "gray",
      acceptsDrop: false,
      meta: {},
      cards: sortGroupCards(unassigned, sortMode),
    });
  }

  return groups;
}

function groupByLabel(cards: AnyCard[], ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const byLabel = new Map<string, AnyCard[]>();
  const unlabeled: AnyCard[] = [];
  for (const card of cards) {
    const labels = ctx.labelsByCard.get(card.id);
    if (!labels || labels.length === 0) {
      unlabeled.push(card);
      continue;
    }
    for (const label of labels) {
      const bucket = byLabel.get(label.id);
      if (bucket) bucket.push(card);
      else byLabel.set(label.id, [card]);
    }
  }

  const groups: CardGroup[] = [];
  const orderedLabels = [...ctx.labels].sort((a, b) => Number(a.position) - Number(b.position));
  for (const label of orderedLabels) {
    if (!byLabel.has(label.id)) continue;
    groups.push({
      key: `label:${label.id}`,
      label: label.name,
      icon: "tag",
      color: label.color ?? null,
      acceptsDrop: false,
      meta: { labelId: label.id },
      cards: sortGroupCards(byLabel.get(label.id) ?? [], sortMode),
    });
  }

  if (unlabeled.length > 0) {
    groups.push({
      key: `label:${NULL_GROUP_KEY}`,
      label: "No label",
      icon: "tag-off",
      color: "gray",
      acceptsDrop: false,
      meta: {},
      cards: sortGroupCards(unlabeled, sortMode),
    });
  }

  return groups;
}

function groupByDueDate(cards: AnyCard[], ctx: GroupingContext, sortMode: SortBy): CardGroup[] {
  const byBucket = new Map<DueBucket, AnyCard[]>();
  const now = ctx.now ?? new Date();
  for (const card of cards) {
    const bucket = dueBucket(card, now);
    const list = byBucket.get(bucket);
    if (list) list.push(card);
    else byBucket.set(bucket, [card]);
  }

  return DUE_BUCKET_ORDER
    .filter((bucket) => byBucket.has(bucket))
    .map((bucket) => {
      const meta = DUE_BUCKET_META[bucket];
      return {
        key: `due:${bucket}`,
        label: meta.label,
        icon: meta.icon,
        color: meta.color,
        acceptsDrop: false,
        meta: { bucket },
        cards: sortGroupCards(byBucket.get(bucket) ?? [], sortMode),
      };
    });
}

function groupByCompletion(cards: AnyCard[], sortMode: SortBy): CardGroup[] {
  const open: AnyCard[] = [];
  const done: AnyCard[] = [];
  for (const card of cards) {
    if (card.completedAt) done.push(card);
    else open.push(card);
  }
  const groups: CardGroup[] = [];
  if (open.length > 0) {
    groups.push({
      key: "completion:open",
      label: "Open",
      icon: "circle",
      color: null,
      acceptsDrop: false,
      meta: { completed: false },
      cards: sortGroupCards(open, sortMode),
    });
  }
  if (done.length > 0) {
    groups.push({
      key: "completion:done",
      label: "Completed",
      icon: "circle-check",
      color: "green",
      acceptsDrop: false,
      meta: { completed: true },
      cards: sortGroupCards(done, sortMode),
    });
  }
  return groups;
}

/**
 * Sort cards inside a group. Position sort is the natural board order; all
 * date sorts pin missing values to the bottom so that empty-due-date cards
 * don't dominate the top when a user picks "due date" sort.
 */
export function sortGroupCards(cards: AnyCard[], mode: SortBy): AnyCard[] {
  const arr = [...cards];
  switch (mode) {
    case "position":
      return arr.sort((a, b) => Number(a.position) - Number(b.position));
    case "title-asc":
      return arr.sort((a, b) => a.title.localeCompare(b.title));
    case "title-desc":
      return arr.sort((a, b) => b.title.localeCompare(a.title));
    case "due-asc":
      return arr.sort(byNullableString((c) => c.dueDateLocalDate, "asc"));
    case "due-desc":
      return arr.sort(byNullableString((c) => c.dueDateLocalDate, "desc"));
    case "created-desc":
      return arr.sort(byDate((c) => c.createdAt as unknown as string | Date, "desc"));
    case "created-asc":
      return arr.sort(byDate((c) => c.createdAt as unknown as string | Date, "asc"));
    case "updated-desc":
      return arr.sort(byDate((c) => c.updatedAt as unknown as string | Date, "desc"));
    case "updated-asc":
      return arr.sort(byDate((c) => c.updatedAt as unknown as string | Date, "asc"));
    default:
      return arr;
  }
}

function byNullableString<T>(get: (item: T) => string | null | undefined, dir: "asc" | "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return (a: T, b: T) => {
    const av = get(a);
    const bv = get(b);
    if (!av && !bv) return 0;
    if (!av) return 1; // empties at bottom
    if (!bv) return -1;
    return sign * av.localeCompare(bv);
  };
}

function byDate<T>(get: (item: T) => string | Date | null | undefined, dir: "asc" | "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return (a: T, b: T) => {
    const at = toTime(get(a));
    const bt = toTime(get(b));
    if (at === bt) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return sign * (at - bt);
  };
}

function toTime(value: string | Date | null | undefined): number {
  if (!value) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}
