import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  boardGroups,
  boardMembers,
  boardMirrorDirtyCards,
  boardMirrorLists,
  boardMirrors,
  boards,
  cards,
  clients,
  externalLinks,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Db } from "../../db.js";
import { assertBoardAccess, assertBoardManageAccess, assertCardAccess, assertWorkspaceAccess, isOrgAdmin } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { resolveBoardMirrorAccess, visibleBoardMirrorIds } from "../../lib/board-mirror/access.js";
import { emitMirrorMetadataToBoards } from "../../lib/board-mirror/events.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { deleteExternalLinks } from "../../lib/external-links.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const sourceBoards = alias(boards, "mirror_source_board");
const targetBoards = alias(boards, "mirror_target_board");
const sourceWorkspaces = alias(workspaces, "mirror_source_workspace");
const targetWorkspaces = alias(workspaces, "mirror_target_workspace");
const sourceClients = alias(clients, "mirror_source_client");
const targetClients = alias(clients, "mirror_target_client");
const creators = alias(users, "mirror_creator");
const sourceDisablers = alias(users, "mirror_source_disabler");
const sourceLists = alias(lists, "mirror_source_list");
const targetLists = alias(lists, "mirror_target_list");
const sourceCards = alias(cards, "mirror_source_card");
const targetCards = alias(cards, "mirror_target_card");
const candidateOutboundMirrors = alias(boardMirrors, "candidate_outbound_mirror");
const existingCandidateMirrors = alias(boardMirrors, "existing_candidate_mirror");

function mirrorProvider(mirrorId: string): string {
  return `mirror:${mirrorId}`;
}

async function emitMirrorEntityToBoards(
  event: typeof SERVER_EVENTS.BOARD_MIRROR_CREATED | typeof SERVER_EVENTS.BOARD_MIRROR_UPDATED,
  mirror: dto.BoardMirrorRow,
) {
  // A mirror has two equally live board contexts. Publish a durable board-scoped event for each so
  // either open board refreshes its header and management dialog, including across API processes.
  await emitMirrorMetadataToBoards(mirror, event, { mirror });
}

async function emitMirrorDeletedToBoards(mirror: Pick<dto.BoardMirrorRow, "id" | "sourceBoardId" | "targetBoardId" | "sourceWorkspaceId" | "targetWorkspaceId">) {
  const payload = { mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, targetBoardId: mirror.targetBoardId };
  await emitMirrorMetadataToBoards(mirror, SERVER_EVENTS.BOARD_MIRROR_DELETED, payload);
}

async function assertNoMirrorChain(sourceBoardId: string, targetBoardId: string, tx: Tx = db, excludeMirrorId?: string) {
  const [chain] = await tx
    .select({ id: boardMirrors.id })
    .from(boardMirrors)
    .where(and(
      excludeMirrorId ? sql`${boardMirrors.id} <> ${excludeMirrorId}` : undefined,
      or(
        // Board roles belong to the durable relationship, not its current switches. Otherwise a
        // paused A -> B mirror could admit B -> A and leave a loop waiting to be re-enabled.
        eq(boardMirrors.sourceBoardId, targetBoardId),
        eq(boardMirrors.targetBoardId, sourceBoardId),
      ),
    ))
    .limit(1);
  if (chain) throw conflict("a board cannot be both a mirror source and a mirror target");
}

