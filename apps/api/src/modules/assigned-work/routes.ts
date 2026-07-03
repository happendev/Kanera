import { dto } from "@kanera/shared";
import type { CompletedCardsResponse, WorkDoneResponse } from "@kanera/shared/dto";
import type {
  WireAssignedBoardSummary,
  WireAssignedWorkMemberStats,
  WireAssignedWorkPayload,
  WireAssignedWorkTargetUser,
  WireChecklistAssignment,
} from "@kanera/shared/events";
import {
  assignedWorkSeparators,
  boardMembers,
  boards,
  cardAssignees,
  cardLabels,
  cardSummaryView,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import type { AuthClaims } from "../../auth/plugin.js";
import { assertWorkspaceAccess, isOrgAdmin } from "../../lib/access.js";
import { loadAssignedChecklistItems } from "../../lib/assigned-checklist-items.js";
import { activeCompletedCardPredicate, parseCompletedDateParam } from "../../lib/completed-card-visibility.js";
import { loadAssignedWorkCardSummaries, toWireCardSummary } from "../../lib/card-summary.js";
import { decodeCompletedCardsCursor, encodeCompletedCardsCursor } from "../../lib/completed-card-pagination.js";
import { assertWorkDoneWindow, loadWorkDone } from "../../lib/work-done.js";
import { loadWorkspaceCustomFields } from "../../lib/custom-fields.js";
import { isDueDateOverdue } from "../../lib/due-date.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";

function escapedSearchPattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

async function accessibleAssignedWorkBoards(auth: AuthClaims, workspaceId: string): Promise<WireAssignedBoardSummary[]> {
  // Board membership is the access model: the viewer sees a board only if they hold an explicit
  // board_member row, except org admins who have implicit access to every board in their org.
  const orgAdmin = isOrgAdmin(auth);
  const boardRows = await db
    .select({
      id: boards.id,
      workspaceId: boards.workspaceId,
      name: boards.name,
      icon: boards.icon,
      iconColor: boards.iconColor,
      explicitMemberId: boardMembers.userId,
    })
    .from(boards)
    .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, auth.sub)))
    .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)));

  return boardRows
    .filter((b) => orgAdmin || b.explicitMemberId)
    .map((b) => ({ id: b.id, workspaceId: b.workspaceId, name: b.name, icon: b.icon, iconColor: b.iconColor }));
}

