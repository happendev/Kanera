import type { WorkDoneEvent, WorkDoneEventType } from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";

/** Range presets offered by the toolbar. `custom` is whatever the range picker last applied. */
export type WorkDoneRangePreset = "today" | "7d" | "14d" | "30d" | "custom";

/** Presentation only: both layouts render the same filtered day components and event data. */
export type WorkDoneLayout = "list" | "grid";

/** Matches the point where the day grid would collapse to one column and stop adding any value. */
export const NARROW_WORK_DONE_LAYOUT_QUERY = "(max-width: 720px)";

export interface WorkDoneRange {
  preset: WorkDoneRangePreset;
  /** Local start-of-day of the first day in the range. */
  from: Date;
  /** Local start-of-day of the last day in the range (inclusive). */
  to: Date;
}

/** A list the card passed through, resolved for display. */
export interface WorkDoneListStep {
  text: string;
  icon: string | null;
  color: string | null;
  /** True for the collapsed-middle marker in a long journey. */
  ellipsis: boolean;
}

/** One person credited with something in a digest or day. */
export interface WorkDoneActor {
  userId: string | null;
  name: string;
  avatarUrl: string | null;
  /** How many of the day's events this person accounts for. */
  eventCount: number;
}

/** A checklist item ticked off inside a digest. */
export interface WorkDoneChecklistTick {
  itemId: string;
  text: string;
  checklistTitle: string;
  at: string;
}

/**
 * Everything one person did to one card on one local day, collapsed into a single row.
 *
 * The unit of the view is deliberately the card-day-person rather than the event: a card someone
 * created, moved twice and completed is one line in a daily report, not four. Two people who worked
 * the same card that day get a row each — merging them would credit work to the wrong person.
 */
export interface CardDayDigest {
  /** `${dateKey}:${cardId}:${actorKey}` — stable across reloads, so it is safe as a track key. */
  key: string;
  cardId: string;
  card: WireCardSummary;
  boardId: string;
  /** Latest event time for this card that day; the row's displayed time and sort key. */
  lastAt: string;
  eventCount: number;
  created: boolean;
  completed: boolean;
  /** Lists the card travelled through that day, already middle-collapsed for display. */
  listPath: WorkDoneListStep[];
  checklistTicks: WorkDoneChecklistTick[];
  /** Exactly one person: digests are split per actor, so a row always has a single owner. */
  actors: WorkDoneActor[];
  /**
   * Drives the row's leading icon and accent. Completion is the headline outcome, so it outranks
   * everything else regardless of what happened later in the day.
   */
  leadType: WorkDoneEventType;
}

/** One local day of the stream: its own summary plus its card digests, newest card first. */
export interface WorkDoneDay {
  /** Local YYYY-MM-DD key. */
  dateKey: string;
  /** "Today" / "Yesterday" / "Mon, 4 Mar". */
  label: string;
  /** "Sunday, 26 July 2026" — the unambiguous form, used for tooltips and copied text. */
  fullLabel: string;
  digests: CardDayDigest[];
  eventCount: number;
  counts: Record<WorkDoneEventType, number>;
  actors: WorkDoneActor[];
}

/** The events a single day's digests were built from, kept for standup export. */
export type WorkDoneEventsByDay = ReadonlyMap<string, WorkDoneEvent[]>;
