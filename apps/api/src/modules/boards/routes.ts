import { dto } from "@kanera/shared";
import type { CompletedCardsResponse, DeletionImpactResponse, WorkDoneResponse } from "@kanera/shared/dto";
import type { CompactCardSummary } from "@kanera/shared/events";
import { compactCardCustomFieldValue, compactCardSummary } from "@kanera/shared/events";
import { boardGroups, boardMembers, boardMirrors, boards, boardSeparators, cardCustomFieldValues, cardLabels, cards, cardSummaryView, lists, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assignedCardVisibility, assertBoardAccess, assertBoardManageAccess, assertWorkspaceAccess } from "../../lib/access.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { loadBoardCardSummaries, toWireCardSummary } from "../../lib/card-summary.js";
import { buildBoardExportArchive } from "../../lib/board-export.js";
import { loadChecklistTemplates } from "../../lib/checklist-templates.js";
import { decodeCompletedCardsCursor, encodeCompletedCardsCursor } from "../../lib/completed-card-pagination.js";
import { parseCompletedDateParam } from "../../lib/completed-card-visibility.js";
import { assertWorkDoneWindow, loadWorkDone } from "../../lib/work-done.js";
import { loadWorkspaceCustomFields } from "../../lib/custom-fields.js";
import { deleteAttachmentFiles } from "../../lib/attachment-cleanup.js";
import { assertGuestBoardLimit } from "../../lib/board-guest-limits.js";
import { seedBoardMembersFromWorkspace } from "../../lib/board-membership.js";
import { prunePaidGuestSeatIfBelowLimit } from "../../lib/paid-guest-seats.js";
import { reactivatePlanArchivedBoardsIfRoom } from "../../lib/plan-conversion.js";
import { assertBoardLimit, assertGuestsAllowed } from "../../lib/tier-limits.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { deleteExternalLinks } from "../../lib/external-links.js";
import { assertGuestEmailDoesNotMatchOwnerDomain } from "../../lib/guest-domain-policy.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { between } from "../../lib/position.js";
import { rebalanceBoardGroups, rebalanceBoards } from "../../lib/rebalance.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { deleteWorkspaceCascade } from "../../lib/workspace-delete.js";
import { emitBoardRebalancedToVisibleUsers, emitToBoard, emitToBoardAudience, emitToUser, emitToWorkspace } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";

type BoardMemberUser = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt: Date | null;
  // Board membership only carries board roles now; access is board-level (workspace admins appear
  // as pinned editor rows). The viewer's role is likewise the board role from assertBoardAccess.
  role: "editor" | "observer";
  source: "board" | "workspace";
  clientId: string;
  assignedItemsOnly: boolean;
};

function escapedSearchPattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

