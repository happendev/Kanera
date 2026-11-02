import type { dto } from "@kanera/shared";
import {
  boardMembers,
  boardMirrorDirtyCards,
  boardMirrorLists,
  boardMirrors,
  boards,
  cards,
  clients,
  externalLinks,
  lists,
  standaloneBoardGroups,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { isOrgAdmin } from "../../lib/access.js";
import { env } from "../../env.js";
import { resolveBoardMirrorAccess, visibleBoardMirrorIds } from "../../lib/board-mirror/access.js";
import { PAID_BILLING_STATUSES } from "../../lib/entitlements.js";
import { notFound } from "../../lib/errors.js";
import { hasBoardSyncEntitlement } from "../../lib/tier-limits.js";
import { sortInNavigationOrder } from "./route-support.js";

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

export async function loadMirrorRows(mirrorIds: string[], claims: AuthClaims): Promise<dto.BoardMirrorRow[]> {
  if (mirrorIds.length === 0) return [];
  const rows = await db
    .select({
      mirror: boardMirrors,
      sourceBoardName: sourceBoards.name,
      sourceWorkspaceName: sourceWorkspaces.name,
      sourceOrganisationName: sourceClients.name,
      sourcePlan: sourceClients.plan,
      sourceBillingStatus: sourceClients.billingStatus,
      targetBoardName: targetBoards.name,
      targetWorkspaceName: targetWorkspaces.name,
      targetOrganisationName: targetClients.name,
      targetPlan: targetClients.plan,
      targetBillingStatus: targetClients.billingStatus,
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
    // Plan blocking is derived so an upgrade resumes an otherwise-active mirror without clearing a
    // target pause or source disable that an administrator set deliberately.
    planBlocked: !hasBoardSyncEntitlement(row.sourcePlan, row.sourceBillingStatus)
      || !hasBoardSyncEntitlement(row.targetPlan, row.targetBillingStatus),
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

/** `GET /workspaces/:workspaceId/mirror-status` */
export async function loadWorkspaceMirrorStatus(workspaceId: string): Promise<{ count: number }> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(boardMirrors)
    .where(or(eq(boardMirrors.sourceWorkspaceId, workspaceId), eq(boardMirrors.targetWorkspaceId, workspaceId)));
  // Count each relationship once even when both boards belong to this workspace; the OR predicate
  // returns one mirror row and therefore matches the destructive toggle's deletion count.
  return { count: result?.count ?? 0 };
}

/** `GET /boards/:boardId/mirror-status` */
export async function loadBoardMirrorStatus(auth: AuthClaims, boardId: string): Promise<dto.BoardMirrorStatus> {
  const visibleIds = await visibleBoardMirrorIds(boardId, auth.cid);
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
  const capabilities = await Promise.all(visibleMirrors.map((mirror) => resolveBoardMirrorAccess(auth, mirror)));
  // Both incoming and outgoing relationships make this board part of a mirror and belong in
  // the single management count shown in its header menu. Direction counts let that menu prevent
  // a mirror target from opening a source creation flow before the heavier dialog is requested.
  return {
    count: result?.count ?? 0,
    inboundCount: result?.inboundCount ?? 0,
    outboundCount: result?.outboundCount ?? 0,
    canManage: capabilities.some((access) => access.manageSource || access.manageTarget),
  };
}

/**
 * `GET /boards/:boardId/mirrors` and `GET /boards/:boardId/outbound-mirrors`: the mirrors in which
 * this board is the target ("inbound") or the source ("outbound"), limited to those visible to the
 * caller's organisation.
 */
export async function loadBoardMirrors(auth: AuthClaims, boardId: string, direction: "inbound" | "outbound"): Promise<dto.BoardMirrorRow[]> {
  const visibleIds = new Set(await visibleBoardMirrorIds(boardId, auth.cid));
  const rows = await db
    .select({ id: boardMirrors.id })
    .from(boardMirrors)
    .where(direction === "inbound" ? eq(boardMirrors.targetBoardId, boardId) : eq(boardMirrors.sourceBoardId, boardId));
  return loadMirrorRows(rows.filter((row) => visibleIds.has(row.id)).map((row) => row.id), auth);
}

/** `GET /cards/:id/mirrors` */
export async function loadCardMirrorStatus(auth: AuthClaims, id: string): Promise<dto.CardMirrorStatus> {
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
      or(eq(sourceWorkspaces.clientId, auth.cid), eq(targetWorkspaces.clientId, auth.cid)),
    ));
  return {
    asSource: relationships.filter((row) => row.sourceCardId === id).map((row) => ({ mirrorId: row.mirrorId, cardId: row.targetCardId, boardId: row.targetBoardId, boardName: row.targetBoardName, workspaceName: row.targetWorkspaceName, organisationName: row.targetOrganisationName })),
    asTarget: relationships.filter((row) => row.targetCardId === id).map((row) => ({ mirrorId: row.mirrorId, cardId: row.sourceCardId, boardId: row.sourceBoardId, boardName: row.sourceBoardName, workspaceName: row.sourceWorkspaceName, organisationName: row.sourceOrganisationName })),
  };
}

/** `GET /mirror-target-boards`: boards the caller may pick as the target of a new mirror. */
export async function listMirrorTargetBoards(auth: AuthClaims, sourceBoardId: string): Promise<dto.MirrorTargetBoardsResponse> {
  const [incomingMirror] = await db
    .select({ id: boardMirrors.id })
    .from(boardMirrors)
    .where(eq(boardMirrors.targetBoardId, sourceBoardId))
    .limit(1);
  if (incomingMirror) return { targets: [], sourceBlockedByIncomingMirror: true };
  const managedWorkspace = !isOrgAdmin(auth)
    ? sql`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${auth.sub} and ${workspaceMembers.role} = 'admin')`
    : undefined;
  const boardRows = await db
    .select({
      id: boards.id,
      name: boards.name,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceKind: workspaces.kind,
      organisationId: clients.id,
      organisationName: clients.name,
      standaloneGroupId: boards.standaloneGroupId,
      standaloneGroupTitle: standaloneBoardGroups.title,
    })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .leftJoin(standaloneBoardGroups, eq(standaloneBoardGroups.id, boards.standaloneGroupId))
    .where(and(
      eq(workspaces.clientId, auth.cid),
      env.KANERA_DEPLOYMENT_MODE === "hosted" ? eq(clients.plan, "paid") : undefined,
      env.KANERA_DEPLOYMENT_MODE === "hosted" ? inArray(clients.billingStatus, PAID_BILLING_STATUSES) : undefined,
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
    .orderBy(asc(boards.id));
  const orderedBoardRows = await sortInNavigationOrder(auth, boardRows);
  const workspaceIds = [...new Set(orderedBoardRows.map((board) => board.workspaceId))];
  const listRows = workspaceIds.length > 0
    ? await db.select({ id: lists.id, name: lists.name, workspaceId: lists.workspaceId }).from(lists).where(and(inArray(lists.workspaceId, workspaceIds), isNull(lists.archivedAt))).orderBy(asc(lists.position))
    : [];
  const listsByWorkspace = new Map<string, dto.MirrorTargetList[]>();
  for (const list of listRows) listsByWorkspace.set(list.workspaceId, [...(listsByWorkspace.get(list.workspaceId) ?? []), { id: list.id, name: list.name }]);
  return {
    targets: orderedBoardRows.map((board) => ({ ...board, lists: listsByWorkspace.get(board.workspaceId) ?? [] })),
    sourceBlockedByIncomingMirror: false,
  };
}

/** `GET /mirror-source-boards`: boards the caller may pick as the source of a new mirror into a target. */
export async function listMirrorSourceBoards(auth: AuthClaims, targetBoardId: string): Promise<dto.MirrorSourceBoardsResponse> {
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
    .select({
      id: boards.id,
      name: boards.name,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceKind: workspaces.kind,
      organisationId: clients.id,
      organisationName: clients.name,
      standaloneGroupId: boards.standaloneGroupId,
      standaloneGroupTitle: standaloneBoardGroups.title,
    })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, auth.sub)))
    .leftJoin(standaloneBoardGroups, eq(standaloneBoardGroups.id, boards.standaloneGroupId))
    .where(and(
      eq(workspaces.boardLinkingEnabled, true),
      env.KANERA_DEPLOYMENT_MODE === "hosted" ? eq(clients.plan, "paid") : undefined,
      env.KANERA_DEPLOYMENT_MODE === "hosted" ? inArray(clients.billingStatus, PAID_BILLING_STATUSES) : undefined,
      isNull(boards.archivedAt),
      isNull(workspaces.archivedAt),
      sql`${boards.id} <> ${targetBoardId}`,
      isOrgAdmin(auth)
        ? or(eq(workspaces.clientId, auth.cid), eq(boardMembers.role, "editor"))
        : eq(boardMembers.role, "editor"),
      // Creation still performs the authoritative locked checks. These matching predicates keep
      // stale, reverse, duplicate, and chained choices out of the target-first selector.
      notExists(db.select({ id: boardMirrors.id }).from(boardMirrors).where(eq(boardMirrors.targetBoardId, boards.id))),
      notExists(db.select({ id: boardMirrors.id }).from(boardMirrors).where(and(
        eq(boardMirrors.sourceBoardId, boards.id),
        eq(boardMirrors.targetBoardId, targetBoardId),
      ))),
    ))
    .orderBy(asc(boards.id));
  const orderedBoardRows = await sortInNavigationOrder(auth, boardRows);
  const workspaceIds = [...new Set(orderedBoardRows.map((board) => board.workspaceId))];
  const listRows = workspaceIds.length > 0
    ? await db.select({ id: lists.id, name: lists.name, workspaceId: lists.workspaceId }).from(lists).where(and(inArray(lists.workspaceId, workspaceIds), isNull(lists.archivedAt))).orderBy(asc(lists.position))
    : [];
  const listsByWorkspace = new Map<string, dto.MirrorTargetList[]>();
  for (const list of listRows) listsByWorkspace.set(list.workspaceId, [...(listsByWorkspace.get(list.workspaceId) ?? []), { id: list.id, name: list.name }]);
  return { sources: orderedBoardRows.map((board) => ({ ...board, lists: listsByWorkspace.get(board.workspaceId) ?? [] })) };
}
