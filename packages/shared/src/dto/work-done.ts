import { z } from "zod";
import type { WireCardSummary } from "../events/index.js";

/**
 * "Work done" historical view. The client sends the local-day boundaries as ISO
 * datetimes (start/end of the selected day in the viewer's timezone), the same
 * convention the completed-cards panel uses, so day attribution respects the
 * viewer's timezone rather than the server's.
 */
export const workDoneQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  boardId: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
export type WorkDoneQuery = z.infer<typeof workDoneQuery>;

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
