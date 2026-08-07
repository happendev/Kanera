import { z } from "zod";
import type { WireCardSummary } from "../events/index.js";
import { ianaTimeZone } from "./_time-zone.js";

/**
 * "Work done" historical view. The client sends the local-day boundaries as ISO
 * datetimes (start of the first day and end of the last day in the viewer's
 * timezone), the same convention the completed-cards panel uses, so day
 * attribution respects the viewer's timezone rather than the server's.
 *
 * The window may span several days. `timeZone` is what lets the server tell those
 * days apart: move coalescing must not merge across a local-day boundary, or a card
 * moved on Monday and again on Tuesday collapses into one Tuesday row and Monday's
 * work disappears. Optional, defaulting to UTC, so public/MCP callers keep working.
 */
export const workDoneQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  boardId: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  timeZone: ianaTimeZone,
});
export type WorkDoneQuery = z.infer<typeof workDoneQuery>;

/**
 * A repeatable uuid query parameter.
 *
 * Fastify's query parser yields a bare string for `?ids=a` and an array only for `?ids=a&ids=b`, so a
 * plain `z.array` would reject the single-value case — which is the common one when filtering by one
 * label or list. Normalise to an array before validating.
 */
function idListParam(max: number) {
  return z
    .preprocess(
      (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
      z.array(z.uuid()).max(max),
    )
    .optional();
}

/**
 * Per-day counts for the work-done activity strip, over a window wider than the visible range.
 *
 * The strip sits above the timeline, so it must narrow with it. The timeline can filter a loaded page
 * in JS, but an aggregate cannot — every filter that affects what the rows show has to be sent here
 * and applied in SQL, or the strip would report more work than is actually listed.
 */
export const workDoneSummaryQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  boardId: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  timeZone: ianaTimeZone,
  listIds: idListParam(200),
  labelIds: idListParam(200),
  /** Narrows to work performed by these people, matching the timeline's member filter. */
  actorIds: idListParam(100),
});
export type WorkDoneSummaryQuery = z.infer<typeof workDoneSummaryQuery>;

/**
 * One local calendar day of work-done activity. `date` is a YYYY-MM-DD key in the
 * requested timeZone.
 *
 * These are raw event counts, deliberately *not* the coalesced row counts the timeline
 * renders: `moved` counts every move, where the timeline merges a card's consecutive
 * moves within a day into one row. The separate fields let the client show the activity
 * strip for the currently selected work-done event type without fetching full card rows.
 */
export interface WorkDoneDaySummary {
  date: string;
  created: number;
  moved: number;
  completed: number;
  checklistItemCompleted: number;
}

export interface WorkDoneSummaryResponse {
  /** Only days with activity are sent; the client fills the rest of the window with zeroes. */
  days: WorkDoneDaySummary[];
}

export type WorkDoneEventType = "created" | "moved" | "completed" | "checklistItemCompleted";

/**
 * The view is a flat, time-ordered timeline: one row per event. Each event carries
 * the full card summary so rows render the same label/assignee/field chips the live
 * board uses, plus the timestamp (`at`) that drives the descending chronological sort.
 */
interface WorkDoneEventBase {
  /** Stable, unique track key. Card events use the activity id; checklist events use `checklistItem:<id>`. */
  id: string;
  type: WorkDoneEventType;
  /** ISO timestamp the event occurred at. */
  at: string;
  card: WireCardSummary;
  boardId: string;
  listId: string;
}

/** Fields shared by the card-action events, where the actor has an actor-kind (user/api/system). */
interface WorkDoneCardEventBase extends WorkDoneEventBase {
  /** User actor for the historical action; null for system/API-key activity. */
  actorUserId: string | null;
  actorName: string;
  actorAvatarUrl: string | null;
}

export interface WorkDoneCreatedEvent extends WorkDoneCardEventBase {
  type: "created";
}

export interface WorkDoneMovedEvent extends WorkDoneCardEventBase {
  type: "moved";
  /**
   * Ordered list ids the card travelled through that day, oldest first, when
   * consecutive same-card moves are coalesced into one row. The first entry is
   * the earliest known source list (omitted when unknown), followed by each
   * move's destination. Length >= 1; a single move yields [fromListId, toListId].
   */
  listPath: string[];
}

export interface WorkDoneCompletedEvent extends WorkDoneCardEventBase {
  type: "completed";
}

export interface WorkDoneChecklistItemCompletedEvent extends WorkDoneEventBase {
  type: "checklistItemCompleted";
  itemId: string;
  text: string;
  checklistId: string;
  checklistTitle: string;
  // Distinct from the actor fields: checklist completions have no actor-kind concept,
  // they are simply attributed to the user who ticked the item.
  completedByUserId: string | null;
  completedByName: string;
  completedByAvatarUrl: string | null;
}

export type WorkDoneEvent =
  | WorkDoneCreatedEvent
  | WorkDoneMovedEvent
  | WorkDoneCompletedEvent
  | WorkDoneChecklistItemCompletedEvent;

export interface WorkDoneResponse {
  /** Flat chronological event stream, sorted by `at` descending. */
  events: WorkDoneEvent[];
}
