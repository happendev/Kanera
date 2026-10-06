import type { dto } from "@kanera/shared";
import type { WireCardChecklist, WireCardChecklistItem } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardChecklistItems, cardChecklists, type ActivityEvent } from "@kanera/shared/schema";
import { randomUUID } from "node:crypto";
import type { Db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { AppError } from "../../lib/errors.js";
import { between, positionAtIndex } from "../../lib/position.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type IssuePath = (string | number)[];
export type NewItem = dto.NewChecklistItem | dto.NewSubChecklistItem;

/** One created item, with any sub-checklists created under it in the same request. */
export interface CreatedItemTree {
  item: WireCardChecklistItem;
  subChecklists: WireCardChecklist[];
}

/**
 * A semantic validation failure with the same `{ code, issues[].path }` shape as a Zod rejection, so
 * callers (and the MCP layer) can point at `items[2].subChecklists[0].items[1]` regardless of
 * whether the schema or a database-backed rule caught it.
 */
export function checklistValidationError(path: IssuePath, message: string): AppError {
  return new AppError(400, "VALIDATION", `${formatIssuePath(path)}: ${message}`, {
    issues: [{ code: "custom", path, message }],
  });
}

export function formatIssuePath(path: IssuePath): string {
  return path.reduce<string>((out, segment) =>
    typeof segment === "number" ? `${out}[${segment}]` : out ? `${out}.${segment}` : segment, "");
}

/** Evenly spaced positions for `count` new rows inserted between two neighbours. */
export function positionsBetween(prev: string | null, next: string | null, count: number): { positions: string[]; needsRebalance: boolean } {
  if (count === 0) return { positions: [], needsRebalance: false };
  if (next === null) {
    const positions: string[] = [];
    let cursor = prev;
    for (let index = 0; index < count; index += 1) {
      cursor = between(cursor, null).position;
      positions.push(cursor);
    }
    return { positions, needsRebalance: false };
  }
  if (prev === null) {
    const positions: string[] = [];
    let cursor = next;
    for (let index = 0; index < count; index += 1) {
      cursor = between(null, cursor).position;
      positions.unshift(cursor);
    }
    return { positions, needsRebalance: false };
  }
  const low = Number(prev);
  const step = (Number(next) - low) / (count + 1);
  const positions = Array.from({ length: count }, (_, index) => (low + step * (index + 1)).toFixed(10));
  // numeric(20,10) cannot separate rows closer than 1e-10; reuse between()'s threshold so a dense
  // insert renumbers the checklist instead of storing duplicate positions.
  return { positions, needsRebalance: step < 1e-6 };
}

function isTopLevelItem(item: NewItem): item is dto.NewChecklistItem {
  return "description" in item || "assigneeId" in item || "dueDateLocalDate" in item || "dueDateSlot" in item || "subChecklists" in item;
}

/**
 * Rejects top-level-only fields on items destined for a sub-checklist. The create-checklist schema
 * can see `parentItemId`, but item routes only learn the target's depth after loading it.
 */
export function assertLeafItems(items: readonly NewItem[], itemPath: (index: number) => IssuePath) {
  items.forEach((item, index) => {
    if (!isTopLevelItem(item)) return;
    for (const field of ["description", "assigneeId", "dueDateLocalDate", "dueDateSlot", "subChecklists"] as const) {
      if (item[field] !== undefined) {
        throw checklistValidationError([...itemPath(index), field], `the target is a sub-checklist, whose items support only text and completed; remove ${field}`);
      }
    }
  });
}

/** Every assignee referenced by new items, in request order, with the path of its first use. */
export function collectAssignees(items: readonly NewItem[], itemPath: (index: number) => IssuePath): Map<string, IssuePath> {
  const result = new Map<string, IssuePath>();
  items.forEach((item, index) => {
    if (isTopLevelItem(item) && item.assigneeId && !result.has(item.assigneeId)) {
      result.set(item.assigneeId, [...itemPath(index), "assigneeId"]);
    }
  });
  return result;
}

export function hasDueDates(items: readonly NewItem[]): boolean {
  return items.some((item) => isTopLevelItem(item) && Boolean(item.dueDateLocalDate));
}

function itemRow(item: NewItem, options: { checklistId: string; position: string; actorId: string; now: Date; timezone: string | null }) {
  const top = isTopLevelItem(item) ? item : null;
  const dueDateLocalDate = top?.dueDateLocalDate ?? null;
  return {
    id: randomUUID(),
    checklistId: options.checklistId,
    text: item.text,
    position: options.position,
    description: top?.description ?? null,
    assigneeId: top?.assigneeId ?? null,
    // Due-date derivation matches the item PATCH route: a date defaults its slot to "anyTime" and
    // captures the acting user's timezone so overdue evaluation is correct for that user.
    dueDateLocalDate,
    dueDateSlot: dueDateLocalDate ? (top?.dueDateSlot ?? "anyTime") : null,
    dueDateTimezone: dueDateLocalDate ? (options.timezone ?? "UTC") : null,
    completedAt: item.completed ? options.now : null,
    completedById: item.completed ? options.actorId : null,
  };
}

/**
 * Inserts items, then any sub-checklists and their leaf items, in three statements regardless of
 * tree size. IDs are generated here so parents and children connect inside one transaction; the
 * caller is responsible for locking the target checklist and for activity and realtime fanout.
 */
export async function insertChecklistItemTrees(tx: Tx, items: readonly NewItem[], options: {
  cardId: string;
  checklistId: string;
  positions: readonly string[];
  actorId: string;
  timezone: string | null;
  now: Date;
}): Promise<CreatedItemTree[]> {
  if (items.length === 0) return [];
  const rows = items.map((item, index) => itemRow(item, { ...options, position: options.positions[index]! }));
  const inserted = await tx.insert(cardChecklistItems).values(rows).returning();
  const insertedById = new Map(inserted.map((row) => [row.id, row]));

  const subChecklistRows: Array<typeof cardChecklists.$inferInsert & { id: string }> = [];
  const leafRows: ReturnType<typeof itemRow>[] = [];
  const subChecklistIdsByItem = new Map<string, string[]>();
  items.forEach((item, index) => {
    if (!isTopLevelItem(item)) return;
    const parentItemId = rows[index]!.id;
    item.subChecklists?.forEach((sub, subIndex) => {
      const id = randomUUID();
      // A brand-new parent item has no existing sub-checklists, so request order maps directly to
      // fresh evenly spaced positions without probing siblings.
      subChecklistRows.push({ id, cardId: options.cardId, parentItemId, title: sub.title, position: positionAtIndex(subIndex) });
      subChecklistIdsByItem.set(parentItemId, [...(subChecklistIdsByItem.get(parentItemId) ?? []), id]);
      sub.items?.forEach((leaf, leafIndex) => {
        leafRows.push(itemRow(leaf, { ...options, checklistId: id, position: positionAtIndex(leafIndex) }));
      });
    });
  });

  const insertedSubChecklists = subChecklistRows.length > 0
    ? await tx.insert(cardChecklists).values(subChecklistRows).returning()
    : [];
  const insertedLeaves = leafRows.length > 0
    ? await tx.insert(cardChecklistItems).values(leafRows).returning()
    : [];
  const insertedLeavesById = new Map(insertedLeaves.map((row) => [row.id, row]));
  const leavesByChecklist = new Map<string, WireCardChecklistItem[]>();
  for (const leaf of leafRows) {
    leavesByChecklist.set(leaf.checklistId, [...(leavesByChecklist.get(leaf.checklistId) ?? []), insertedLeavesById.get(leaf.id)!]);
  }
  const subChecklistsById = new Map(insertedSubChecklists.map((row) => [row.id, row]));

  return rows.map((row) => ({
    item: insertedById.get(row.id)!,
    subChecklists: (subChecklistIdsByItem.get(row.id) ?? []).map((id) => ({
      ...subChecklistsById.get(id)!,
      items: leavesByChecklist.get(id) ?? [],
    })),
  }));
}

/** Activity rows written for created items; emitted by the caller after commit. */
export interface ItemCreationActivities {
  /** One `checklistItem:created` row per item, only when the caller asked for per-item audit rows. */
  created: ActivityEvent[];
  /** Assignment rows; each also drives the assignee's direct "assigned" notification. */
  assigned: Array<{ activity: ActivityEvent; assigneeId: string }>;
  /** Feed-only due-date rows (due-date changes never notify; overdue does). */
  dueDates: ActivityEvent[];
  /** `checklist:created` rows for sub-checklists created under new items. */
  subChecklistsCreated: ActivityEvent[];
}

/**
 * Records the audit trail for newly created items. Creation with an assignee or due date writes the
 * same activity kinds a follow-up update would, so a one-call plan leaves the same feed and the
 * same assignee notification as the equivalent sequence of single edits.
 */
export async function recordItemCreationActivities(tx: Tx, input: {
  boardId: string;
  workspaceId: string;
  cardId: string;
  actorId: string;
  checklist: { id: string; title: string };
  trees: readonly CreatedItemTree[];
  assigneeNames: ReadonlyMap<string, string | null>;
  recordCreated: boolean;
}): Promise<ItemCreationActivities> {
  const base = { boardId: input.boardId, workspaceId: input.workspaceId, actorId: input.actorId, entityType: "card" as const, entityId: input.cardId };
  const result: ItemCreationActivities = { created: [], assigned: [], dueDates: [], subChecklistsCreated: [] };
  for (const { item, subChecklists } of input.trees) {
    if (input.recordCreated) {
      result.created.push(await recordActivity(tx, {
        ...base,
        action: ACTIVITY_ACTION.CHECKLIST_ITEM_CREATED,
        payload: { checklistId: input.checklist.id, itemId: item.id, text: item.text },
      }));
    }
    if (item.assigneeId) {
      result.assigned.push({
        assigneeId: item.assigneeId,
        activity: await recordActivity(tx, {
          ...base,
          action: ACTIVITY_ACTION.CHECKLIST_ITEM_ASSIGNEE_SET,
          payload: {
            checklistId: input.checklist.id,
            checklistTitle: input.checklist.title,
            itemId: item.id,
            itemText: item.text,
            assigneeId: item.assigneeId,
            assigneeName: input.assigneeNames.get(item.assigneeId) ?? null,
            previousAssigneeId: null,
            previousAssigneeName: null,
            fromValue: null,
            toValue: item.assigneeId,
          },
        }),
      });
    }
    if (item.dueDateLocalDate) {
      result.dueDates.push(await recordActivity(tx, {
        ...base,
        action: ACTIVITY_ACTION.CHECKLIST_ITEM_DUE_DATE_SET,
        payload: {
          checklistId: input.checklist.id,
          checklistTitle: input.checklist.title,
          itemId: item.id,
          itemText: item.text,
          dueDateLocalDate: item.dueDateLocalDate,
          dueDateSlot: item.dueDateSlot,
          dueDateTimezone: item.dueDateTimezone,
          fromValue: null,
          toValue: item.dueDateLocalDate,
        },
      }));
    }
    for (const sub of subChecklists) {
      result.subChecklistsCreated.push(await recordActivity(tx, {
        ...base,
        action: ACTIVITY_ACTION.CHECKLIST_CREATED,
        payload: { checklistId: sub.id, parentItemId: item.id, title: sub.title, itemCount: sub.items.length },
      }));
    }
  }
  return result;
}