async function loadAssignedWorkPayload(
  auth: AuthClaims,
  workspaceId: string,
  includeCompleted: boolean,
  includeArchived: boolean,
  completedFrom: Date | null,
  completedTo: Date | null,
  targetUser: WireAssignedWorkTargetUser,
  viewerRole: "admin" | "member",
  assignedUserIds: string[],
): Promise<WireAssignedWorkPayload> {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!workspace) throw notFound();

    // Workspace access grants access to every board in the workspace.
    const finalBoards = await accessibleAssignedWorkBoards(auth, workspaceId);

    const shouldLoadSeparators = targetUser.userId !== "all" && !includeArchived && !includeCompleted && !completedFrom && !completedTo;
    const [workspaceLists, workspaceFields, workspaceLabels, workspaceMemberRows, separatorRows] = await Promise.all([
      db
        .select()
        .from(lists)
        .where(and(eq(lists.workspaceId, workspaceId), isNull(lists.archivedAt)))
        .orderBy(asc(lists.position)),
      loadWorkspaceCustomFields(workspaceId),
      db
        .select()
        .from(cardLabels)
        .where(and(eq(cardLabels.workspaceId, workspaceId), isNull(cardLabels.archivedAt)))
        .orderBy(asc(cardLabels.position)),
      db
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          lastOnlineAt: users.lastOnlineAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId)),
      !shouldLoadSeparators
        ? []
        : db
            .select()
            .from(assignedWorkSeparators)
            .where(and(eq(assignedWorkSeparators.workspaceId, workspaceId), eq(assignedWorkSeparators.targetUserId, targetUser.userId)))
            .orderBy(asc(assignedWorkSeparators.position)),
    ]);

    const assignedCardRows = await loadAssignedWorkCardSummaries({
      boardIds: finalBoards.map((b) => b.id),
      assignedUserIds,
      includeArchived,
      includeCompleted,
      completedFrom,
      completedTo,
      completedCardsActiveDays: workspace.completedCardsActiveDays,
    });
    const cardSummaries = assignedCardRows.map((card) => toWireCardSummary(card, auth.cid));

    const memberStatRows = finalBoards.length === 0
      ? []
      : await db
          .select({
            userId: cardAssignees.userId,
            dueDateLocalDate: cardSummaryView.dueDateLocalDate,
            dueDateSlot: cardSummaryView.dueDateSlot,
            dueDateTimezone: cardSummaryView.dueDateTimezone,
          })
          .from(cardAssignees)
          .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardAssignees.cardId))
          .where(
            and(
              inArray(cardSummaryView.boardId, finalBoards.map((b) => b.id)),
              isNull(cardSummaryView.archivedAt),
              isNull(cardSummaryView.completedAt),
              // Overdue depends on each card's local date/slot/timezone, which isDueDateOverdue
              // evaluates below as the single source of truth. But a card can only be overdue if it
              // has a due date that is on or before "today" — and the furthest-ahead timezone is at
              // most UTC+1 calendar day. Pre-filtering to that superset in SQL keeps the precise
              // (and tz-fallback-safe) check off the large set of future / no-due-date assignments.
              isNotNull(cardSummaryView.dueDateLocalDate),
              sql`${cardSummaryView.dueDateLocalDate} <= (now() at time zone 'UTC')::date + 1`,
            ),
          );
    const memberStatsMap = new Map<string, number>();
    for (const row of memberStatRows) {
      if (!isDueDateOverdue(row)) continue;
      memberStatsMap.set(row.userId, (memberStatsMap.get(row.userId) ?? 0) + 1);
    }

    // Assigned checklist items on accessible boards. Loaded once (all members, no due-date
    // requirement) so we can derive both the target user's "My checklist items" list and the
    // per-member overdue counts that drive the team tab badges.
    const assignedChecklistRows = finalBoards.length === 0
      ? []
      : await loadAssignedChecklistItems(db, {
          boardIds: finalBoards.map((b) => b.id),
          requireDueDate: false,
          // Checklist item assignment is live independently of card assignment, and completed
          // cards still allow checklist-item edits. Match realtime so refresh does not drop them.
          includeCompletedCards: true,
        });

    const checklistOverdueByUser = new Map<string, number>();
    for (const row of assignedChecklistRows) {
      if (!isDueDateOverdue(row)) continue;
      checklistOverdueByUser.set(row.assigneeId, (checklistOverdueByUser.get(row.assigneeId) ?? 0) + 1);
    }

    const statUserIds = new Set([...memberStatsMap.keys(), ...checklistOverdueByUser.keys()]);
    const memberStats: WireAssignedWorkMemberStats[] = Array.from(statUserIds, (userId) => ({
      userId,
      overdueCards: memberStatsMap.get(userId) ?? 0,
      overdueChecklistItems: checklistOverdueByUser.get(userId) ?? 0,
    }));

    // The "My checklist items" section is a live work list, so it only applies to the active
    // view; the archived/completed tabs are card-history oriented and omit checklist items.
    const assignedUserIdSet = new Set(assignedUserIds);
    const checklistItems: WireChecklistAssignment[] = includeArchived || includeCompleted
      ? []
      : assignedChecklistRows
          .filter((row) => assignedUserIdSet.has(row.assigneeId))
          .map((row) => ({
            itemId: row.itemId,
            text: row.text,
            cardId: row.cardId,
            cardTitle: row.cardTitle,
            checklistId: row.checklistId,
            listId: row.listId,
            boardId: row.boardId,
            boardName: row.boardName,
            boardIcon: row.boardIcon,
            assigneeId: row.assigneeId,
            dueDateLocalDate: row.dueDateLocalDate,
            dueDateSlot: row.dueDateSlot,
            dueDateTimezone: row.dueDateTimezone,
          }));

    const members = workspaceMemberRows.map((member) => withSignedMedia(auth.cid, { ...member, source: "workspace" as const }));

    const payload: WireAssignedWorkPayload = {
      workspace,
      lists: workspaceLists,
      customFields: workspaceFields,
      cardLabels: workspaceLabels,
      members,
      memberStats,
      boards: finalBoards,
      cards: cardSummaries,
      separators: separatorRows,
      checklistItems,
      targetUser,
      viewerRole,
    };
    return payload;
}