async function boardPayload(
  boardId: string,
  viewerRole: BoardMemberUser["role"],
  viewerSource: BoardMemberUser["source"],
  viewerCanAccessWorkspace: boolean,
  viewerIsWorkspaceAdmin: boolean,
  clientId: string,
  includeCompleted: boolean,
  includeArchived: boolean,
  completedFrom: Date | null = null,
  completedTo: Date | null = null,
  assignedUserId?: string,
  cardQuery: { includeCards?: boolean; listId?: string; limit?: number; offset?: number } = {},
) {
  const [board] = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1);
  if (!board) throw notFound();
  const [workspace] = await db
    .select({ clientId: workspaces.clientId, kind: workspaces.kind, completedCardsActiveDays: workspaces.completedCardsActiveDays, boardLinkingEnabled: workspaces.boardLinkingEnabled })
    .from(workspaces)
    .where(eq(workspaces.id, board.workspaceId))
    .limit(1);
  if (!workspace) throw notFound();

  const [boardLists, boardCardSummaries, boardSeparatorsRows, boardCustomFields, boardMemberRows, boardLabels, checklistTemplates] = await Promise.all([
    db
      .select()
      .from(lists)
      .where(and(eq(lists.workspaceId, board.workspaceId), isNull(lists.archivedAt)))
      .orderBy(asc(lists.position)),
    cardQuery.includeCards === false ? Promise.resolve([]) : loadBoardCardSummaries({
      boardId,
      includeArchived,
      includeCompleted,
      completedFrom,
      completedTo,
      assignedUserId,
      completedCardsActiveDays: workspace.completedCardsActiveDays,
      listId: cardQuery.listId,
      // Load one sentinel row beyond the public page size so hasMore is known without a count scan.
      limit: cardQuery.limit === undefined ? undefined : cardQuery.limit + 1,
      offset: cardQuery.offset,
    }),
    db
      .select()
      .from(boardSeparators)
      .where(eq(boardSeparators.boardId, boardId))
      .orderBy(asc(boardSeparators.position)),
    loadWorkspaceCustomFields(board.workspaceId),
    db
      .select({
        userId: boardMembers.userId,
        role: boardMembers.role,
        assignedItemsOnly: boardMembers.assignedItemsOnly,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        clientId: users.clientId,
        orgRole: users.clientRole,
      })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(eq(boardMembers.boardId, boardId)),
    db
      .select()
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, board.workspaceId), isNull(cardLabels.archivedAt)))
      .orderBy(asc(cardLabels.position)),
    loadChecklistTemplates(board.workspaceId),
  ]);

  // The member list is exactly the board's explicit membership — the single source of truth for
  // who can access this board (same-org members and cross-org guests alike, all source "board").
  const members: BoardMemberUser[] = boardMemberRows.map((m) => ({
    userId: m.userId,
    displayName: m.displayName,
    avatarUrl: withSignedMedia(m.clientId, { avatarUrl: m.avatarUrl }).avatarUrl,
    lastOnlineAt: m.lastOnlineAt,
    role: m.orgRole === "owner" || m.orgRole === "admin" ? "editor" : m.role,
    assignedItemsOnly: m.orgRole === "owner" || m.orgRole === "admin" ? false : m.assignedItemsOnly,
    source: "board",
    clientId: m.clientId,
  }));
  // Card tiles only render custom-field badges for `showOnCard` fields, so the hot board-open
  // payload inlines just those values instead of every field value for every card. Filters,
  // List View columns, and export need the full set, which the client lazily loads from
  // /boards/:id/custom-field-values on demand. When every field is shown on cards there is
  // nothing extra to fetch, so the payload is already complete.
  const shownFieldIds = new Set(boardCustomFields.filter((field) => field.showOnCard).map((field) => field.id));
  const customFieldValuesComplete = boardCustomFields.every((field) => field.showOnCard);
  // Compact each summary (drop null/empty/zero fields) before sending. On a 3000-card board the
  // repeated nulls, empty arrays, and zero counts are a large fraction of the raw payload and its
  // client-side parse cost; the web client re-expands each card via expandCardSummary on receipt.
  const hydratedCardSummaries: CompactCardSummary[] = boardCardSummaries.map((card) =>
    compactCardSummary(toWireCardSummary(card, clientId, shownFieldIds)),
  );
  const hasMoreCards = cardQuery.limit !== undefined && hydratedCardSummaries.length > cardQuery.limit;
  const cardSummaries = cardQuery.limit === undefined
    ? hydratedCardSummaries
    : hydratedCardSummaries.slice(0, cardQuery.limit);

  return { board, workspaceClientId: workspace.clientId, workspaceKind: workspace.kind, boardLinkingEnabled: workspace.boardLinkingEnabled, lists: boardLists, ...(cardQuery.includeCards === false ? {} : { cards: cardSummaries, ...(cardQuery.limit === undefined ? {} : { cardPage: { offset: cardQuery.offset ?? 0, limit: cardQuery.limit, hasMore: hasMoreCards } }) }), separators: boardSeparatorsRows, customFields: boardCustomFields, cardLabels: boardLabels, checklistTemplates, members, viewerRole, viewerSource, viewerCanAccessWorkspace, viewerIsWorkspaceAdmin, viewerAssignedItemsOnly: Boolean(assignedUserId), customFieldValuesComplete };
}

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full board scan.
async function neighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db.select({ position: boards.position }).from(boards).where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt))).orderBy(asc(boards.position)).limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db.select({ position: boards.position }).from(boards).where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt))).orderBy(desc(boards.position)).limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db.select({ position: boards.position }).from(boards).where(and(eq(boards.id, afterId), eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt))).limit(1);
    if (!after) throw badRequest("afterBoardId not found");
    const [nextBoard] = await db.select({ position: boards.position }).from(boards).where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt), gt(boards.position, after.position))).orderBy(asc(boards.position)).limit(1);
    prev = after.position;
    next = nextBoard?.position ?? null;
  } else if (beforeId) {
    const [before] = await db.select({ position: boards.position }).from(boards).where(and(eq(boards.id, beforeId), eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt))).limit(1);
    if (!before) throw badRequest("beforeBoardId not found");
    const [prevBoard] = await db.select({ position: boards.position }).from(boards).where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt), lt(boards.position, before.position))).orderBy(desc(boards.position)).limit(1);
    next = before.position;
    prev = prevBoard?.position ?? null;
  }
  return { prev, next };
}

// Board groups share the same sparse-position contract as boards; use one-neighbor
// probes rather than materializing every group in the workspace.
async function groupNeighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await db.select({ position: boardGroups.position }).from(boardGroups).where(eq(boardGroups.workspaceId, workspaceId)).orderBy(asc(boardGroups.position)).limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await db.select({ position: boardGroups.position }).from(boardGroups).where(eq(boardGroups.workspaceId, workspaceId)).orderBy(desc(boardGroups.position)).limit(1);
    prev = last?.position ?? null;
  }
  else if (afterId) {
    const [after] = await db.select({ position: boardGroups.position }).from(boardGroups).where(and(eq(boardGroups.id, afterId), eq(boardGroups.workspaceId, workspaceId))).limit(1);
    if (!after) throw badRequest("afterGroupId not found");
    const [nextGroup] = await db.select({ position: boardGroups.position }).from(boardGroups).where(and(eq(boardGroups.workspaceId, workspaceId), gt(boardGroups.position, after.position))).orderBy(asc(boardGroups.position)).limit(1);
    prev = after.position;
    next = nextGroup?.position ?? null;
  } else if (beforeId) {
    const [before] = await db.select({ position: boardGroups.position }).from(boardGroups).where(and(eq(boardGroups.id, beforeId), eq(boardGroups.workspaceId, workspaceId))).limit(1);
    if (!before) throw badRequest("beforeGroupId not found");
    const [prevGroup] = await db.select({ position: boardGroups.position }).from(boardGroups).where(and(eq(boardGroups.workspaceId, workspaceId), lt(boardGroups.position, before.position))).orderBy(desc(boardGroups.position)).limit(1);
    next = before.position;
    prev = prevGroup?.position ?? null;
  }
  return { prev, next };
}

