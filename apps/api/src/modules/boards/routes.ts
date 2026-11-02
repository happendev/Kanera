import { notifyDependencyHandoffs } from "../../lib/dependency-notifications.js";
import { dto } from "@kanera/shared";
import type { DeletionImpactResponse, WorkDoneResponse, WorkDoneSummaryResponse } from "@kanera/shared/dto";
import { compactCardCustomFieldValue } from "@kanera/shared/events";
import { boardGroups, boards, cardCustomFieldValues, cards, lists, workspaces } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assignedCardVisibility, assertOrgRole, assertBoardAccess, assertBoardManageAccess, assertWorkspaceAccess } from "../../lib/access.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { loadBoardTileSummaries } from "../../lib/board-tile-summaries.js";
import { buildBoardExportArchive } from "../../lib/board-export.js";
import { parseCompletedDateParam } from "../../lib/completed-card-visibility.js";
import { assertWorkDoneWindow, loadWorkDone, loadWorkDoneSummary, type LoadWorkDoneOptions } from "../../lib/work-done.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { moveStandaloneBoard } from "../../lib/move-standalone-board.js";
import { deleteWorkspaceCascade } from "../../lib/workspace-delete.js";
import { emitToBoardAudience, emitToWorkspace } from "../../realtime/emit.js";
import { boardPayload, listBoardMembers, loadBoardMemberCandidates, loadBoardTransferTargets, loadCompletedCards } from "./board-queries.js";
import { createBoard, emitBoardCreated } from "./create-board.js";
import { updateBoard, updateBoardBackground } from "./update-board.js";
import { emitBoardMoved, moveBoard } from "./move-board.js";
import { deleteBoard, emitBoardDeleted } from "./delete-board.js";
import { createBoardGroup, deleteBoardGroup, emitBoardGroupMoved, moveBoardGroup, updateBoardGroup } from "./board-groups.js";
import { addBoardMember, emitBoardMemberAdded, emitBoardMemberRemoved, emitBoardMemberUpdated, removeBoardMember, updateBoardMember } from "./board-members.js";