export async function assignedWorkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:workspaceId/assignees/cards", async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const query = req.query as { includeCompleted?: string; archived?: string; completedFrom?: string; completedTo?: string };
    const includeCompleted = query.includeCompleted === "true";
    const includeArchived = query.archived === "true";
    const ctx = await assertWorkspaceAccess(req.auth, workspaceId);

    // The aggregate team view exposes everyone's work, so it is a workspace-admin action.
    if (ctx.role !== "admin") throw forbidden();

    const teammateRows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), sql`${workspaceMembers.userId} <> ${req.auth.sub}`));

    return loadAssignedWorkPayload(
      req.auth,
      workspaceId,
      includeCompleted,
      includeArchived,
      parseCompletedDateParam(query.completedFrom),
      parseCompletedDateParam(query.completedTo, true),
      { userId: "all", displayName: "All", avatarUrl: null, role: "admin" },
      ctx.role,
      teammateRows.map((row) => row.userId),
    );
  });

  app.get("/workspaces/:workspaceId/assignees/:userId/cards", async (req) => {
    const { workspaceId, userId: targetUserId } = req.params as { workspaceId: string; userId: string };
    const query = req.query as { includeCompleted?: string; archived?: string; completedFrom?: string; completedTo?: string };
    const includeCompleted = query.includeCompleted === "true";
    const includeArchived = query.archived === "true";
    const ctx = await assertWorkspaceAccess(req.auth, workspaceId);

    // Members can only request their own view; admins (and org admins via ctx.role=admin) can
    // request any workspace member's view.
    const isSelf = targetUserId === req.auth.sub;
    if (!isSelf && ctx.role !== "admin") throw forbidden();

    const [targetMembership] = await db
      .select({
        role: workspaceMembers.role,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .limit(1);
    if (!targetMembership) throw notFound("workspace member not found");

    const targetUser: WireAssignedWorkTargetUser = withSignedMedia(req.auth.cid, {
      userId: targetUserId,
      displayName: targetMembership.displayName,
      avatarUrl: targetMembership.avatarUrl,
      role: targetMembership.role,
    });

    return loadAssignedWorkPayload(
      req.auth,
      workspaceId,
      includeCompleted,
      includeArchived,
      parseCompletedDateParam(query.completedFrom),
      parseCompletedDateParam(query.completedTo, true),
      targetUser,
      ctx.role,
      [targetUserId],
    );
  });

  app.get("/workspaces/:workspaceId/assignees/:userId/completed", async (req) => {
    const { workspaceId, userId: targetUserId } = req.params as { workspaceId: string; userId: string };
    const query = dto.completedCardsQuery.parse(req.query);
    const ctx = await assertWorkspaceAccess(req.auth, workspaceId);
    const isSelf = targetUserId === req.auth.sub;
    if (!isSelf && ctx.role !== "admin") throw forbidden();

    const [targetMembership] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .limit(1);
    if (!targetMembership) throw notFound("workspace member not found");

    const finalBoards = await accessibleAssignedWorkBoards(req.auth, workspaceId);
    const boardIds = query.boardId
      ? finalBoards.some((board) => board.id === query.boardId)
        ? [query.boardId]
        : []
      : finalBoards.map((board) => board.id);
    const cursor = decodeCompletedCardsCursor(query.cursor);

    const rows = boardIds.length === 0
      ? []
      : await db
          .select()
          .from(cardSummaryView)
          .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardSummaryView.id))
          .where(and(
            eq(cardAssignees.userId, targetUserId),
            inArray(cardSummaryView.boardId, boardIds),
            isNotNull(cardSummaryView.completedAt),
            isNull(cardSummaryView.archivedAt),
            query.from ? gte(cardSummaryView.completedAt, new Date(query.from)) : undefined,
            query.to ? lte(cardSummaryView.completedAt, new Date(query.to)) : undefined,
            query.listId ? eq(cardSummaryView.listId, query.listId) : undefined,
            query.q ? sql`lower(${cardSummaryView.title}) like ${escapedSearchPattern(query.q)} escape '\\'` : undefined,
            cursor
              ? or(
                  lt(cardSummaryView.completedAt, cursor.completedAt),
                  and(eq(cardSummaryView.completedAt, cursor.completedAt), gt(cardSummaryView.id, cursor.id)),
                )
              : undefined,
          ))
          .orderBy(desc(cardSummaryView.completedAt), asc(cardSummaryView.id))
          .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1)?.card_summary_view;
    const response: CompletedCardsResponse = {
      cards: page.map((row) => toWireCardSummary(row.card_summary_view, req.auth.cid)),
      nextCursor: rows.length > query.limit && last ? encodeCompletedCardsCursor(last) : null,
    };
    return response;
  });

  app.get("/workspaces/:workspaceId/assignees/:userId/work-done", async (req) => {
    const { workspaceId, userId: targetUserId } = req.params as { workspaceId: string; userId: string };
    const query = dto.workDoneQuery.parse(req.query);
    const ctx = await assertWorkspaceAccess(req.auth, workspaceId);
    const isSelf = targetUserId === req.auth.sub;
    if (!isSelf && ctx.role !== "admin") throw forbidden();

    const [targetMembership] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .limit(1);
    if (!targetMembership) throw notFound("workspace member not found");

    const from = new Date(query.from);
    const to = new Date(query.to);
    assertWorkDoneWindow(from, to);

    const finalBoards = await accessibleAssignedWorkBoards(req.auth, workspaceId);
    const boardIds = query.boardId
      ? finalBoards.some((board) => board.id === query.boardId)
        ? [query.boardId]
        : []
      : finalBoards.map((board) => board.id);

    const response: WorkDoneResponse = await loadWorkDone({ clientId: req.auth.cid, boardIds, actorUserId: targetUserId, from, to, q: query.q });
    return response;
  });

  app.get("/workspaces/:workspaceId/assignees/work-done", async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const query = dto.workDoneQuery.parse(req.query);
    const ctx = await assertWorkspaceAccess(req.auth, workspaceId);
    // The aggregate team work-done view exposes everyone's activity: workspace-admin only.
    if (ctx.role !== "admin") throw forbidden();

    const from = new Date(query.from);
    const to = new Date(query.to);
    assertWorkDoneWindow(from, to);

    const finalBoards = await accessibleAssignedWorkBoards(req.auth, workspaceId);
    const boardIds = query.boardId
      ? finalBoards.some((board) => board.id === query.boardId)
        ? [query.boardId]
        : []
      : finalBoards.map((board) => board.id);

    const teammateRows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), sql`${workspaceMembers.userId} <> ${req.auth.sub}`));

    // All-tab work-done mirrors the All cards tab: teammates only, excluding
    // the signed-in user's own activity, while still honoring workspace access.
    const response: WorkDoneResponse = await loadWorkDone({
      clientId: req.auth.cid,
      boardIds,
      actorUserIds: teammateRows.map((row) => row.userId),
      from,
      to,
      q: query.q,
    });
    return response;
  });
}