async function lockMirrorTopology(tx: Tx, sourceBoardId: string, targetBoardId: string) {
  // Topology validation spans multiple rows, so uniqueness cannot serialize reciprocal creates.
  // Lock both board identities in a stable order for the transaction: concurrent A->B and B->A
  // attempts then observe one another's committed topology instead of both passing a stale check.
  for (const boardId of [sourceBoardId, targetBoardId].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${boardId}, 0::bigint))`);
  }
}

async function normalizeListMappings(
  input: dto.BoardMirrorListInput[],
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  database: Tx = db,
) {
  const sourceIds = input.map((row) => row.sourceListId);
  if (new Set(sourceIds).size !== sourceIds.length) throw badRequest("source lists must be unique");

  const sourceRows = await database
    .select({ id: lists.id, archivedAt: lists.archivedAt })
    .from(lists)
    .where(and(eq(lists.workspaceId, sourceWorkspaceId), inArray(lists.id, sourceIds)));
  if (sourceRows.length !== sourceIds.length) throw badRequest("one or more source lists are not in the source workspace");
  if (sourceRows.some((row) => row.archivedAt)) throw badRequest("archived source lists cannot be mirrored");

  const sameWorkspace = sourceWorkspaceId === targetWorkspaceId;
  const mappings = input.map((row) => ({
    sourceListId: row.sourceListId,
    // Lists are workspace-scoped, so a same-workspace mirror is always identity-mapped. Ignoring an
    // explicit different id keeps API callers aligned with the UI's hidden target-list selector.
    targetListId: sameWorkspace ? row.sourceListId : (row.targetListId ?? ""),
  }));
  if (mappings.some((row) => !row.targetListId)) throw badRequest("targetListId is required for cross-workspace mirrors");

  const targetIds = [...new Set(mappings.map((row) => row.targetListId))];
  const targetRows = await database
    .select({ id: lists.id, archivedAt: lists.archivedAt })
    .from(lists)
    .where(and(eq(lists.workspaceId, targetWorkspaceId), inArray(lists.id, targetIds)));
  if (targetRows.length !== targetIds.length) throw badRequest("one or more target lists are not in the target workspace");
  if (targetRows.some((row) => row.archivedAt)) throw badRequest("archived target lists cannot be selected");
  return mappings;
}

async function recordMirrorActivities(
  tx: Tx,
  input: {
    action: typeof ACTIVITY_ACTION.MIRROR_CREATED | typeof ACTIVITY_ACTION.MIRROR_UPDATED | typeof ACTIVITY_ACTION.MIRROR_DELETED | typeof ACTIVITY_ACTION.MIRROR_DISABLED | typeof ACTIVITY_ACTION.MIRROR_ENABLED;
    mirrorId: string;
    sourceBoardId: string;
    sourceWorkspaceId: string;
    targetBoardId: string;
    targetWorkspaceId: string;
    actorId: string;
    payload?: Record<string, unknown>;
  },
) {
  const organisationRows = await tx
    .select({ id: workspaces.id, clientId: workspaces.clientId })
    .from(workspaces)
    .where(inArray(workspaces.id, [...new Set([input.sourceWorkspaceId, input.targetWorkspaceId])]))
    .limit(2);
  const sourceClientId = organisationRows.find((workspace) => workspace.id === input.sourceWorkspaceId)?.clientId;
  const targetClientId = organisationRows.find((workspace) => workspace.id === input.targetWorkspaceId)?.clientId;
  const visibilityPayload = { sourceClientId, targetClientId };
  // A transaction is backed by one pg client, so keep the two audit writes sequential.
  await recordActivity(tx, {
      boardId: input.sourceBoardId,
      workspaceId: input.sourceWorkspaceId,
      actorId: input.actorId,
      entityType: "board",
      entityId: input.sourceBoardId,
      action: input.action,
      payload: { mirrorId: input.mirrorId, targetBoardId: input.targetBoardId, ...visibilityPayload, ...input.payload },
    });
  await recordActivity(tx, {
      boardId: input.targetBoardId,
      workspaceId: input.targetWorkspaceId,
      actorId: input.actorId,
      entityType: "board",
      entityId: input.targetBoardId,
      action: input.action,
      payload: { mirrorId: input.mirrorId, sourceBoardId: input.sourceBoardId, ...visibilityPayload, ...input.payload },
    });
}

async function loadMirrorRows(mirrorIds: string[], claims: AuthClaims): Promise<dto.BoardMirrorRow[]> {
  if (mirrorIds.length === 0) return [];
  const rows = await db
    .select({
      mirror: boardMirrors,
      sourceBoardName: sourceBoards.name,
      sourceWorkspaceName: sourceWorkspaces.name,
      sourceOrganisationName: sourceClients.name,
      targetBoardName: targetBoards.name,
      targetWorkspaceName: targetWorkspaces.name,
      targetOrganisationName: targetClients.name,
      createdByName: creators.displayName,
      sourceDisabledByName: sourceDisablers.displayName,
    })
    .from(boardMirrors)
    .innerJoin(sourceBoards, eq(sourceBoards.id, boardMirrors.sourceBoardId))
    .innerJoin(sourceWorkspaces, eq(sourceWorkspaces.id, boardMirrors.sourceWorkspaceId))
    .innerJoin(sourceClients, eq(sourceClients.id, sourceWorkspaces.clientId))
    .innerJoin(targetBoards, eq(targetBoards.id, boardMirrors.targetBoardId))
    .innerJoin(targetWorkspaces, eq(targetWorkspaces.id, boardMirrors.targetWorkspaceId))
    .innerJoin(targetClients, eq(targetClients.id, targetWorkspaces.clientId))
    .innerJoin(creators, eq(creators.id, boardMirrors.createdById))
    .leftJoin(sourceDisablers, eq(sourceDisablers.id, boardMirrors.sourceDisabledById))
    .where(inArray(boardMirrors.id, mirrorIds));

  const listRows = await db
    .select({
      mirrorId: boardMirrorLists.mirrorId,
      sourceListId: boardMirrorLists.sourceListId,
      sourceListName: sourceLists.name,
      targetListId: boardMirrorLists.targetListId,
      targetListName: targetLists.name,
      targetListArchivedAt: targetLists.archivedAt,
    })
    .from(boardMirrorLists)
    .innerJoin(sourceLists, eq(sourceLists.id, boardMirrorLists.sourceListId))
    .innerJoin(targetLists, eq(targetLists.id, boardMirrorLists.targetListId))
    .where(inArray(boardMirrorLists.mirrorId, mirrorIds))
    .orderBy(asc(sourceLists.position));
  const listsByMirror = new Map<string, dto.BoardMirrorListRow[]>();
  for (const row of listRows) {
    const list = listsByMirror.get(row.mirrorId) ?? [];
    list.push({
      sourceListId: row.sourceListId,
      sourceListName: row.sourceListName,
      targetListId: row.targetListId,
      targetListName: row.targetListName,
      targetListArchived: row.targetListArchivedAt !== null,
    });
    listsByMirror.set(row.mirrorId, list);
  }
  const workspaceIds = [...new Set(rows.flatMap((row) => [row.mirror.sourceWorkspaceId, row.mirror.targetWorkspaceId]))];
  const availableListRows = await db.select({ id: lists.id, name: lists.name, workspaceId: lists.workspaceId }).from(lists).where(and(inArray(lists.workspaceId, workspaceIds), isNull(lists.archivedAt))).orderBy(asc(lists.position));
  const availableByWorkspace = new Map<string, dto.BoardMirrorAvailableList[]>();
  for (const list of availableListRows) availableByWorkspace.set(list.workspaceId, [...(availableByWorkspace.get(list.workspaceId) ?? []), { id: list.id, name: list.name }]);
  const dirtyErrorRows = await db
    .select({ mirrorId: boardMirrorDirtyCards.mirrorId, lastError: boardMirrorDirtyCards.lastError })
    .from(boardMirrorDirtyCards)
    .where(and(inArray(boardMirrorDirtyCards.mirrorId, mirrorIds), isNotNull(boardMirrorDirtyCards.lastError)))
    .orderBy(desc(boardMirrorDirtyCards.attempts), desc(boardMirrorDirtyCards.updatedAt));
  const dirtyErrorByMirror = new Map<string, string>();
  for (const row of dirtyErrorRows) {
    if (row.lastError && !dirtyErrorByMirror.has(row.mirrorId)) dirtyErrorByMirror.set(row.mirrorId, row.lastError);
  }
  const accessByMirror = new Map(await Promise.all(rows.map(async (row) => [row.mirror.id, await resolveBoardMirrorAccess(claims, row.mirror)] as const)));
  return rows.map((row) => ({
    id: row.mirror.id,
    sourceBoardId: row.mirror.sourceBoardId,
    sourceBoardName: row.sourceBoardName,
    sourceWorkspaceId: row.mirror.sourceWorkspaceId,
    sourceWorkspaceName: row.sourceWorkspaceName,
    sourceOrganisationName: row.sourceOrganisationName,
    targetBoardId: row.mirror.targetBoardId,
    targetBoardName: row.targetBoardName,
    targetWorkspaceId: row.mirror.targetWorkspaceId,
    targetWorkspaceName: row.targetWorkspaceName,
    targetOrganisationName: row.targetOrganisationName,
    createdById: row.mirror.createdById,
    createdByName: row.createdByName,
    pausedAt: row.mirror.pausedAt,
    sourceDisabledAt: row.mirror.sourceDisabledAt,
    sourceDisabledByName: row.sourceDisabledByName,
    reconcileRequestedAt: row.mirror.reconcileRequestedAt,
    lastSyncAt: row.mirror.lastSyncAt,
    consecutiveFailures: row.mirror.consecutiveFailures,
    nextRetryAt: row.mirror.nextRetryAt,
    // Drain/reconcile health belongs to the mirror row; per-card retry failures remain on the dirty
    // row so deleting that row after a successful retry clears a stale "Needs attention" status.
    lastError: dirtyErrorByMirror.get(row.mirror.id) ?? row.mirror.lastError,
    createdAt: row.mirror.createdAt,
    updatedAt: row.mirror.updatedAt,
    lists: listsByMirror.get(row.mirror.id) ?? [],
    availableSourceLists: availableByWorkspace.get(row.mirror.sourceWorkspaceId) ?? [],
    availableTargetLists: availableByWorkspace.get(row.mirror.targetWorkspaceId) ?? [],
    manageSource: accessByMirror.get(row.mirror.id)?.manageSource ?? false,
    manageTarget: accessByMirror.get(row.mirror.id)?.manageTarget ?? false,
  }));
}

async function loadManagedMirror(mirrorId: string, boardId: string) {
  const [mirror] = await db
    .select()
    .from(boardMirrors)
    .where(and(
      eq(boardMirrors.id, mirrorId),
      or(eq(boardMirrors.sourceBoardId, boardId), eq(boardMirrors.targetBoardId, boardId)),
    ))
    .limit(1);
  if (!mirror) throw notFound("board mirror not found");
  return mirror;
}

async function assertMirrorCapability(
  claims: AuthClaims,
  mirror: Awaited<ReturnType<typeof loadManagedMirror>>,
  capability: "source" | "target" | "either",
) {
  const access = await resolveBoardMirrorAccess(claims, mirror);
  const allowed = capability === "source"
    ? access.manageSource
    : capability === "target"
      ? access.manageTarget
      : access.manageSource || access.manageTarget;
  if (!allowed) throw forbidden();
  return access;
}

export async function boardMirrorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:workspaceId/mirror-status", async (req): Promise<{ count: number }> => {
    const { workspaceId } = req.params as { workspaceId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(boardMirrors)
      .where(or(eq(boardMirrors.sourceWorkspaceId, workspaceId), eq(boardMirrors.targetWorkspaceId, workspaceId)));
    // Count each relationship once even when both boards belong to this workspace; the OR predicate
    // returns one mirror row and therefore matches the destructive toggle's deletion count.
    return { count: result?.count ?? 0 };
  });

  app.get("/boards/:boardId/mirror-status", async (req): Promise<dto.BoardMirrorStatus> => {
    const { boardId } = req.params as { boardId: string };
    await assertBoardAccess(req.auth, boardId);
    const visibleIds = await visibleBoardMirrorIds(boardId, req.auth.cid);
    if (visibleIds.length === 0) return { count: 0, inboundCount: 0, outboundCount: 0, canManage: false };
    const [result] = await db
      .select({
        count: sql<number>`count(*)::int`,
        inboundCount: sql<number>`count(*) filter (where ${boardMirrors.targetBoardId} = ${boardId})::int`,
        outboundCount: sql<number>`count(*) filter (where ${boardMirrors.sourceBoardId} = ${boardId})::int`,
      })
      .from(boardMirrors)
      .where(inArray(boardMirrors.id, visibleIds));
    const visibleMirrors = await db.select().from(boardMirrors).where(inArray(boardMirrors.id, visibleIds));
    const capabilities = await Promise.all(visibleMirrors.map((mirror) => resolveBoardMirrorAccess(req.auth, mirror)));
    // Both incoming and outgoing relationships make this board part of a mirror and belong in
    // the single management count shown in its header menu. Direction counts let that menu prevent
    // a mirror target from opening a source creation flow before the heavier dialog is requested.
    return {
      count: result?.count ?? 0,
      inboundCount: result?.inboundCount ?? 0,
      outboundCount: result?.outboundCount ?? 0,
      canManage: capabilities.some((access) => access.manageSource || access.manageTarget),
    };
  });

  app.post("/boards/:boardId/mirrors", async (req, reply) => {
    const { boardId: sourceBoardId } = req.params as { boardId: string };
    const body = dto.createBoardMirrorBody.parse(req.body);
    const sourceCtx = await assertBoardAccess(req.auth, sourceBoardId, "editor");
    const targetCtx = await assertBoardManageAccess(req.auth, body.targetBoardId);
    if (sourceBoardId === body.targetBoardId) throw badRequest("a board cannot mirror itself");
    const mappings = await normalizeListMappings(body.lists, sourceCtx.workspaceId, targetCtx.workspaceId);

    const mirror = await db.transaction(async (tx) => {
      await lockMirrorTopology(tx, sourceBoardId, body.targetBoardId);
      const participatingWorkspaces = await tx
        .select({ id: workspaces.id, boardLinkingEnabled: workspaces.boardLinkingEnabled })
        .from(workspaces)
        .where(inArray(workspaces.id, [...new Set([sourceCtx.workspaceId, targetCtx.workspaceId])]));
      // Both owners opt in: a workspace that disables linking cannot be used as either side of a
      // relationship, including through a stale dialog that was opened before the setting changed.
      if (participatingWorkspaces.length === 0 || participatingWorkspaces.some((workspace) => !workspace.boardLinkingEnabled)) {
        throw badRequest("board linking is disabled for one or more participating workspaces");
      }
      const [existing] = await tx
        .select({ id: boardMirrors.id })
        .from(boardMirrors)
        .where(and(eq(boardMirrors.sourceBoardId, sourceBoardId), eq(boardMirrors.targetBoardId, body.targetBoardId)))
        .limit(1);
      if (existing) throw conflict("this board mirror already exists");
      await assertNoMirrorChain(sourceBoardId, body.targetBoardId, tx);
      const now = new Date();
      const [created] = await tx.insert(boardMirrors).values({
        sourceBoardId,
        targetBoardId: body.targetBoardId,
        sourceWorkspaceId: sourceCtx.workspaceId,
        targetWorkspaceId: targetCtx.workspaceId,
        createdById: req.auth.sub,
        cursorEventCreatedAt: now,
        cursorEventId: NIL_UUID,
        lastSyncAt: now,
      }).returning();
      await tx.insert(boardMirrorLists).values(mappings.map((mapping) => ({ mirrorId: created!.id, ...mapping })));
      await recordMirrorActivities(tx, {
        action: ACTIVITY_ACTION.MIRROR_CREATED,
        mirrorId: created!.id,
        sourceBoardId,
        sourceWorkspaceId: sourceCtx.workspaceId,
        targetBoardId: body.targetBoardId,
        targetWorkspaceId: targetCtx.workspaceId,
        actorId: req.auth.sub,
      });
      return created!;
    });
    const [response] = await loadMirrorRows([mirror.id], req.auth);
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_CREATED, response!);
    return reply.status(201).send(response!);
  });

  app.get("/boards/:boardId/mirrors", async (req): Promise<dto.BoardMirrorRow[]> => {
    const { boardId } = req.params as { boardId: string };
    await assertBoardAccess(req.auth, boardId, "editor");
    const visibleIds = new Set(await visibleBoardMirrorIds(boardId, req.auth.cid));
    const rows = await db.select({ id: boardMirrors.id }).from(boardMirrors).where(eq(boardMirrors.targetBoardId, boardId));
    return loadMirrorRows(rows.filter((row) => visibleIds.has(row.id)).map((row) => row.id), req.auth);
  });

  app.get("/boards/:boardId/outbound-mirrors", async (req): Promise<dto.BoardMirrorRow[]> => {
    const { boardId } = req.params as { boardId: string };
    await assertBoardAccess(req.auth, boardId, "editor");
    const visibleIds = new Set(await visibleBoardMirrorIds(boardId, req.auth.cid));
    const rows = await db.select({ id: boardMirrors.id }).from(boardMirrors).where(eq(boardMirrors.sourceBoardId, boardId));
    return loadMirrorRows(rows.filter((row) => visibleIds.has(row.id)).map((row) => row.id), req.auth);
  });

  app.patch("/boards/:boardId/mirrors/:mirrorId", async (req): Promise<dto.BoardMirrorRow> => {
    const { boardId, mirrorId } = req.params as { boardId: string; mirrorId: string };
    const body = dto.updateBoardMirrorBody.parse(req.body);
    await assertBoardAccess(req.auth, boardId, "editor");
    const mirror = await loadManagedMirror(mirrorId, boardId);
    // Pausing is target-owned governance. The source may change which of its lists feed the
    // established relationship, but must use its independent enable/disable control for syncing.
    if (body.paused !== undefined) await assertMirrorCapability(req.auth, mirror, "target");
    if (body.lists !== undefined) await assertMirrorCapability(req.auth, mirror, "either");
    const mappings = body.lists
      ? await normalizeListMappings(body.lists, mirror.sourceWorkspaceId, mirror.targetWorkspaceId)
      : null;
    await db.transaction(async (tx) => {
      const now = new Date();
      if (body.paused === false && mirror.pausedAt) {
        await lockMirrorTopology(tx, mirror.sourceBoardId, mirror.targetBoardId);
        await assertNoMirrorChain(mirror.sourceBoardId, mirror.targetBoardId, tx, mirror.id);
      }
      await tx.update(boardMirrors).set({
        ...(body.paused === true && !mirror.pausedAt && { pausedAt: now }),
        ...(body.paused === false && mirror.pausedAt && {
          pausedAt: null,
          cursorEventCreatedAt: now,
          cursorEventId: NIL_UUID,
          reconcileRequestedAt: now,
        }),
        updatedAt: now,
      }).where(eq(boardMirrors.id, mirror.id));
      if (mappings) {
        await tx.delete(boardMirrorLists).where(eq(boardMirrorLists.mirrorId, mirror.id));
        await tx.insert(boardMirrorLists).values(mappings.map((mapping) => ({ mirrorId: mirror.id, ...mapping })));
      }
      await recordMirrorActivities(tx, {
        action: ACTIVITY_ACTION.MIRROR_UPDATED,
        mirrorId: mirror.id,
        sourceBoardId: mirror.sourceBoardId,
        sourceWorkspaceId: mirror.sourceWorkspaceId,
        targetBoardId: mirror.targetBoardId,
        targetWorkspaceId: mirror.targetWorkspaceId,
        actorId: req.auth.sub,
        payload: { ...(body.paused !== undefined && { paused: body.paused }), ...(mappings && { listsReplaced: true }) },
      });
    });
    const response = (await loadMirrorRows([mirror.id], req.auth))[0]!;
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_UPDATED, response);
    return response;
  });

  app.post("/boards/:boardId/mirrors/:mirrorId/source-disable", async (req) => {
    const { boardId, mirrorId } = req.params as { boardId: string; mirrorId: string };
    await assertBoardAccess(req.auth, boardId, "editor");
    const mirror = await loadManagedMirror(mirrorId, boardId);
    await assertMirrorCapability(req.auth, mirror, "source");
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(boardMirrors).set({ sourceDisabledAt: now, sourceDisabledById: req.auth.sub, updatedAt: now }).where(eq(boardMirrors.id, mirror.id));
      await recordMirrorActivities(tx, { action: ACTIVITY_ACTION.MIRROR_DISABLED, mirrorId, sourceBoardId: mirror.sourceBoardId, sourceWorkspaceId: mirror.sourceWorkspaceId, targetBoardId: mirror.targetBoardId, targetWorkspaceId: mirror.targetWorkspaceId, actorId: req.auth.sub });
    });
    const response = (await loadMirrorRows([mirror.id], req.auth))[0]!;
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_UPDATED, response);
    return { ok: true };
  });

  app.post("/boards/:boardId/mirrors/:mirrorId/source-enable", async (req) => {
    const { boardId, mirrorId } = req.params as { boardId: string; mirrorId: string };
    await assertBoardAccess(req.auth, boardId, "editor");
    const mirror = await loadManagedMirror(mirrorId, boardId);
    await assertMirrorCapability(req.auth, mirror, "source");
    const now = new Date();
    await db.transaction(async (tx) => {
      await lockMirrorTopology(tx, mirror.sourceBoardId, mirror.targetBoardId);
      await assertNoMirrorChain(mirror.sourceBoardId, mirror.targetBoardId, tx, mirror.id);
      await tx.update(boardMirrors).set({ sourceDisabledAt: null, sourceDisabledById: null, cursorEventCreatedAt: now, cursorEventId: NIL_UUID, reconcileRequestedAt: now, updatedAt: now }).where(eq(boardMirrors.id, mirror.id));
      await recordMirrorActivities(tx, { action: ACTIVITY_ACTION.MIRROR_ENABLED, mirrorId, sourceBoardId: mirror.sourceBoardId, sourceWorkspaceId: mirror.sourceWorkspaceId, targetBoardId: mirror.targetBoardId, targetWorkspaceId: mirror.targetWorkspaceId, actorId: req.auth.sub });
    });
    const response = (await loadMirrorRows([mirror.id], req.auth))[0]!;
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_UPDATED, response);
    return { ok: true };
  });

  app.delete("/boards/:boardId/mirrors/:mirrorId", async (req, reply) => {
    const { boardId, mirrorId } = req.params as { boardId: string; mirrorId: string };
    await assertBoardAccess(req.auth, boardId, "editor");
    // Either participating board may end the relationship; deleting the durable link leaves the
    // already-created target cards intact, regardless of which side initiated the removal.
    const mirror = await loadManagedMirror(mirrorId, boardId);
    await assertMirrorCapability(req.auth, mirror, "either");
    await db.transaction(async (tx) => {
      await recordMirrorActivities(tx, { action: ACTIVITY_ACTION.MIRROR_DELETED, mirrorId, sourceBoardId: mirror.sourceBoardId, sourceWorkspaceId: mirror.sourceWorkspaceId, targetBoardId: mirror.targetBoardId, targetWorkspaceId: mirror.targetWorkspaceId, actorId: req.auth.sub });
      await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider: mirrorProvider(mirror.id) }, tx);
      await tx.delete(boardMirrors).where(eq(boardMirrors.id, mirror.id));
    });
    await emitMirrorDeletedToBoards(mirror);
    return reply.status(204).send();
  });

  app.get("/cards/:id/mirrors", async (req): Promise<dto.CardMirrorStatus> => {
    const { id } = req.params as { id: string };
    await assertCardAccess(req.auth, id);
    const relationships = await db
      .select({
        mirrorId: boardMirrors.id,
        sourceCardId: sourceCards.id,
        sourceBoardId: sourceBoards.id,
        sourceBoardName: sourceBoards.name,
        sourceWorkspaceName: sourceWorkspaces.name,
        sourceOrganisationName: sourceClients.name,
        targetCardId: targetCards.id,
        targetBoardId: targetBoards.id,
        targetBoardName: targetBoards.name,
        targetWorkspaceName: targetWorkspaces.name,
        targetOrganisationName: targetClients.name,
      })
      .from(externalLinks)
      .innerJoin(boardMirrors, and(
        sql`${externalLinks.provider} = 'mirror:' || ${boardMirrors.id}::text`,
        eq(externalLinks.workspaceId, boardMirrors.targetWorkspaceId),
      ))
      .innerJoin(sourceBoards, eq(sourceBoards.id, boardMirrors.sourceBoardId))
      .innerJoin(sourceWorkspaces, eq(sourceWorkspaces.id, boardMirrors.sourceWorkspaceId))
      .innerJoin(sourceClients, eq(sourceClients.id, sourceWorkspaces.clientId))
      .innerJoin(targetBoards, eq(targetBoards.id, boardMirrors.targetBoardId))
      .innerJoin(targetWorkspaces, eq(targetWorkspaces.id, boardMirrors.targetWorkspaceId))
      .innerJoin(targetClients, eq(targetClients.id, targetWorkspaces.clientId))
      // Inner joins intentionally hide retained tombstones after either counterpart is purged.
      .innerJoin(sourceCards, and(eq(sourceCards.boardId, boardMirrors.sourceBoardId), sql`${sourceCards.id}::text = ${externalLinks.externalId}`))
      .innerJoin(targetCards, and(eq(targetCards.id, externalLinks.entityId), eq(targetCards.boardId, boardMirrors.targetBoardId)))
      .where(and(
        eq(externalLinks.externalType, "card"),
        eq(externalLinks.entityType, "card"),
        sql`${externalLinks.provider} like 'mirror:%'`,
        or(eq(sourceCards.id, id), eq(targetCards.id, id)),
        // Card content remains visible through normal board access, but relationship provenance is
        // confidential to the organisations that own one of the two participating workspaces.
        or(eq(sourceWorkspaces.clientId, req.auth.cid), eq(targetWorkspaces.clientId, req.auth.cid)),
      ));
    return {
      asSource: relationships.filter((row) => row.sourceCardId === id).map((row) => ({ mirrorId: row.mirrorId, cardId: row.targetCardId, boardId: row.targetBoardId, boardName: row.targetBoardName, workspaceName: row.targetWorkspaceName, organisationName: row.targetOrganisationName })),
      asTarget: relationships.filter((row) => row.targetCardId === id).map((row) => ({ mirrorId: row.mirrorId, cardId: row.sourceCardId, boardId: row.sourceBoardId, boardName: row.sourceBoardName, workspaceName: row.sourceWorkspaceName, organisationName: row.sourceOrganisationName })),
    };
  });

  app.get("/mirror-target-boards", async (req): Promise<dto.MirrorTargetBoardsResponse> => {
    const { sourceBoardId } = dto.mirrorTargetBoardsQuery.parse(req.query);
    await assertBoardAccess(req.auth, sourceBoardId, "editor");
    const [incomingMirror] = await db
      .select({ id: boardMirrors.id })
      .from(boardMirrors)
      .where(eq(boardMirrors.targetBoardId, sourceBoardId))
      .limit(1);
    if (incomingMirror) return { targets: [], sourceBlockedByIncomingMirror: true };
    const managedWorkspace = !isOrgAdmin(req.auth)
      ? sql`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${req.auth.sub} and ${workspaceMembers.role} = 'admin')`
      : undefined;
    const boardRows = await db
      .select({ id: boards.id, name: boards.name, workspaceId: workspaces.id, workspaceName: workspaces.name, organisationName: clients.name })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .leftJoin(boardGroups, eq(boardGroups.id, boards.groupId))
      .where(and(
        eq(workspaces.clientId, req.auth.cid),
        eq(workspaces.boardLinkingEnabled, true),
        isNull(boards.archivedAt),
        isNull(workspaces.archivedAt),
        sql`${boards.id} <> ${sourceBoardId}`,
        // Match create-time topology validation so the dialog never offers a board that would
        // become both a mirror source and target, reverse a flow, or duplicate a relationship.
        notExists(db.select({ id: candidateOutboundMirrors.id }).from(candidateOutboundMirrors).where(eq(candidateOutboundMirrors.sourceBoardId, boards.id))),
        notExists(db.select({ id: existingCandidateMirrors.id }).from(existingCandidateMirrors).where(and(
          eq(existingCandidateMirrors.sourceBoardId, sourceBoardId),
          eq(existingCandidateMirrors.targetBoardId, boards.id),
        ))),
        managedWorkspace,
      ))
      // Keep target discovery in the same visual order as the app shell: standard workspaces
      // before standalone boards, workspace creation order, then grouped and ungrouped boards.
      .orderBy(
        sql`case when ${workspaces.kind} = 'standard' then 0 else 1 end`,
        asc(workspaces.createdAt),
        sql`case when ${boards.groupId} is null then 1 else 0 end`,
        asc(boardGroups.position),
        asc(boards.position),
      );
    const workspaceIds = [...new Set(boardRows.map((board) => board.workspaceId))];
    const listRows = workspaceIds.length > 0
      ? await db.select({ id: lists.id, name: lists.name, workspaceId: lists.workspaceId }).from(lists).where(and(inArray(lists.workspaceId, workspaceIds), isNull(lists.archivedAt))).orderBy(asc(lists.position))
      : [];
    const listsByWorkspace = new Map<string, dto.MirrorTargetList[]>();
    for (const list of listRows) listsByWorkspace.set(list.workspaceId, [...(listsByWorkspace.get(list.workspaceId) ?? []), { id: list.id, name: list.name }]);
    return {
      targets: boardRows.map((board) => ({ ...board, lists: listsByWorkspace.get(board.workspaceId) ?? [] })),
      sourceBlockedByIncomingMirror: false,
    };
  });

  app.get("/mirror-source-boards", async (req): Promise<dto.MirrorSourceBoardsResponse> => {
    const { targetBoardId } = dto.mirrorSourceBoardsQuery.parse(req.query);
    await assertBoardManageAccess(req.auth, targetBoardId);
    const [target] = await db
      .select({ workspaceId: boards.workspaceId, boardLinkingEnabled: workspaces.boardLinkingEnabled })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(eq(boards.id, targetBoardId))
      .limit(1);
    if (!target) throw notFound("board not found");
    if (!target.boardLinkingEnabled) return { sources: [] };

    const [targetAlreadySource] = await db
      .select({ id: boardMirrors.id })
      .from(boardMirrors)
      .where(eq(boardMirrors.sourceBoardId, targetBoardId))
      .limit(1);
    if (targetAlreadySource) return { sources: [] };

    const boardRows = await db
      .select({ id: boards.id, name: boards.name, workspaceId: workspaces.id, workspaceName: workspaces.name, organisationName: clients.name })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, req.auth.sub)))
      .leftJoin(boardGroups, eq(boardGroups.id, boards.groupId))
      .where(and(
        eq(workspaces.boardLinkingEnabled, true),
        isNull(boards.archivedAt),
        isNull(workspaces.archivedAt),
        sql`${boards.id} <> ${targetBoardId}`,
        isOrgAdmin(req.auth)
          ? or(eq(workspaces.clientId, req.auth.cid), eq(boardMembers.role, "editor"))
          : eq(boardMembers.role, "editor"),
        // Creation still performs the authoritative locked checks. These matching predicates keep
        // stale, reverse, duplicate, and chained choices out of the target-first selector.
        notExists(db.select({ id: boardMirrors.id }).from(boardMirrors).where(eq(boardMirrors.targetBoardId, boards.id))),
        notExists(db.select({ id: boardMirrors.id }).from(boardMirrors).where(and(
          eq(boardMirrors.sourceBoardId, boards.id),
          eq(boardMirrors.targetBoardId, targetBoardId),
        ))),
      ))
      .orderBy(
        asc(clients.name),
        sql`case when ${workspaces.kind} = 'standard' then 0 else 1 end`,
        asc(workspaces.createdAt),
        sql`case when ${boards.groupId} is null then 1 else 0 end`,
        asc(boardGroups.position),
        asc(boards.position),
      );
    const workspaceIds = [...new Set(boardRows.map((board) => board.workspaceId))];
    const listRows = workspaceIds.length > 0
      ? await db.select({ id: lists.id, name: lists.name, workspaceId: lists.workspaceId }).from(lists).where(and(inArray(lists.workspaceId, workspaceIds), isNull(lists.archivedAt))).orderBy(asc(lists.position))
      : [];
    const listsByWorkspace = new Map<string, dto.MirrorTargetList[]>();
    for (const list of listRows) listsByWorkspace.set(list.workspaceId, [...(listsByWorkspace.get(list.workspaceId) ?? []), { id: list.id, name: list.name }]);
    return { sources: boardRows.map((board) => ({ ...board, lists: listsByWorkspace.get(board.workspaceId) ?? [] })) };
  });
}
