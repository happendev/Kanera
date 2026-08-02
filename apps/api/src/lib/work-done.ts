import type {
  WorkDoneChecklistItemCompletedEvent,
  WorkDoneEvent,
  WorkDoneMovedEvent,
  WorkDoneResponse,
  WorkDoneSummaryResponse,
} from "@kanera/shared/dto";
import { ACTIVITY_ACTION, activityEvents, cardChecklistItems, cardChecklists, cardKeyPrefixReservations, cardSummaryView, users } from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNull, lt, notInArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "../db.js";
import { toWireCardSummary } from "./card-summary.js";
import { badRequest } from "./errors.js";
import { assignedCardVisibility } from "./access.js";
import { signedAvatarUrl } from "./media-keys.js";

/** Furthest back the historical view may look — keeps the queryable window bounded. */
export const WORK_DONE_MAX_DAYS = 60;

/**
 * Rejects requests whose day falls outside the allowed window: no further back
 * than WORK_DONE_MAX_DAYS, and not in the future. The cap is enforced at query
 * time only. Activity rows may have a longer deployment-configured retention window, but this
 * interactive/reporting query intentionally remains bounded to a small recent window.
 */
export function assertWorkDoneWindow(from: Date, to: Date): void {
  const now = Date.now();
  const floor = now - WORK_DONE_MAX_DAYS * 24 * 60 * 60 * 1000;
  if (from.getTime() < floor) throw badRequest(`work-done history is limited to the last ${WORK_DONE_MAX_DAYS} days`);
  if (from.getTime() > now) throw badRequest("work-done day cannot be in the future");
  if (to.getTime() <= from.getTime()) throw badRequest("invalid work-done day range");
}

/**
 * Bucket expression for grouping timestamps into the viewer's calendar days.
 *
 * `to_char` rather than a bare `::date` cast: the driver would otherwise hand back a Date parsed
 * in the server's zone, shifting a day's counts for viewers east or west of it. The zone is cast
 * explicitly because Postgres cannot infer a bare parameter's type inside `AT TIME ZONE`.
 */
export function activityDayExpr(column: SQLWrapper, timeZone: string): SQL<string> {
  return sql<string>`to_char((${column} at time zone ${timeZone}::text)::date, 'YYYY-MM-DD')`;
}

/**
 * Predicate matching activity rows that represent a card being completed.
 *
 * Completion is recorded two ways: the bulk "complete list" path writes a plain `completed`, while
 * the single-card toggle writes a coalesced `completion:set` whose payload says which direction it
 * went. Un-completions must never read as delivery. Exported so the work-done timeline, the
 * work-done summary, and the portfolio activity strips cannot drift on what "completed" means.
 */
export function activityCompletedPredicate(): SQL {
  return sql`(
    ${activityEvents.action} = ${ACTIVITY_ACTION.COMPLETED}
    or (${activityEvents.action} = ${ACTIVITY_ACTION.COMPLETION_SET} and ${activityEvents.payload}->>'toValue' = 'true')
  )`;
}

export interface LoadWorkDoneOptions {
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
  /** Exclusive upper bound (start of the day after the last day in the window). */
  to: Date;
  /** Optional case-insensitive title or card-key filter. */
  q?: string;
  /**
   * Card-level narrowing, applied in SQL.
   *
   * The timeline can narrow a loaded page in JS, but an aggregate cannot — so any filter that must
   * affect the activity strip has to be expressed here, or the strip would report more work than the
   * rows beneath it. Empty/undefined means "no narrowing".
   */
  listIds?: string[];
  /** Matches cards carrying *any* of these labels, mirroring the client-side `.some()` semantics. */
  labelIds?: string[];
  /**
   * Viewer's IANA zone. Only used to decide where one local day ends and the next begins, which
   * matters because the window may span several days. Defaults to UTC.
   */
  timeZone?: string;
}

function escapedSearchPattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

/** Matches titles, current keys, and exact historical key aliases for every board history query. */
function cardSearchPredicate(query: string): SQL {
  const keyMatch = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]*)$/.exec(query.trim());
  const historicalKeyMatch = keyMatch
    ? sql`(${cardSummaryView.number} = ${Number(keyMatch[2])} and exists (
        select 1 from ${cardKeyPrefixReservations} work_done_key_alias
        where work_done_key_alias.workspace_id = ${cardSummaryView.workspaceId}
          and work_done_key_alias.prefix = ${keyMatch[1]!.toUpperCase()}
      ))`
    : sql`false`;
  return sql`(
    lower(${cardSummaryView.title}) like ${escapedSearchPattern(query)} escape '\\'
    or lower(${cardSummaryView.key}) like ${escapedSearchPattern(query)} escape '\\'
    or ${historicalKeyMatch}
  )`;
}

