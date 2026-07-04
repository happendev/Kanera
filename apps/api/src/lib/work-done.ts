import type {
  WorkDoneChecklistItemCompletedEvent,
  WorkDoneEvent,
  WorkDoneMovedEvent,
  WorkDoneResponse,
} from "@kanera/shared/dto";
import { ACTIVITY_ACTION, activityEvents, cardChecklistItems, cardChecklists, cardSummaryView, users } from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import { toWireCardSummary } from "./card-summary.js";
import { badRequest } from "./errors.js";
import { assignedCardVisibility } from "./access.js";

/** Furthest back the historical view may look — keeps the queryable window bounded. */
export const WORK_DONE_MAX_DAYS = 60;

/**
 * Rejects requests whose day falls outside the allowed window: no further back
 * than WORK_DONE_MAX_DAYS, and not in the future. The cap is enforced at query
 * time only — activity rows are never pruned, since they also power the card
 * activity feed and coalescing.
 */
export function assertWorkDoneWindow(from: Date, to: Date): void {
  const now = Date.now();
  const floor = now - WORK_DONE_MAX_DAYS * 24 * 60 * 60 * 1000;
  if (from.getTime() < floor) throw badRequest(`work-done history is limited to the last ${WORK_DONE_MAX_DAYS} days`);
  if (from.getTime() > now) throw badRequest("work-done day cannot be in the future");
  if (to.getTime() <= from.getTime()) throw badRequest("invalid work-done day range");
}

interface LoadWorkDoneOptions {
  clientId: string;
  /** Boards to scope the query to. An empty array short-circuits to no results. */
  boardIds: string[];
  /** When set, only include cards assigned to this user. */
  assigneeUserId?: string;
  /** Security boundary for members restricted to cards assigned directly or via checklist. */
  visibilityUserId?: string;
  /** When supplied, assignment visibility applies only to these boards. */
  visibilityRestrictedBoardIds?: string[];
  /** When set, only include historical actions performed by this user. */
  actorUserId?: string;
  /** When set, only include historical actions performed by these users. */
  actorUserIds?: string[];
  /** Inclusive lower bound (start of the selected local day). */
  from: Date;
  /** Exclusive upper bound (start of the following day). */
  to: Date;
  /** Optional case-insensitive title filter. */
  q?: string;
}

function escapedSearchPattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

function actorDisplay(activity: { actorKind: string; apiKeyName: string | null }, user: { displayName: string; avatarUrl: string | null } | null): {
  name: string;
  avatarUrl: string | null;
} {
  if (activity.actorKind === "system") return { name: "Kanera", avatarUrl: null };
  if (activity.actorKind === "apiKey") return { name: activity.apiKeyName ?? "API key", avatarUrl: null };
  return { name: user?.displayName ?? "Unknown", avatarUrl: user?.avatarUrl ?? null };
}

/**
 * Returns a flat, time-ordered stream of work-done events within [from, to):
 * cards created, moved, and marked complete, plus checklist items completed.
 * Each event is a single timeline row. Consecutive moves of the same card are
 * coalesced into one row (a card bounced across several lists in a day reads as
 * one "moved" milestone, not noise); created/completed stay as their own rows.
 * Checklist completions are sourced from the item's current completed_at value,
 * so reopening and recompleting an item attributes it to the latest completion.
 */
