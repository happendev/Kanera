import { z } from "zod";

export const boardMirrorListInput = z.object({
  sourceListId: z.uuid(),
  targetListId: z.uuid().optional(),
});
export type BoardMirrorListInput = z.infer<typeof boardMirrorListInput>;

export const createBoardMirrorBody = z.object({
  targetBoardId: z.uuid(),
  lists: z.array(boardMirrorListInput).min(1),
});
export type CreateBoardMirrorBody = z.infer<typeof createBoardMirrorBody>;

export const updateBoardMirrorBody = z
  .object({
    paused: z.boolean().optional(),
    lists: z.array(boardMirrorListInput).min(1).optional(),
  })
  .refine((body) => body.paused !== undefined || body.lists !== undefined, "provide paused or lists");
export type UpdateBoardMirrorBody = z.infer<typeof updateBoardMirrorBody>;

export const mirrorTargetBoardsQuery = z.object({
  sourceBoardId: z.uuid(),
});
export type MirrorTargetBoardsQuery = z.infer<typeof mirrorTargetBoardsQuery>;

export interface BoardMirrorListRow {
  sourceListId: string;
  sourceListName: string;
  targetListId: string;
  targetListName: string;
  targetListArchived: boolean;
}

export interface BoardMirrorAvailableList {
  id: string;
  name: string;
}

export interface BoardMirrorRow {
  id: string;
  sourceBoardId: string;
  sourceBoardName: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceOrganisationName: string;
  targetBoardId: string;
  targetBoardName: string;
  targetWorkspaceId: string;
  targetWorkspaceName: string;
  targetOrganisationName: string;
  createdById: string;
  createdByName: string;
  pausedAt: Date | null;
  sourceDisabledAt: Date | null;
  sourceDisabledByName: string | null;
  reconcileRequestedAt: Date | null;
  lastSyncAt: Date | null;
  consecutiveFailures: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  lists: BoardMirrorListRow[];
  availableSourceLists: BoardMirrorAvailableList[];
  availableTargetLists: BoardMirrorAvailableList[];
}

export interface CardMirrorReference {
  mirrorId: string;
  cardId: string;
  boardId: string;
  boardName: string;
  workspaceName: string;
  organisationName: string;
}

export interface CardMirrorStatus {
  asSource: CardMirrorReference[];
  asTarget: CardMirrorReference[];
}

export interface MirrorTargetList {
  id: string;
  name: string;
}

export interface MirrorTargetBoard {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  organisationName: string;
  lists: MirrorTargetList[];
}

export interface MirrorTargetBoardsResponse {
  targets: MirrorTargetBoard[];
  // A receiver can never become a source while its incoming relationship exists, even when that
  // relationship is paused or disabled. The create UI uses this to explain an empty selector.
  sourceBlockedByIncomingMirror: boolean;
}

export interface BoardMirrorStatus {
  count: number;
  inboundCount: number;
  outboundCount: number;
}