/**
 * Returns a YYYY-MM-DD key for a timestamp in the given zone. Uses `en-CA`, whose short date format
 * is already ISO-ordered, so no part reassembly is needed. The formatter is built once per query
 * because constructing an Intl.DateTimeFormat per row is measurably slow over a wide window.
 */
function localDayKeyFormatter(timeZone: string): (at: Date) => string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (at: Date) => formatter.format(at);
}

/**
 * Security boundary for members restricted to cards assigned to them directly or via a checklist.
 *
 * Built in one place and shared by every work-done query, including the aggregate summary: counts
 * that included cards a restricted member cannot see would let them infer the volume of hidden
 * work, so the timeline and the strip must apply exactly the same predicate.
 */
function workDoneVisibilityPredicate(opts: LoadWorkDoneOptions): SQL | undefined {
  if (!opts.visibilityUserId) return undefined;
  if (!opts.visibilityRestrictedBoardIds) return assignedCardVisibility(opts.visibilityUserId, cardSummaryView.id);
  if (opts.visibilityRestrictedBoardIds.length === 0) return undefined;
  return or(
    notInArray(cardSummaryView.boardId, opts.visibilityRestrictedBoardIds),
    assignedCardVisibility(opts.visibilityUserId, cardSummaryView.id),
  );
}

/**
 * List and label narrowing, shared by the timeline and the summary so the activity strip can never
 * report on a wider set of cards than the rows beneath it.
 */
function workDoneCardNarrowing(opts: LoadWorkDoneOptions): (SQL | undefined)[] {
  return [
    opts.listIds?.length ? inArray(cardSummaryView.listId, opts.listIds) : undefined,
    // Array overlap: a card matches if it carries any of the filtered labels.
    opts.labelIds?.length
      ? sql`${cardSummaryView.labelIds} && array[${sql.join(opts.labelIds.map((id) => sql`${id}::uuid`), sql`, `)}]`
      : undefined,
  ];
}

/** Scope, window, archival, assignee, visibility and actor predicates for the activity-sourced half. */
function workDoneActivityPredicates(opts: LoadWorkDoneOptions): (SQL | undefined)[] {
  return [
    eq(activityEvents.entityType, "card"),
    inArray(activityEvents.boardId, opts.boardIds),
    gte(activityEvents.createdAt, opts.from),
    lt(activityEvents.createdAt, opts.to),
    isNull(cardSummaryView.archivedAt),
    opts.assigneeUserId ? sql`${opts.assigneeUserId} = any(${cardSummaryView.assigneeIds})` : undefined,
    ...workDoneCardNarrowing(opts),
    workDoneVisibilityPredicate(opts),
    opts.actorUserId ? eq(activityEvents.actorId, opts.actorUserId) : undefined,
    opts.actorUserIds ? inArray(activityEvents.actorId, opts.actorUserIds) : undefined,
  ];
}

/** The same scope/window/visibility boundary for the checklist-completion half. */
function workDoneChecklistPredicates(opts: LoadWorkDoneOptions): (SQL | undefined)[] {
  return [
    inArray(cardSummaryView.boardId, opts.boardIds),
    gte(cardChecklistItems.completedAt, opts.from),
    lt(cardChecklistItems.completedAt, opts.to),
    isNull(cardSummaryView.archivedAt),
    opts.assigneeUserId ? sql`${opts.assigneeUserId} = any(${cardSummaryView.assigneeIds})` : undefined,
    ...workDoneCardNarrowing(opts),
    workDoneVisibilityPredicate(opts),
    opts.actorUserId ? eq(cardChecklistItems.completedById, opts.actorUserId) : undefined,
    opts.actorUserIds ? inArray(cardChecklistItems.completedById, opts.actorUserIds) : undefined,
  ];
}

