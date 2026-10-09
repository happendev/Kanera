import { z } from "zod";
import type { ColorToken } from "../lib/colors.js";
import { ianaTimeZoneName } from "./_time-zone.js";

/**
 * Activity grid window. 18 whole weeks plus the running one never needs more than 126 days, which is
 * exactly what a Monday-first week grid ending on the current week can show, so the server never
 * counts a day the popover cannot render.
 */
export const USER_PROFILE_ACTIVITY_WEEKS = 18;
export const USER_PROFILE_ACTIVITY_DAYS = USER_PROFILE_ACTIVITY_WEEKS * 7;
/** Window for the "Completed" tile: the most recent stretch of the grid's own series. */
export const USER_PROFILE_COMPLETED_DAYS = 30;
export const USER_PROFILE_BOARD_LIMIT = 4;
export const USER_PROFILE_RECENT_CARD_LIMIT = 3;

/**
 * `workspaceId` is the surface the avatar was clicked on. It only decides which organisation the
 * role chip and email are described against; it never widens what the viewer may see, and a
 * workspace the viewer cannot reach is ignored rather than rejected so a stale link degrades quietly.
 */
export const userProfileQuery = z.object({
  timeZone: ianaTimeZoneName.optional(),
  workspaceId: z.uuid().optional(),
});
export type UserProfileQuery = z.infer<typeof userProfileQuery>;

/**
 * How the person relates to the organisation that owns the clicked surface. `workspaceAdmin` is only
 * reported when a workspace context was supplied; organisation owners/admins outrank it.
 */
export const USER_PROFILE_ROLES = ["owner", "admin", "workspaceAdmin", "member", "guest"] as const;
export type UserProfileRole = (typeof USER_PROFILE_ROLES)[number];

export interface UserProfileBoard {
  id: string;
  name: string;
  icon: string | null;
  iconColor: ColorToken | null;
  workspaceId: string;
  workspaceName: string;
  workspaceKind: "standard" | "board";
}

export interface UserProfileRecentCard {
  id: string;
  boardId: string;
  boardName: string;
  title: string;
  cardKey: string;
  organisationKey: string;
  completed: boolean;
  lastActivityAt: string;
}

export interface UserProfileResponse {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    /** Only shared with people in the same organisation as the person; null for cross-org viewers. */
    email: string | null;
    /** The person's own IANA zone, kept in sync from their browser; drives the "local time" line. */
    timezone: string;
    lastOnlineAt: string | null;
    /** Home organisation of a guest, so "Guest · Acme" says where they come from. Null otherwise. */
    homeOrganisationName: string | null;
  };
  isSelf: boolean;
  role: UserProfileRole | null;
  /** Zone the activity days were bucketed in (the viewer's), and today's key in it. */
  timeZone: string;
  today: string;
  /**
   * Everything below is scoped to cards the *viewer* can see, so a profile can never be used to read
   * the size or shape of work on boards the viewer has no access to.
   */
  stats: {
    openCards: number;
    overdueCards: number;
    completedCards: number;
    completedDays: number;
  };
  /**
   * Cards this person completed per local day, from the same summary as Work done's "Completed"
   * strip. Days with none are omitted.
   */
  activity: {
    days: number;
    total: number;
    byDay: { date: string; count: number }[];
  };
  sharedBoards: {
    total: number;
    boards: UserProfileBoard[];
  };
  recentCards: UserProfileRecentCard[];
}
