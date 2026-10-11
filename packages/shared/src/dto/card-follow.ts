import { z } from "zod";

/**
 * `remindAt` is an absolute instant. Agents resolve phrases ("friday 3pm") in the user's zone before
 * calling (see apps/mcp/src/relative-dates.ts), and the web picker sends the browser's local wall
 * time as an ISO instant, so the server never interprets a time zone itself.
 */
export const setCardReminderBody = z.strictObject({
  remindAt: z.iso.datetime({ offset: true }),
});
export type SetCardReminderBody = z.infer<typeof setCardReminderBody>;

export const listCardRemindersQuery = z.object({
  /** Default `pending`: reminders that have not fired yet. `all` adds fired ones still on record. */
  status: z.enum(["pending", "all"]).default("pending"),
});
export type ListCardRemindersQuery = z.infer<typeof listCardRemindersQuery>;

export interface WireCardReminder {
  id: string;
  cardId: string;
  remindAt: string;
  /** Set once the reminder has been delivered; cleared again when it is rescheduled. */
  firedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A reminder with enough of its card to render a list entry without a second read. */
export interface WireCardReminderListItem extends WireCardReminder {
  card: {
    id: string;
    key: string;
    title: string;
    boardId: string;
    workspaceId: string;
    url: string;
  };
}

/** The caller's own follow state for one card, returned by the watch and reminder routes. */
export interface CardFollowState {
  cardId: string;
  watching: boolean;
  reminder: WireCardReminder | null;
}