function actorDisplay(activity: { actorKind: string; apiKeyName: string | null }, user: { clientId: string; displayName: string; avatarUrl: string | null } | null): {
  name: string;
  avatarUrl: string | null;
} {
  if (activity.actorKind === "system") return { name: "Kanera", avatarUrl: null };
  if (activity.actorKind === "apiKey") return { name: activity.apiKeyName ?? "API key", avatarUrl: null };
  if (!user) return { name: "Unknown", avatarUrl: null };
  // Avatar media belongs to the actor's organisation, which may differ from the
  // viewer's for board guests, so sign it with the user's owning client id.
  return {
    name: user.displayName,
    avatarUrl: signedAvatarUrl(user.clientId, user.avatarUrl),
  };
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
  const timeZone = opts.timeZone ?? "UTC";
  const localDayKey = localDayKeyFormatter(timeZone);

  const rows = await db
    .select()
    .from(activityEvents)
    .innerJoin(cardSummaryView, eq(cardSummaryView.id, activityEvents.entityId))
    .leftJoin(users, eq(users.id, activityEvents.actorId))
    .where(and(
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
      ...workDoneActivityPredicates(opts),
      opts.q ? cardSearchPredicate(opts.q) : undefined,
    ))
    .orderBy(activityEvents.createdAt);

  const cardEvents: WorkDoneEvent[] = [];
  // Tracks the open coalesced "moved" run per card so consecutive moves merge.
  // Any non-move row for a card (created/completed) closes its run, since those
  // are emitted as their own rows in between.
  //
  // Keyed by card *and local day*: the window can span several days, and a run must never
  // straddle midnight. Without the day in the key, a card moved on Monday and again on Tuesday
  // would coalesce into a single row stamped Tuesday and Monday's work would vanish from its day.
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

    const moveKey = `${card.id}:${localDayKey(activity.createdAt)}`;

    if (activity.action === ACTIVITY_ACTION.MOVED) {
      const toListId = payload.toListId ?? card.listId;
      const existing = openMove.get(moveKey);
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
      openMove.set(moveKey, moved);
      cardEvents.push(moved);
      continue;
    }

    // A single-card completion toggle records `completion:set`; only surface it when
    // the (possibly coalesced) final state is "complete". Un-completions aren't work done.
    if (activity.action === ACTIVITY_ACTION.COMPLETION_SET && payload.toValue !== true) continue;

    // created / completed each get their own row and break any open move run for that local day.
    openMove.delete(moveKey);
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
      ...workDoneChecklistPredicates(opts),
      opts.q
        ? sql`(
            lower(${cardChecklistItems.text}) like ${escapedSearchPattern(opts.q)} escape '\\'
            or lower(${cardChecklists.title}) like ${escapedSearchPattern(opts.q)} escape '\\'
            or ${cardSearchPredicate(opts.q)}
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
      // Checklist completers can also be cross-organisation board guests.
      completedByAvatarUrl: completedBy
        ? signedAvatarUrl(completedBy.clientId, completedBy.avatarUrl)
        : null,
    };
  });

  const events = [...cardEvents, ...checklistEvents].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || a.id.localeCompare(b.id),
  );

  return { events };
}

/**
 * Per-day move and completion counts over the same access boundary as `loadWorkDone`.
 *
 * Powers the activity strip above the timeline, which spans a wider window than the visible range:
 * fetching that window as events is not viable because every event carries a full card summary, so
 * this returns two integers per day instead.
 *
 * Deliberately not coalesced — `moved` is every move event, where the timeline merges a card's
 * consecutive same-day moves into one row. The strip answers "how much moved", not "how many rows".
 * Both queries build their predicates from the shared helpers above so the summary can never widen
 * the visibility boundary the timeline enforces.
 *
 * Note this intentionally does *not* filter on `feedVisible`, unlike the portfolio activity strips:
 * it must agree with the timeline it sits above, and `loadWorkDone` reads suppressed rows too
 * (it does its own coalescing). Do not "align" the two without changing both surfaces together.
 */
export async function loadWorkDoneSummary(opts: LoadWorkDoneOptions): Promise<WorkDoneSummaryResponse> {
  if (opts.boardIds.length === 0) return { days: [] };
  if (opts.actorUserIds && opts.actorUserIds.length === 0) return { days: [] };
  const timeZone = opts.timeZone ?? "UTC";
  const completed = activityCompletedPredicate();
  const activityDay = activityDayExpr(activityEvents.createdAt, timeZone);

  const movedAndCompleted = await db
    .select({
      date: activityDay,
      moved: sql<number>`count(*) filter (where ${activityEvents.action} = ${ACTIVITY_ACTION.MOVED})::integer`,
      completed: sql<number>`count(*) filter (where ${completed})::integer`,
    })
    .from(activityEvents)
    .innerJoin(cardSummaryView, eq(cardSummaryView.id, activityEvents.entityId))
    .where(and(
      or(eq(activityEvents.action, ACTIVITY_ACTION.MOVED), completed),
      ...workDoneActivityPredicates(opts),
      opts.q ? cardSearchPredicate(opts.q) : undefined,
    ))
    // Grouped by output ordinal: repeating the expression would emit fresh parameter placeholders
    // for the zone, and Postgres then no longer recognises it as the same grouped expression.
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return {
    days: movedAndCompleted.map((row) => ({
      date: row.date,
      moved: row.moved,
      completed: row.completed,
    })),
  };
}
