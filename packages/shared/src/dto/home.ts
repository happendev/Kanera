import { z } from "zod";
import type { ColorToken } from "../lib/colors.js";
import type { CardDueDateSlot } from "../schema/index.js";

/**
 * Cap on the merged horizon list. Counts are exact and computed separately, so truncation never
 * lies — the tiles still show the true totals when the list is cut.
 */
export const HOME_HORIZON_LIMIT = 100;

/**
 * Trend window. 4 weeks: enough to read a week-over-week delta, and it halves cleanly to 14 on
 * narrow viewports so both windows are whole weeks and the Monday markers stay aligned.
 */
export const HOME_TREND_DAYS = 28;

export const HOME_DUE_BUCKETS = ["overdue", "today", "tomorrow", "laterThisWeek"] as const;
export type HomeDueBucket = (typeof HOME_DUE_BUCKETS)[number];

/**
 * The home agenda accepts a viewer time zone because `users.timezone` defaults to `"UTC"`: a user
 * who never set a profile zone would otherwise see a 23:00 Sydney completion land on the wrong
 * heatmap square. When the client sends nothing the server falls back to the profile zone, which is
 * the zone the daily digest and overdue emails already use, so home's "today" matches the mail.
 */
export const homeTodayQuery = z.object({
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .refine((value) => {
      if (value === undefined) return true;
      try {
        new Intl.DateTimeFormat("en", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA time zone"),
});
export type HomeTodayQuery = z.infer<typeof homeTodayQuery>;

/** A card label as the agenda renders it. Checklist rows carry their *parent card's* labels. */
export interface HomeItemLabel {
  id: string;
  name: string;
  color: ColorToken | null;
}

/** One row in the agenda: a card assigned to the viewer, or a checklist item assigned to them. */
export interface HomeItem {
  kind: "card" | "checklistItem";
  /** Card id, or checklist item id. Unique across the list — safe as a `@for` track key. */
  id: string;
  /** ALWAYS the card to deep-link to; equals `id` when kind is "card". */
  cardId: string;
  /** Current human-readable key of the card, including for checklist-item rows. */
  cardKey: string;
  /** Immutable opaque namespace used only to make the copied URL globally unambiguous. */
  organisationKey: string;
  title: string;
  /** Parent card title; null for kind "card", where `title` already is it. */
  cardTitle: string | null;
  bucket: HomeDueBucket;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardIconColor: ColorToken | null;
  workspaceId: string;
  workspaceName: string;
  /** Owning org name; non-null only for cross-organisation guest boards. */
  guestOrganisationName: string | null;
  listId: string;
  listName: string | null;
  /** Ordered by assignment then id, matching the board. Empty when the card carries none. */
  labels: HomeItemLabel[];
  /**
   * Never null — undated work never enters the horizon. A wall-clock date, not an instant:
   * compare it as a string, never convert it.
   */
  dueDateLocalDate: string;
  dueDateSlot: CardDueDateSlot | null;
  /** Zone the due date was set in. Drives overdue-ness; NOT the bucketing zone. */
  dueDateTimezone: string | null;
}

export interface HomeCounts {
  overdueCards: number;
  overdueChecklistItems: number;
  dueTodayCards: number;
  dueTodayChecklistItems: number;
  dueTomorrowCards: number;
  dueTomorrowChecklistItems: number;
  /** Residual [today+2, today+7]. Excludes overdue, today, and tomorrow. */
  dueLaterThisWeekCards: number;
  dueLaterThisWeekChecklistItems: number;
  /** Headline: non-overdue work dated [today, today+7]. The sum of the three buckets above. */
  dueWithin7DaysCards: number;
  dueWithin7DaysChecklistItems: number;
  /** Every active assigned item, dated or not. */
  assignedCards: number;
  assignedChecklistItems: number;
}

export interface HomeTrendDay {
  date: string;
  completedCards: number;
  completedChecklistItems: number;
}

export interface HomeTrend {
  days: number;
  /** Ascending. Sparse — only non-zero days are sent; the client zero-fills the window. */
  byDay: HomeTrendDay[];
  /** Rolling 7 viewer-local days ending today, inclusive. */
  thisWeek: { completedCards: number; completedChecklistItems: number };
  /** The 7 days before `thisWeek`. */
  lastWeek: { completedCards: number; completedChecklistItems: number };
}

export interface HomeTodayResponse {
  /** The zone every calendar day in this payload was computed in. */
  timeZone: string;
  /** Viewer-local YYYY-MM-DD the buckets anchor on. */
  today: string;
  /** `today` + 7, inclusive. */
  horizonEnd: string;
  counts: HomeCounts;
  /** Ordered, capped at HOME_HORIZON_LIMIT. */
  items: HomeItem[];
  itemsTruncated: boolean;
  trend: HomeTrend;
  /** 0 drives the onboarding/empty state. */
  boardCount: number;
}