export async function boardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/boards", async (req) => {
    const directory = dto.agentDirectoryQuery.parse(req.query ?? {});
    const rows = await loadAccessibleBoards(req.auth);
    return directory.limit === undefined ? rows : rows.slice(directory.offset, directory.offset + directory.limit);
  });

  app.post("/workspaces/:id/boards", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [workspace] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    // A database constraint on boards cannot reference workspace.kind, so this route is the source
    // of truth for the hidden workspace's exactly-one-board invariant.
    if (workspace?.kind === "board") throw badRequest("standalone boards cannot contain another board");
    const body = dto.createBoardBody.parse(req.body);

    const result = await createBoard({ auth: req.auth, workspaceId, clientId, body });

    await emitBoardCreated({ auth: req.auth, workspaceId, clientId, board: result });
    return reply.status(201).send(result);
  });

  app.get("/boards/:id", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { includeCards?: string };
    const ctx = await assertBoardAccess(req.auth, id);
    if (query.includeCards === "false") {
      // Consolidated work views hydrate this bounded source-board context only while a detail
      // drawer is open. That gives the existing editor native lists/fields/people without loading
      // every sibling card or extending its single-board state across workspaces.
      return boardPayload(
        id,
        ctx.role,
        ctx.source,
        ctx.canAccessWorkspace,
        ctx.isWorkspaceAdmin,
        req.auth.cid,
        false,
        false,
        undefined,
        undefined,
        ctx.assignedItemsOnly ? req.auth.sub : undefined,
        { includeCards: false },
      );
    }
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

  // Static segment, so find-my-way resolves it ahead of `/boards/:id/...`. A query POST rather
  // than ids in the query string: a settings page can ask for a hundred boards at once.
  app.post("/boards/tile-summaries/query", async (req) => {
    const { boardIds } = dto.boardTileSummariesQueryBody.parse(req.body ?? {});
    return loadBoardTileSummaries(req.auth, boardIds);
  });

  app.get("/boards/:id/transfer-targets", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { crossWorkspace?: string };
    const allowCrossWorkspace = query.crossWorkspace === "1" || query.crossWorkspace === "true";
    const sourceAccess = await assertBoardAccess(req.auth, id, "editor");
    return loadBoardTransferTargets({ auth: req.auth, boardId: id, sourceWorkspaceId: sourceAccess.workspaceId, allowCrossWorkspace });
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
  // needs values for filters, Table columns, or export. Returned for all cards regardless
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
  // endpoint so filters and the Table can retain their board-complete caching semantics.
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
    return loadCompletedCards({ auth: req.auth, ctx, boardId: id, query });
  });

  // Both board work-done routes resolve their scope and access boundary here, so the timeline and
  // the activity strip above it can never answer for different sets of cards.
  const boardWorkDoneOptions = async (req: FastifyRequest): Promise<LoadWorkDoneOptions> => {
    const { id } = req.params as { id: string };
    // The summary schema is a superset of the timeline's; parsing it for both means the two share one
    // filter contract and the strip cannot narrow differently from the rows.
    const query = dto.workDoneSummaryQuery.omit({ boardId: true }).parse(req.query);
    const access = await assertBoardAccess(req.auth, id);
    const from = new Date(query.from);
    const to = new Date(query.to);
    assertWorkDoneWindow(from, to);

    return {
      clientId: req.auth.cid,
      boardIds: [id],
      from,
      to,
      q: query.q,
      timeZone: query.timeZone,
      listIds: query.listIds,
      labelIds: query.labelIds,
      actorUserIds: query.actorIds?.length ? query.actorIds : undefined,
      visibilityUserId: access.assignedItemsOnly ? req.auth.sub : undefined,
    };
  };

  app.get("/boards/:id/work-done", async (req) => {
    const response: WorkDoneResponse = await loadWorkDone(await boardWorkDoneOptions(req));
    return response;
  });

  app.get("/boards/:id/work-done/summary", async (req) => {
    const response: WorkDoneSummaryResponse = await loadWorkDoneSummary(await boardWorkDoneOptions(req));
    return response;
  });

  app.patch("/boards/:id", async (req) => {
    const { id } = req.params as { id: string };
    // Renaming/reconfiguring a board is a workspace-admin action, not a board-role one.
    const ctx = await assertBoardManageAccess(req.auth, id);
    const body = dto.updateBoardBody.parse(req.body);

    const { board, mirroredWorkspace } = await updateBoard({ auth: req.auth, ctx, boardId: id, body });

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

    const group = await createBoardGroup({ auth: req.auth, workspaceId, body });

    await emitToWorkspace(workspaceId, "boardGroup:created", { workspaceId, group });
    return reply.status(201).send(group);
  });

  app.patch("/board-groups/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateBoardGroupBody.parse(req.body);
    const [current] = await db.select().from(boardGroups).where(eq(boardGroups.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");

    const group = await updateBoardGroup({ auth: req.auth, current, body });

    await emitToWorkspace(current.workspaceId, "boardGroup:updated", { workspaceId: current.workspaceId, group });
    return group;
  });

  app.post("/board-groups/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveBoardGroupBody.parse(req.body);
    const [current] = await db.select().from(boardGroups).where(eq(boardGroups.id, id)).limit(1);
    if (!current) throw notFound();
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");

    const moved = await moveBoardGroup({ auth: req.auth, current, body });

    await emitBoardGroupMoved(moved);
    return { id, position: moved.position };
  });

  app.delete("/board-groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [group] = await db.select().from(boardGroups).where(eq(boardGroups.id, id)).limit(1);
    if (!group) throw notFound();
    await assertWorkspaceAccess(req.auth, group.workspaceId, "admin");

    await deleteBoardGroup({ auth: req.auth, group });

    await emitToWorkspace(group.workspaceId, "boardGroup:deleted", { workspaceId: group.workspaceId, groupId: id });
    return reply.status(204).send();
  });

  app.post("/boards/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveBoardBody.parse(req.body);
    const [current] = await db.select().from(boards).where(eq(boards.id, id)).limit(1);
    if (!current) throw notFound();
    const access = await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const [workspace] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, current.workspaceId));
    if (!workspace) throw notFound();
    if (workspace.kind === "board") {
      assertOrgRole(req.auth, "admin");
      if (access.clientId !== req.auth.cid) throw forbidden();
      return moveStandaloneBoard(access.clientId, req.auth.sub, id, body);
    }

    const moved = await moveBoard({ auth: req.auth, current, body });

    await emitBoardMoved(moved);
    return { id, position: moved.position, positions: moved.rebalancedPositions ?? [] };
  });

  app.patch("/boards/:id/background", async (req) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardAccess(req.auth, id, "editor");
    const body = dto.updateBoardBackgroundBody.parse(req.body);

    const board = await updateBoardBackground({ auth: req.auth, ctx, boardId: id, body });

    await emitToBoardAudience(id, "board:updated", { board }, { workspaceId: ctx.workspaceId });
    return board;
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

    const deleted = await deleteBoard({ auth: req.auth, ctx, boardId: id });

    await notifyDependencyHandoffs({ handoffs: deleted.handoffs, mailer: app.mailer, webOrigin: env.WEB_ORIGIN })
      .catch((err: unknown) => req.log.warn({ err }, "failed to send blockers-cleared notifications"));
    await emitBoardDeleted(deleted);
    return reply.status(204).send();
  });

  app.get("/boards/:id/member-candidates", async (req) => {
    const { id } = req.params as { id: string };
    const ctx = await assertBoardManageAccess(req.auth, id);
    return loadBoardMemberCandidates({ ctx });
  });

  app.post("/boards/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Managing a board's membership is a workspace-admin action, not a board-role one.
    const ctx = await assertBoardManageAccess(req.auth, id);
    const body = dto.addBoardMemberBody.parse(req.body);

    const added = await addBoardMember({ auth: req.auth, ctx, boardId: id, body });

    await emitBoardMemberAdded({ auth: req.auth, ctx, boardId: id, ...added });
    return reply.status(201).send(added.member);
  });

  app.get("/boards/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    await assertBoardManageAccess(req.auth, id);
    return listBoardMembers({ auth: req.auth, boardId: id });
  });

  app.patch("/boards/:id/members/:userId", async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const ctx = await assertBoardManageAccess(req.auth, id);
    const body = dto.updateBoardMemberBody.parse(req.body);

    const updated = await updateBoardMember({ auth: req.auth, ctx, boardId: id, userId, body });

    await emitBoardMemberUpdated(updated);
    return updated.member;
  });

  app.delete("/boards/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const voluntary = userId === req.auth.sub;
    const ctx = voluntary ? await assertBoardAccess(req.auth, id) : await assertBoardManageAccess(req.auth, id);
    // Observer users may leave, but a read-only credential must never gain mutation authority.
    if (req.auth.authKind === "apiKey" && req.auth.apiKeyScope === "read") throw forbidden("write-capable credential required");

    const removed = await removeBoardMember({ auth: req.auth, ctx, boardId: id, userId, voluntary });

    await emitBoardMemberRemoved(removed);
    return reply.status(204).send();
  });
}
