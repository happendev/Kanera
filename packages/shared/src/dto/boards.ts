import { z } from "zod";
import type { Board } from "../schema/board.js";
import { BOARD_ROLES } from "../schema/member-roles.js";
import { colorTokenSchema, gradientTokenSchema } from "./_colors.js";
import { GENERAL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";
import { createIconSchema, DEFAULT_BOARD_ICON, updateIconSchema } from "./_icons.js";

export const createBoardBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
  groupId: z.uuid().nullable().optional(),
  description: z.string().max(2000).optional(),
  icon: createIconSchema(DEFAULT_BOARD_ICON),
  iconColor: colorTokenSchema.nullable().optional(),
  backgroundGradient: gradientTokenSchema.nullable().optional(),
  inProgressEnabled: z.boolean().optional(),
});
export type CreateBoardBody = z.infer<typeof createBoardBody>;

export const updateBoardBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
  groupId: z.uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: updateIconSchema(DEFAULT_BOARD_ICON),
  iconColor: colorTokenSchema.nullable().optional(),
  backgroundGradient: gradientTokenSchema.nullable().optional(),
  inProgressEnabled: z.boolean().optional(),
});
export type UpdateBoardBody = z.infer<typeof updateBoardBody>;

export const updateBoardBackgroundBody = z.object({
  backgroundGradient: gradientTokenSchema.nullable(),
});
export type UpdateBoardBackgroundBody = z.infer<typeof updateBoardBackgroundBody>;

export const moveBoardBody = z.object({
  beforeBoardId: z.uuid().nullable().optional(),
  afterBoardId: z.uuid().nullable().optional(),
});
export type MoveBoardBody = z.infer<typeof moveBoardBody>;

export interface MoveBoardResponse {
  id: string;
  position: string;
  /** Siblings normalised by this move, so clients can reconcile without reloading navigation. */
  positions?: Array<{ id: string; position: string }>;
}

export const createBoardGroupBody = z.object({
  title: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
});
export type CreateBoardGroupBody = z.infer<typeof createBoardGroupBody>;

export const updateBoardGroupBody = z.object({
  title: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
});
export type UpdateBoardGroupBody = z.infer<typeof updateBoardGroupBody>;

export const moveBoardGroupBody = z.object({
  beforeGroupId: z.uuid().nullable().optional(),
  afterGroupId: z.uuid().nullable().optional(),
});
export type MoveBoardGroupBody = z.infer<typeof moveBoardGroupBody>;

/**
 * A card transfer target keeps the full board shape for public API compatibility and adds the
 * navigation context the app needs to render organisation/workspace headings in sidebar order.
 */
export type BoardTransferTarget = Omit<Board, "position"> & {
  position: string;
  organisationId: string;
  organisationName: string;
  organisationExternal: boolean;
  workspaceName: string;
  workspaceIcon: string | null;
  workspaceAccentColor: string | null;
  workspaceKind: "standard" | "board";
  standaloneGroupTitle: string | null;
};

export const addBoardMemberBody = z.object({
  userId: z.uuid(),
  role: z.enum(BOARD_ROLES).default("editor"),
  assignedItemsOnly: z.boolean().default(false),
});
export type AddBoardMemberBody = z.infer<typeof addBoardMemberBody>;

export const updateBoardMemberBody = z.object({
  role: z.enum(BOARD_ROLES),
  assignedItemsOnly: z.boolean().optional(),
});
export type UpdateBoardMemberBody = z.infer<typeof updateBoardMemberBody>;

/** At most this many boards per tile-summary request: a settings page, never a catalog. */
export const BOARD_TILE_SUMMARY_MAX_BOARDS = 100;

export const boardTileSummariesQueryBody = z.object({
  boardIds: z.array(z.uuid()).min(1).max(BOARD_TILE_SUMMARY_MAX_BOARDS),
});
export type BoardTileSummariesQueryBody = z.infer<typeof boardTileSummariesQueryBody>;

/** How many member avatars a tile shows before it folds the rest into a "+N" count. */
export const BOARD_TILE_MEMBER_LIMIT = 4;

export type BoardTileMember = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
};

/**
 * The counts row under a board's name on a board tile (the workspace settings board list). One
 * row per requested board the viewer can open; boards the viewer cannot open are silently absent
 * rather than an error, so a stale id on the client is harmless.
 *
 * Card counts are over unarchived cards and honour the viewer's assigned-items restriction, the
 * same predicates the Portfolio buckets use, so a tile and the Portfolio row for the same board
 * never disagree. `completed` is all-time (not a reporting window): the progress bar reads
 * "done share of everything still on the board".
 */
export type BoardTileSummary = {
  boardId: string;
  /** Unarchived cards without a completion. */
  open: number;
  /** Unarchived cards with a completion, all time. */
  completed: number;
  /** Open cards whose due date and slot cut-off have passed in the card's own time zone. */
  overdue: number;
  /** Checklist items on open cards, done and total. */
  checklistDone: number;
  checklistTotal: number;
  /** Earliest due date (YYYY-MM-DD) among open cards that are not yet overdue, or null. */
  nextDueDate: string | null;
  /** The newest `updatedAt` among the counted cards, the canonical card-activity clock, or null. */
  lastActivityAt: string | null;
  /** The first `BOARD_TILE_MEMBER_LIMIT` members in join order. */
  members: BoardTileMember[];
  memberCount: number;
};