export async function loadWorkDone(opts: LoadWorkDoneOptions): Promise<WorkDoneResponse> {
  if (opts.boardIds.length === 0) return { events: [] };
  if (opts.actorUserIds && opts.actorUserIds.length === 0) return { events: [] };
  const visibilityPredicate = opts.visibilityUserId
    ? opts.visibilityRestrictedBoardIds
      ? opts.visibilityRestrictedBoardIds.length === 0
        ? undefined
        : or(
            notInArray(cardSummaryView.boardId, opts.visibilityRestrictedBoardIds),
            assignedCardVisibility(opts.visibilityUserId, cardSummaryView.id),
          )
      : assignedCardVisibility(opts.visibilityUserId, cardSummaryView.id)
    : undefined;

  const rows = await db
    .select()
    .from(activityEvents)
    .innerJoin(cardSummaryView, eq(cardSummaryView.id, activityEvents.entityId))
    .leftJoin(users, eq(users.id, activityEvents.actorId))
    .where(and(
      eq(activityEvents.entityType, "card"),
      // Card completion is recorded two ways: the bulk "complete list" path writes a
      // plain `completed` action, while the normal single-card toggle writes a coalesced
      // `completion:set` (whose payload.toValue tells us complete vs un-complete). Pull
      // both; un-completions are filtered out below. "uncompleted" is excluded outright.
      inArray(activityEvents.action, [
        ACTIVITY_ACTION.CREATED,
        ACTIVITY_ACTION.MOVED,
        ACTIVITY_ACTION.COMPLETED,
        ACTIVITY_ACTION.COMPLETION_SET,
      ]),
      inArray(activityEvents.boardId, opts.boardIds),
      gte(activityEvents.createdAt, opts.from),
      lt(activityEvents.createdAt, opts.to),
      isNull(cardSummaryView.archivedAt),
      opts.assigneeUserId ? sql`${opts.assigneeUserId} = any(${cardSummaryView.assigneeIds})` : undefined,
      visibilityPredicate,
      opts.actorUserId ? eq(activityEvents.actorId, opts.actorUserId) : undefined,
      opts.actorUserIds ? inArray(activityEvents.actorId, opts.actorUserIds) : undefined,
      opts.q ? sql`lower(${cardSummaryView.title}) like ${escapedSearchPattern(opts.q)} escape '\\'` : undefined,
    ))
    .orderBy(activityEvents.createdAt);

  const cardEvents: WorkDoneEvent[] = [];
  // Tracks the open coalesced "moved" run per card so consecutive moves merge.
  // Any non-move row for a card (created/completed) closes its run, since those
  // are emitted as their own rows in between.
  const openMove = new Map<string, WorkDoneMovedEvent>();

  // Rows arrive oldest-first, so for a coalesced move run the first row we see is
  // the earliest (source) and the last wins the destination/actor/timestamp.
  for (const row of rows) {
    const activity = row.activity_event;
    const card = row.card_summary_view;
    const payload = (activity.payload ?? {}) as { toListId?: string; fromListId?: string; toValue?: boolean };
    const actor = actorDisplay(activity, row.user);
    const at = activity.createdAt.toISOString();
    const actorUserId = activity.actorKind === "user" ? activity.actorId : null;
    const cardSummary = toWireCardSummary(card, opts.clientId);
    const base = {
      card: cardSummary,
      boardId: card.boardId,
      listId: card.listId,
      actorUserId,
      actorName: actor.name,
      actorAvatarUrl: actor.avatarUrl,
    };

    if (activity.action === ACTIVITY_ACTION.MOVED) {
      const toListId = payload.toListId ?? card.listId;
      const existing = openMove.get(card.id);
      if (existing) {
        // Extend the run: append this move's destination so the row keeps the full
        // path the card travelled (To Do -> Doing -> Done), and advance to the latest.
        existing.listPath.push(toListId);
        existing.at = at;
        existing.listId = card.listId;
        existing.card = cardSummary;
        existing.actorUserId = actorUserId;
        existing.actorName = actor.name;
        existing.actorAvatarUrl = actor.avatarUrl;
        continue;
      }
      const moved: WorkDoneMovedEvent = {
        ...base,
        id: activity.id,
        type: "moved",
        at,
        // Start the path at the source (when known) so a single move reads [from, to].
        listPath: payload.fromListId ? [payload.fromListId, toListId] : [toListId],
      };
      openMove.set(card.id, moved);
      cardEvents.push(moved);
      continue;
    }

    // A single-card completion toggle records `completion:set`; only surface it when
    // the (possibly coalesced) final state is "complete". Un-completions aren't work done.
    if (activity.action === ACTIVITY_ACTION.COMPLETION_SET && payload.toValue !== true) continue;

    // created / completed each get their own row and break any open move run.
    openMove.delete(card.id);
    cardEvents.push({
      ...base,
      id: activity.id,
      type: activity.action === ACTIVITY_ACTION.CREATED ? "created" : "completed",
      at,
    });
  }

  const checklistRows = await db
    .select()
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardChecklists.cardId))
    .leftJoin(users, eq(users.id, cardChecklistItems.completedById))
    .where(and(
      inArray(cardSummaryView.boardId, opts.boardIds),
      gte(cardChecklistItems.completedAt, opts.from),
      lt(cardChecklistItems.completedAt, opts.to),
      isNull(cardSummaryView.archivedAt),
      visibilityPredicate,
      opts.actorUserId ? eq(cardChecklistItems.completedById, opts.actorUserId) : undefined,
      opts.actorUserIds ? inArray(cardChecklistItems.completedById, opts.actorUserIds) : undefined,
      opts.q
        ? sql`(
            lower(${cardChecklistItems.text}) like ${escapedSearchPattern(opts.q)} escape '\\'
            or lower(${cardChecklists.title}) like ${escapedSearchPattern(opts.q)} escape '\\'
            or lower(${cardSummaryView.title}) like ${escapedSearchPattern(opts.q)} escape '\\'
          )`
        : undefined,
    ))
    .orderBy(sql`${cardChecklistItems.completedAt} desc`);

  const checklistEvents: WorkDoneChecklistItemCompletedEvent[] = checklistRows.map((row) => {
    const item = row.card_checklist_item;
    const checklist = row.card_checklist;
    const card = row.card_summary_view;
    const completedBy = row.user;
    return {
      // Namespaced so it never collides with an activity id sharing the same uuid space.
      id: `checklistItem:${item.id}`,
      type: "checklistItemCompleted",
      at: item.completedAt!.toISOString(),
      card: toWireCardSummary(card, opts.clientId),
      boardId: card.boardId,
      listId: card.listId,
      itemId: item.id,
      text: item.text,
      checklistId: checklist.id,
      checklistTitle: checklist.title,
      completedByUserId: item.completedById,
      completedByName: completedBy?.displayName ?? "Unknown",
      completedByAvatarUrl: completedBy?.avatarUrl ?? null,
    };
  });

  const events = [...cardEvents, ...checklistEvents].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );

  return { events };
}