async function validateBoardGroup(workspaceId: string, groupId: string | null | undefined) {
  if (groupId === undefined || groupId === null) return groupId ?? null;
  const [group] = await db
    .select({ id: boardGroups.id })
    .from(boardGroups)
    .where(and(eq(boardGroups.id, groupId), eq(boardGroups.workspaceId, workspaceId)))
    .limit(1);
  if (!group) throw badRequest("board group not found");
  return groupId;
}

export async function boardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/workspaces/:id/boards", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [workspace] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    // A database constraint on boards cannot reference workspace.kind, so this route is the source
    // of truth for the hidden workspace's exactly-one-board invariant.
    if (workspace?.kind === "board") throw badRequest("standalone boards cannot contain another board");
    const body = dto.createBoardBody.parse(req.body);
    const groupId = await validateBoardGroup(workspaceId, body.groupId);

    const [last] = await db
      .select({ position: boards.position })
      .from(boards)
      .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)))
      .orderBy(sql`${boards.position} desc`)
      .limit(1);
    const { position } = between(last?.position ?? null, null);

    const result = await db.transaction(async (tx) => {
      // Enforce inside the tx so the cap check and insert share one transaction; the helper takes a
      // tenant row lock to serialize concurrent board creates against the free cap.
      await assertBoardLimit(clientId, tx);
      const [board] = await tx
        .insert(boards)
        .values({
          workspaceId,
          groupId,
          name: body.name,
          description: body.description,
          icon: body.icon ?? null,
          iconColor: body.iconColor ?? null,
          backgroundGradient: body.backgroundGradient ?? null,
          position,
        })
        .returning();

      // Seed pinned editor rows for every workspace admin so the "admins are on every board"
      // invariant holds from creation. Regular members are not auto-added; they are granted access
      // explicitly per board thereafter. Note: an org owner/admin creator has no workspace_members
      // row, so seeding does not materialize a row for them here — their editor access comes from the
      // org short-circuit in access.ts, and GET /boards/:id/members surfaces them as a pinned admin.
      await seedBoardMembersFromWorkspace(tx, board!.id, workspaceId, req.auth.sub);

      await recordActivity(tx, {
        boardId: board!.id,
        workspaceId,
        actorId: req.auth.sub,
        entityType: "board",
        entityId: board!.id,
        action: "created",
        payload: { name: board!.name },
      });

      return board!;
    });

    await emitToBoardAudience(result.id, "board:created", { workspaceId, board: result });
    return reply.status(201).send(result);
  });

  app.get("/boards/:id", async (req) => {
    const { id } = req.params as { id: string };
    await assertBoardAccess(req.auth, id);
    const [board] = await db.select().from(boards).where(eq(boards.id, id)).limit(1);
    if (!board) throw notFound();
    return board;
  });

  app.post("/boards/:id/open", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { includeCompleted?: string; archived?: string; completedFrom?: string; completedTo?: string; includeCards?: string; listId?: string; cardLimit?: string; cardOffset?: string };
    const includeCompleted = query.includeCompleted === "true";
    const includeArchived = query.archived === "true";
    const includeCards = query.includeCards !== "false";
    const cardLimit = query.cardLimit === undefined ? undefined : Number(query.cardLimit);
    const cardOffset = query.cardOffset === undefined ? 0 : Number(query.cardOffset);
    if (cardLimit !== undefined && (!Number.isInteger(cardLimit) || cardLimit < 1 || cardLimit > 100)) throw badRequest("cardLimit must be between 1 and 100");
    if (!Number.isSafeInteger(cardOffset) || cardOffset < 0) throw badRequest("cardOffset must be a non-negative integer");
    // The app server still hydrates a whole board for the interactive board UI. Public API callers
    // must explicitly select one list and a bounded page so integrations can never materialize an
    // unbounded board-wide card response.
    if (req.url.startsWith("/api/v1/") && includeCards && (!query.listId || cardLimit === undefined)) {
      throw badRequest("public board card reads require listId and cardLimit; use includeCards=false for board metadata");
    }
    const ctx = await assertBoardAccess(req.auth, id);
    return boardPayload(
      id,
      ctx.role,
      ctx.source,
      ctx.canAccessWorkspace,
      ctx.isWorkspaceAdmin,
      req.auth.cid,
      includeCompleted,
      includeArchived,
      parseCompletedDateParam(query.completedFrom),
      parseCompletedDateParam(query.completedTo, true),
      ctx.assignedItemsOnly ? req.auth.sub : undefined,
      { includeCards, listId: query.listId, limit: cardLimit, offset: cardOffset },
    );
  });

  app.get("/boards/:id/transfer-targets", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { crossWorkspace?: string };
    const allowCrossWorkspace = query.crossWorkspace === "1" || query.crossWorkspace === "true";
    const sourceAccess = await assertBoardAccess(req.auth, id, "editor");
    const sameWorkspaceCandidates = await db
      .select()
      .from(boards)
      .where(and(eq(boards.workspaceId, sourceAccess.workspaceId), ne(boards.id, id), isNull(boards.archivedAt)))
      .orderBy(asc(boards.position));
    const candidatesById = new Map(sameWorkspaceCandidates.map((board) => [board.id, board]));

    if (allowCrossWorkspace) {
      const explicitEditorBoards = await db
        .select({ board: boards })
        .from(boardMembers)
        .innerJoin(boards, and(eq(boards.id, boardMembers.boardId), isNull(boards.archivedAt)))
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .where(and(eq(boardMembers.userId, req.auth.sub), eq(boardMembers.role, "editor"), ne(boards.id, id)))
        .orderBy(asc(workspaces.createdAt), asc(boards.position));
      for (const { board } of explicitEditorBoards) {
        if (board.id !== id && !candidatesById.has(board.id)) candidatesById.set(board.id, board);
      }
    }

    const accessible = [];
    // Target authorization has the same private-board, guest-role, org-admin, and API-key rules as
    // the mutation itself. Reuse it here so the picker never advertises a target the write rejects.
    for (const board of candidatesById.values()) {
      try {
        await assertBoardAccess(req.auth, board.id, "editor");
        accessible.push(board);
      } catch (error) {
        if (!(error instanceof AppError) || (error.statusCode !== 403 && error.statusCode !== 404)) throw error;
      }
    }
    return accessible;
  });

  app.get("/boards/:id/lists", async (req) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardAccess(req.auth, id, "editor");
    return db
      .select()
      .from(lists)
      .where(and(eq(lists.workspaceId, ctx.workspaceId), isNull(lists.archivedAt)))
      .orderBy(asc(lists.position));
  });

  app.get("/boards/:id/export", async (req) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardAccess(req.auth, id, "editor");
    return buildBoardExportArchive(id, req.auth.cid, ctx.assignedItemsOnly ? req.auth.sub : undefined);
  });

  // Full custom-field values for every card on the board. The board-open payload only inlines
  // values for `showOnCard` fields; the client loads the complete set here the first time it
  // needs values for filters, List View columns, or export. Returned for all cards regardless
  // of completed/archived visibility — extra entries are keyed by cardId and harmlessly ignored.
  app.get("/boards/:id/custom-field-values", async (req) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardAccess(req.auth, id);
    const rows = await db
      .select()
      .from(cardCustomFieldValues)
      .innerJoin(cards, eq(cards.id, cardCustomFieldValues.cardId))
      .where(and(eq(cards.boardId, id), ctx.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined))
      .orderBy(asc(cardCustomFieldValues.cardId), asc(cardCustomFieldValues.fieldId));
    return { customFieldValues: rows.map((row) => compactCardCustomFieldValue(row.card_custom_field_value)) };
  });

  // Bulk editing only needs values for the selected cards. Keep this separate from the full-board
  // endpoint so filters and List View can retain their board-complete caching semantics.
  app.post("/boards/:id/custom-field-values/query", async (req) => {
    const { id } = req.params as { id: string };
    const { cardIds } = dto.selectedCardQueryBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, id);
    const rows = await db
      .select()
      .from(cardCustomFieldValues)
      .innerJoin(cards, eq(cards.id, cardCustomFieldValues.cardId))
      .where(and(eq(cards.boardId, id), inArray(cards.id, cardIds), ctx.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined))
      .orderBy(asc(cardCustomFieldValues.cardId), asc(cardCustomFieldValues.fieldId));
    return { customFieldValues: rows.map((row) => compactCardCustomFieldValue(row.card_custom_field_value)) };
  });

  app.get("/boards/:id/completed", async (req) => {
    const { id } = req.params as { id: string };
    const query = dto.completedCardsQuery.omit({ boardId: true }).parse(req.query);
    const ctx = await assertBoardAccess(req.auth, id);
    const cursor = decodeCompletedCardsCursor(query.cursor);

    const rows = await db
      .select()
      .from(cardSummaryView)
      .where(and(
        eq(cardSummaryView.boardId, id),
        ctx.assignedItemsOnly ? assignedCardVisibility(req.auth.sub, cardSummaryView.id) : undefined,
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
    const nextCursor = rows.length > query.limit ? encodeCompletedCardsCursor(page.at(-1)!) : null;
    const response: CompletedCardsResponse = {
      cards: page.map((card) => toWireCardSummary(card, req.auth.cid)),
      nextCursor,
    };
    return response;
  });

  app.get("/boards/:id/work-done", async (req) => {
    const { id } = req.params as { id: string };
    const query = dto.workDoneQuery.omit({ boardId: true }).parse(req.query);
    const access = await assertBoardAccess(req.auth, id);
    const from = new Date(query.from);
    const to = new Date(query.to);
    assertWorkDoneWindow(from, to);

    const response: WorkDoneResponse = await loadWorkDone({ clientId: req.auth.cid, boardIds: [id], from, to, q: query.q, visibilityUserId: access.assignedItemsOnly ? req.auth.sub : undefined });
    return response;
  });

  app.patch("/boards/:id", async (req) => {
    const { id } = req.params as { id: string };
    // Renaming/reconfiguring a board is a workspace-admin action, not a board-role one.
    const ctx = await assertBoardManageAccess(req.auth, id);
    const body = dto.updateBoardBody.parse(req.body);
    if (body.groupId !== undefined) await validateBoardGroup(ctx.workspaceId, body.groupId);

    const { board, mirroredWorkspace } = await db.transaction(async (tx) => {
      const [board] = await tx
        .update(boards)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.groupId !== undefined && { groupId: body.groupId }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(body.iconColor !== undefined && { iconColor: body.iconColor }),
          ...(body.backgroundGradient !== undefined && { backgroundGradient: body.backgroundGradient }),
          updatedAt: new Date(),
        })
        .where(eq(boards.id, id))
        .returning();
      let mirroredWorkspace: typeof workspaces.$inferSelect | null = null;
      const updatesStandaloneIdentity = body.name !== undefined || body.icon !== undefined || body.iconColor !== undefined;
      if (updatesStandaloneIdentity) {
        const [updatedWorkspace] = await tx
          .update(workspaces)
          .set({
            ...(body.name !== undefined && { name: body.name }),
            ...(body.icon !== undefined && { icon: body.icon }),
            ...(body.iconColor !== undefined && { accentColor: body.iconColor }),
            updatedAt: new Date(),
          })
          .where(and(eq(workspaces.id, ctx.workspaceId), eq(workspaces.kind, "board")))
          .returning();
        mirroredWorkspace = updatedWorkspace ?? null;
      }
      // This is the other half of standalone identity mirroring. The board activity represents the
      // user action, so do not create a duplicate workspace activity row for the same edit.
      await recordActivity(tx, {
        boardId: id,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "board",
        entityId: id,
        action: "updated",
        payload: body,
      });
      return { board: board!, mirroredWorkspace };
    });
    await emitToBoardAudience(id, "board:updated", { board }, { workspaceId: ctx.workspaceId });
    if (mirroredWorkspace) await emitToWorkspace(ctx.workspaceId, "workspace:updated", { workspace: mirroredWorkspace });
    return board;
  });

  app.get("/workspaces/:id/board-groups", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId);
    return db.select().from(boardGroups).where(eq(boardGroups.workspaceId, workspaceId)).orderBy(asc(boardGroups.position));
  });

  app.post("/workspaces/:id/board-groups", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.createBoardGroupBody.parse(req.body);
    const [last] = await db
      .select({ position: boardGroups.position })
      .from(boardGroups)
      .where(eq(boardGroups.workspaceId, workspaceId))
      .orderBy(sql`${boardGroups.position} desc`)
      .limit(1);
    const { position } = between(last?.position ?? null, null);
    const [group] = await db.insert(boardGroups).values({ workspaceId, title: body.title, position }).returning();
    await recordActivity(db, {
      boardId: null,
      workspaceId,
      actorId: req.auth.sub,
      entityType: "boardGroup",
      entityId: group!.id,
      action: "created",
      payload: { title: group!.title },
    });
    emitToWorkspace(workspaceId, "boardGroup:created", { workspaceId, group: group! });
    return reply.status(201).send(group);
  });

  app.patch("/board-groups/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateBoardGroupBody.parse(req.body);
    const [current] = await db.select().from(boardGroups).where(eq(boardGroups.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const [group] = await db
      .update(boardGroups)
      .set({ title: body.title, updatedAt: new Date() })
      .where(eq(boardGroups.id, id))
      .returning();
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "boardGroup",
      entityId: id,
      action: "updated",
      payload: { title: body.title },
    });
    emitToWorkspace(current.workspaceId, "boardGroup:updated", { workspaceId: current.workspaceId, group: group! });
    return group!;
  });

  app.post("/board-groups/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveBoardGroupBody.parse(req.body);
    const [current] = await db.select().from(boardGroups).where(eq(boardGroups.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const { prev, next } = await groupNeighbourPositions(current.workspaceId, body.afterGroupId, body.beforeGroupId);
    const result = between(prev, next);
    let position = result.position;
    const prevPosition = current.position;
    await db.update(boardGroups).set({ position, updatedAt: new Date() }).where(eq(boardGroups.id, id));
    if (result.needsRebalance) {
      const positions = await rebalanceBoardGroups(current.workspaceId);
      position = positions.find((p) => p.id === id)?.position ?? position;
      await emitToWorkspace(current.workspaceId, "boardGroup:rebalanced", { workspaceId: current.workspaceId, positions });
    }
    await recordActivity(db, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "boardGroup",
      entityId: id,
      action: "moved",
      payload: { prevPosition, position },
    });
    emitToWorkspace(current.workspaceId, "boardGroup:moved", {
      workspaceId: current.workspaceId,
      groupId: id,
      position,
      prevPosition,
    });
    return { id, position };
  });

  app.delete("/board-groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [group] = await db.select().from(boardGroups).where(eq(boardGroups.id, id)).limit(1);
    if (!group) throw notFound();
    await assertWorkspaceAccess(req.auth, group.workspaceId, "admin");
    await db.delete(boardGroups).where(eq(boardGroups.id, id));
    await recordActivity(db, {
      boardId: null,
      workspaceId: group.workspaceId,
      actorId: req.auth.sub,
      entityType: "boardGroup",
      entityId: id,
      action: "deleted",
      payload: { title: group.title },
    });
    emitToWorkspace(group.workspaceId, "boardGroup:deleted", { workspaceId: group.workspaceId, groupId: id });
    return reply.status(204).send();
  });

  app.post("/boards/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveBoardBody.parse(req.body);
    const [current] = await db.select().from(boards).where(eq(boards.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");

    const { prev, next } = await neighbourPositions(current.workspaceId, body.afterBoardId, body.beforeBoardId);
    const result = between(prev, next);
    let position = result.position;
    const prevPosition = current.position;
    await db.update(boards).set({ position, updatedAt: new Date() }).where(eq(boards.id, id));

    if (result.needsRebalance) {
      const positions = await rebalanceBoards(current.workspaceId);
      position = positions.find((p) => p.id === id)?.position ?? position;
      await emitBoardRebalancedToVisibleUsers(current.workspaceId, { workspaceId: current.workspaceId, positions });
    }

    await recordActivity(db, {
      boardId: id,
      workspaceId: current.workspaceId,
      actorId: req.auth.sub,
      entityType: "board",
      entityId: id,
      action: "moved",
      payload: { prevPosition, position },
    });
    await emitToBoardAudience(id, "board:moved", {
      workspaceId: current.workspaceId,
      boardId: id,
      position,
      prevPosition,
    }, { workspaceId: current.workspaceId });
    return { id, position };
  });

  app.patch("/boards/:id/background", async (req) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardAccess(req.auth, id, "editor");
    const body = dto.updateBoardBackgroundBody.parse(req.body);

    const [board] = await db
      .update(boards)
      .set({ backgroundGradient: body.backgroundGradient, updatedAt: new Date() })
      .where(eq(boards.id, id))
      .returning();

    await recordActivity(db, {
      boardId: id,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "board",
      entityId: id,
      action: "updated",
      payload: { backgroundGradient: body.backgroundGradient },
    });
    await emitToBoardAudience(id, "board:updated", { board: board! }, { workspaceId: ctx.workspaceId });
    return board!;
  });

  app.get("/boards/:id/deletion-impact", async (req) => {
    const { id } = req.params as { id: string };
    await assertBoardManageAccess(req.auth, id);

    const [impact] = await db
      .select({ cardCount: sql<number>`count(*)::int` })
      .from(cards)
      .where(eq(cards.boardId, id));
    return { cardCount: impact?.cardCount ?? 0 } satisfies DeletionImpactResponse;
  });

  app.delete("/boards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardManageAccess(req.auth, id);

    const [workspace] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
    if (workspace?.kind === "board") {
      // Standalone lists, fields, labels, and related settings have no useful life without their
      // sole board, so deleting the product-level board deletes its hidden workspace as one cascade.
      await deleteWorkspaceCascade({ workspaceId: ctx.workspaceId, clientId: ctx.clientId });
      return reply.status(204).send();
    }

    const boardCards = await db.select({ id: cards.id }).from(cards).where(eq(cards.boardId, id));
    const removedMirrors = await db.select().from(boardMirrors).where(or(eq(boardMirrors.sourceBoardId, id), eq(boardMirrors.targetBoardId, id)));
    const externalMemberRows = await db
      .select({ userId: boardMembers.userId })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(and(eq(boardMembers.boardId, id), ne(users.clientId, ctx.clientId)));
    const storage = await getStorageForClient(req.auth.cid);
    await deleteAttachmentFiles(storage, boardCards.map((c) => c.id));

    for (const mirror of removedMirrors) {
      await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider: `mirror:${mirror.id}` });
      await db.delete(boardMirrors).where(eq(boardMirrors.id, mirror.id));
      const payload = { mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, targetBoardId: mirror.targetBoardId };
      // Deleting either participant ends the relationship for the surviving board too. Emit before
      // deleting this board so both durable board scopes can still resolve their workspaces.
      await Promise.all([...new Set([mirror.sourceBoardId, mirror.targetBoardId])].map((boardId) =>
        emitToBoard(boardId, "boardMirror:deleted", payload),
      ));
    }

    await emitToBoardAudience(id, "board:deleted", { workspaceId: ctx.workspaceId, boardId: id }, { workspaceId: ctx.workspaceId });
    await db.delete(boards).where(eq(boards.id, id));
    // Freeing the guest's pooled seat reduces the *used* count but not the purchased seat_limit (the
    // bill is unchanged): reducing capacity is a separate explicit admin action. The freed seat is now
    // available for the admin to assign to someone else.
    for (const row of externalMemberRows) {
      await prunePaidGuestSeatIfBelowLimit({ hostClientId: ctx.clientId, userId: row.userId });
    }
    const reactivatedBoards = await reactivatePlanArchivedBoardsIfRoom(ctx.clientId);
    for (const board of reactivatedBoards) {
      await emitToBoardAudience(board.id, "board:created", { workspaceId: board.workspaceId, board }, { workspaceId: board.workspaceId });
    }
    return reply.status(204).send();
  });

  app.get("/boards/:id/member-candidates", async (req) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardManageAccess(req.auth, id);
    const [workspace] = await db
      .select({ kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    if (!workspace) throw notFound();

    if (workspace.kind === "board") {
      const organisationMembers = await db
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          lastOnlineAt: users.lastOnlineAt,
          clientId: users.clientId,
        })
        .from(users)
        .where(and(eq(users.clientId, ctx.clientId), isNull(users.removedAt)))
        .orderBy(asc(users.createdAt));
      // A standalone board has no product-facing workspace roster. Its board permissions picker
      // therefore offers every active organisation member; the mutation route keeps any required
      // hidden membership as an implementation detail.
      return {
        scope: "organisation" as const,
        members: organisationMembers.map((member) => withSignedMedia(ctx.clientId, member)),
      };
    }

    const explicitMembers = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        clientId: users.clientId,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, ctx.workspaceId))
      .orderBy(asc(workspaceMembers.addedAt));
    const explicitUserIds = new Set(explicitMembers.map((member) => member.userId));
    const inheritedAdmins = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        clientId: users.clientId,
      })
      .from(users)
      .where(and(eq(users.clientId, ctx.clientId), inArray(users.clientRole, ["owner", "admin"]), isNull(users.removedAt)))
      .orderBy(asc(users.createdAt));
    return {
      scope: "workspace" as const,
      members: [...explicitMembers, ...inheritedAdmins.filter((member) => !explicitUserIds.has(member.userId))]
        .map((member) => withSignedMedia(ctx.clientId, member)),
    };
  });

  app.post("/boards/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Managing a board's membership is a workspace-admin action, not a board-role one.
    const ctx = await assertBoardManageAccess(req.auth, id);
    const body = dto.addBoardMemberBody.parse(req.body);

    const [user] = await db
      .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, lastOnlineAt: users.lastOnlineAt, clientId: users.clientId, email: users.email, orgRole: users.clientRole })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!user) throw notFound("user not found");
    const [workspace] = await db
      .select({ kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    if (!workspace) throw notFound();

    // Same-org users are added directly as board members. Cross-org guests additionally consume a
    // guest seat and must clear the guest-domain and entitlement checks.
    if (user.clientId !== ctx.clientId) {
      await assertGuestEmailDoesNotMatchOwnerDomain({ hostClientId: ctx.clientId, email: user.email, targetClientId: user.clientId });
      await assertGuestsAllowed(ctx.clientId);
    }
    // Seat-pool gate + membership insert in one transaction so the capacity check cannot race a
    // concurrent assignment into the last seat. For cross-org guests, crossing the free guest-board
    // cap consumes a pooled seat; a full pool throws 402 SEAT_LIMIT_REACHED. Same-org members skip
    // the seat pool (assertGuestBoardLimit is a no-op when targetClientId === hostClientId).
    const { member, hiddenWorkspaceMember } = await db.transaction(async (tx) => {
      await assertGuestBoardLimit({
        hostClientId: ctx.clientId,
        boardId: id,
        userId: body.userId,
        targetClientId: user.clientId,
        createdById: req.auth.sub,
        tx,
      });
      const [row] = await tx
        .insert(boardMembers)
        // Explicit grants are never pinned; pinned rows are reserved for workspace admins. If the
        // user already has a row (e.g. an admin's pinned row, or a prior grant) this is a no-op and
        // we surface a clear conflict rather than a PK error.
        .values({ boardId: id, userId: body.userId, role: body.role, assignedItemsOnly: body.assignedItemsOnly })
        .onConflictDoNothing()
        .returning();
      let hiddenWorkspaceMember: typeof workspaceMembers.$inferSelect | null = null;
      if (row && workspace.kind === "board" && user.clientId === ctx.clientId && user.orgRole === "member") {
        // Home discovery is workspace-membership based. Materialize that row for same-org users,
        // but keep it coupled to the sole board permission so no workspace concept leaks into UI.
        const [inserted] = await tx
          .insert(workspaceMembers)
          .values({ workspaceId: ctx.workspaceId, userId: user.id, role: "member" })
          .onConflictDoNothing()
          .returning();
        hiddenWorkspaceMember = inserted ?? null;
      }
      return { member: row, hiddenWorkspaceMember };
    });
    if (!member) throw badRequest("user is already a board member");

    if (hiddenWorkspaceMember) {
      const workspaceMemberPayload = withSignedMedia(ctx.clientId, {
        ...hiddenWorkspaceMember,
        orgRole: user.orgRole,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        lastOnlineAt: user.lastOnlineAt,
      });
      await emitToWorkspace(ctx.workspaceId, "workspace:member:added", { workspaceId: ctx.workspaceId, member: workspaceMemberPayload });
      emitToUser(user.id, "workspace:member:added", { workspaceId: ctx.workspaceId, member: workspaceMemberPayload });
    }

    const payload = {
      boardId: id,
      member: member!,
      user: {
        userId: user!.id,
        displayName: user!.displayName,
        avatarUrl: withSignedMedia(user!.clientId, { avatarUrl: user!.avatarUrl }).avatarUrl,
        lastOnlineAt: user!.lastOnlineAt,
        role: member!.role,
        source: "board" as const,
        clientId: user!.clientId,
      },
    };
    emitToBoard(id, "board:member:added", payload);
    emitToUser(user.id, "board:member:added", payload);
    return reply.status(201).send(member);
  });

  app.get("/boards/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    await assertBoardManageAccess(req.auth, id);
    const rows = await db
      .select({
        boardId: boardMembers.boardId,
        userId: boardMembers.userId,
        role: boardMembers.role,
        assignedItemsOnly: boardMembers.assignedItemsOnly,
        // Pinned rows are workspace admins; clients render them as non-removable/non-editable.
        pinned: boardMembers.pinned,
        addedAt: boardMembers.addedAt,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        clientId: users.clientId,
        orgRole: users.clientRole,
      })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(eq(boardMembers.boardId, id))
      .orderBy(asc(boardMembers.addedAt));
    return rows.map((row) => ({
      ...row,
      role: row.orgRole === "owner" || row.orgRole === "admin" ? "editor" as const : row.role,
      pinned: row.pinned || row.orgRole === "owner" || row.orgRole === "admin",
      avatarUrl: withSignedMedia(row.clientId, { avatarUrl: row.avatarUrl }).avatarUrl,
    }));
  });

  app.patch("/boards/:id/members/:userId", async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const ctx = await assertBoardManageAccess(req.auth, id);
    const body = dto.updateBoardMemberBody.parse(req.body);

    const [existing] = await db
      .select({
        role: boardMembers.role,
        assignedItemsOnly: boardMembers.assignedItemsOnly,
        pinned: boardMembers.pinned,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        clientId: users.clientId,
        orgRole: users.clientRole,
      })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
      .limit(1);
    if (!existing) throw notFound("board membership not found");
    // A workspace admin's pinned editor row is fixed while they remain an admin; change their
    // workspace role to alter board access instead.
    if (existing.pinned || existing.orgRole === "owner" || existing.orgRole === "admin") {
      throw badRequest("cannot change an inherited board admin role");
    }

    const [member] = await db
      .update(boardMembers)
      .set({ role: body.role, ...(body.assignedItemsOnly !== undefined && { assignedItemsOnly: body.assignedItemsOnly }) })
      .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
      .returning();

    await recordActivity(db, {
      boardId: id,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "board",
      entityId: userId,
      action: "updated",
      payload: { userId, role: member!.role, prevRole: existing.role, assignedItemsOnly: member!.assignedItemsOnly, prevAssignedItemsOnly: existing.assignedItemsOnly },
    });

    const payload = {
      boardId: id,
      member: member!,
      user: {
        userId,
        displayName: existing.displayName,
        avatarUrl: withSignedMedia(existing.clientId, { avatarUrl: existing.avatarUrl }).avatarUrl,
        lastOnlineAt: existing.lastOnlineAt,
        role: member!.role,
        source: "board" as const,
        clientId: existing.clientId,
      },
    };
    // A live role change is enough: every board mutation re-runs assertBoardAccess, so the new
    // role takes effect on the member's next action. Unlike a workspace-role change (which gates
    // room membership), there is no need to force-disconnect the user's sockets.
    emitToBoard(id, "board:member:updated", payload);
    emitToUser(userId, "board:member:updated", payload);
    // Room membership is part of the confidentiality boundary: switching this flag must eject
    // any socket that may still be sitting in the unfiltered board room (or needs to rejoin it).
    if (member!.assignedItemsOnly !== existing.assignedItemsOnly) disconnectUserRealtimeSockets(userId);
    return member!;
  });

  app.delete("/boards/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const ctx = await assertBoardManageAccess(req.auth, id);
    const [member] = await db
      .select({ role: boardMembers.role, pinned: boardMembers.pinned, orgRole: users.clientRole, clientId: users.clientId })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
      .limit(1);
    if (!member) throw notFound();
    // A workspace admin's pinned row cannot be removed board-by-board; change their workspace role.
    if (member.pinned || member.orgRole === "owner" || member.orgRole === "admin") {
      throw badRequest("cannot remove an inherited board admin");
    }
    const [workspace] = await db
      .select({ kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    if (!workspace) throw notFound();
    const cleanup = await db.transaction(async (tx) => {
      const participation = await cleanupUserBoardParticipation(tx, {
        userId,
        boardIds: [id],
        actorId: req.auth.sub,
      });
      await recordActivity(tx, {
        boardId: id,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "board",
        entityId: userId,
        action: "removed",
        payload: { userId, role: member.role },
      });
      const removedHiddenWorkspaceMember = workspace.kind === "board" && member.clientId === ctx.clientId
        ? await tx
          .delete(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)))
          .returning({ userId: workspaceMembers.userId })
        : [];
      return { ...participation, removedHiddenWorkspaceMember: removedHiddenWorkspaceMember.length > 0 };
    });
    // Frees the pooled seat (used count) without reducing the purchased seat_limit / bill.
    await prunePaidGuestSeatIfBelowLimit({ hostClientId: ctx.clientId, userId });
    if (cleanup.removedHiddenWorkspaceMember) {
      await emitToWorkspace(ctx.workspaceId, "workspace:member:removed", { workspaceId: ctx.workspaceId, userId });
    }
    await emitToBoard(id, "board:member:removed", { boardId: id, userId });
    for (const update of cleanup.assigneeUpdates) {
      await emitToBoard(id, "card:assignees:set", update);
    }
    for (const update of cleanup.checklistItemUpdates) {
      await emitToBoard(id, "card:checklistItem:updated", update);
    }
    for (const update of cleanup.activities) {
      await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
    }
    disconnectUserRealtimeSockets(userId);
    return reply.status(204).send();
  });
}
