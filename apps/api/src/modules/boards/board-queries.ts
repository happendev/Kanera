import { featuresFromColumns, workspaceFeatureColumns } from "../../lib/workspace-features.js";
import type { BoardTransferTarget, CompletedCardsQuery, CompletedCardsResponse } from "@kanera/shared/dto";
import type { CompactCardSummary } from "@kanera/shared/events";
import { compactCardSummary } from "@kanera/shared/events";
import { boardMembers, boards, boardSeparators, cardKeyPrefixReservations, cardLabels, cardSummaryView, clientMembers, clients, lists, standaloneBoardGroups, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS } from "@kanera/shared/workspace-defaults";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assignedCardVisibility } from "../../lib/access.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { visibleBoardMirrorIds } from "../../lib/board-mirror/access.js";
import { loadBoardCardSummaries, toWireCardSummary } from "../../lib/card-summary.js";
import { loadChecklistTemplates } from "../../lib/checklist-templates.js";
import { decodeCompletedCardsCursor, encodeCompletedCardsCursor } from "../../lib/completed-card-pagination.js";
import { loadWorkspaceCustomFields } from "../../lib/custom-fields.js";
import { notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { escapedSearchPattern } from "../../lib/search-pattern.js";
import { hasBoardSyncEntitlement } from "../../lib/tier-limits.js";
import type { BoardAccessContext } from "./route-support.js";

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
  isOrganisationMember: boolean;
};

function completedCardSearchPredicate(query: string): SQL {
  const keyMatch = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]*)$/.exec(query.trim());
  const historicalKeyMatch = keyMatch
    ? sql`(${cardSummaryView.number} = ${Number(keyMatch[2])} and exists (
        select 1 from ${cardKeyPrefixReservations} completed_key_alias
        where completed_key_alias.workspace_id = ${cardSummaryView.workspaceId}
          and completed_key_alias.prefix = ${keyMatch[1]!.toUpperCase()}
      ))`
    : sql`false`;
  return sql`(
    lower(${cardSummaryView.title}) like ${escapedSearchPattern(query)} escape '\\'
    or lower(${cardSummaryView.key}) like ${escapedSearchPattern(query)} escape '\\'
    or ${historicalKeyMatch}
  )`;
}

export async function boardPayload(
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
  // Board and workspace context are needed together; one join avoids a serial round trip on
  // every open without changing the access check performed by the caller.
  const [context] = await db
    .select({
      board: boards,
      workspace: {
        clientId: workspaces.clientId,
        kind: workspaces.kind,
        completedCardsActiveDays: workspaces.completedCardsActiveDays,
        inactiveCardsDays: workspaces.inactiveCardsDays,
        inProgressAlertDays: workspaces.inProgressAlertDays,
        inProgressEnabled: clients.inProgressEnabled,
        timeZone: workspaces.timeZone,
        boardLinkingEnabled: workspaces.boardLinkingEnabled,
        notesEnabled: workspaces.notesEnabled,
        plan: clients.plan,
        billingStatus: clients.billingStatus,
      },
      featureColumns: workspaceFeatureColumns,
    })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(eq(boards.id, boardId))
    .limit(1);
  if (!context) throw notFound();
  const { board, workspace } = context;
  const features = featuresFromColumns(context.featureColumns);

  const [boardLists, boardCardSummaries, boardSeparatorsRows, boardCustomFields, boardMemberRows, boardLabels, checklistTemplates, participatingMirrors, workspaceCardKeyPrefixRows] = await Promise.all([
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
      projection: "board-open",
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
        orgRole: clientMembers.clientRole,
      })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .leftJoin(clientMembers, and(
        eq(clientMembers.clientId, workspace.clientId),
        eq(clientMembers.userId, boardMembers.userId),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
      ))
      .where(eq(boardMembers.boardId, boardId)),
    db
      .select()
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, board.workspaceId), isNull(cardLabels.archivedAt)))
      .orderBy(asc(cardLabels.position)),
    loadChecklistTemplates(board.workspaceId),
    // Board mirror details are only useful to editors and only when linking is enabled. Carrying
    // this cheap existence bit in the board-open payload lets the web client avoid a second
    // mirror-status request for the overwhelmingly common unlinked-board case.
    viewerRole === "observer" || !workspace.boardLinkingEnabled
      ? Promise.resolve([])
      : visibleBoardMirrorIds(boardId, clientId).then((ids) => ids.slice(0, 1).map((id) => ({ id }))),
    // A workspace normally has only a handful of permanent aliases. Shipping them once with the
    // board lets its local search resolve old keys without issuing a resolver request per keystroke.
    db
      .select({ prefix: cardKeyPrefixReservations.prefix })
      .from(cardKeyPrefixReservations)
      .where(eq(cardKeyPrefixReservations.workspaceId, board.workspaceId)),
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
    isOrganisationMember: m.orgRole !== null,
  }));
  // Card tiles only render custom-field badges for `showOnCard` fields, so the hot board-open
  // payload inlines just those values instead of every field value for every card. Filters,
  // Table columns, and export need the full set, which the client lazily loads from
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

  return { board, organisationInProgressEnabled: workspace.inProgressEnabled, features, workspaceClientId: workspace.clientId, workspaceKind: workspace.kind, workspaceInactiveCardsDays: workspace.inactiveCardsDays, workspaceInProgressAlertDays: workspace.inProgressAlertDays, workspaceTimeZone: workspace.timeZone, workspaceCardKeyPrefixes: workspaceCardKeyPrefixRows.map((row) => row.prefix), boardLinkingEnabled: workspace.boardLinkingEnabled, notesEnabled: workspace.notesEnabled, boardSyncAllowed: hasBoardSyncEntitlement(workspace.plan, workspace.billingStatus), hasMirrors: participatingMirrors.length > 0, lists: boardLists, ...(cardQuery.includeCards === false ? {} : { cards: cardSummaries, ...(cardQuery.limit === undefined ? {} : { cardPage: { offset: cardQuery.offset ?? 0, limit: cardQuery.limit, hasMore: hasMoreCards } }) }), separators: boardSeparatorsRows, customFields: boardCustomFields, cardLabels: boardLabels, checklistTemplates, members, viewerRole, viewerSource, viewerCanAccessWorkspace, viewerIsWorkspaceAdmin, viewerAssignedItemsOnly: Boolean(assignedUserId), customFieldValuesComplete };
}

export async function loadBoardTransferTargets({
  auth,
  boardId,
  sourceWorkspaceId,
  allowCrossWorkspace,
}: {
  auth: AuthClaims;
  boardId: string;
  sourceWorkspaceId: string;
  allowCrossWorkspace: boolean;
}): Promise<BoardTransferTarget[]> {
  const accessible = (await loadAccessibleBoards(auth)).filter((board) =>
    board.id !== boardId
    && board.viewerRole === "editor"
    && (allowCrossWorkspace || board.workspaceId === sourceWorkspaceId)
  );
  if (accessible.length === 0) return [];

  const boardRows = await db
    .select({
      board: boards,
      standaloneGroupTitle: standaloneBoardGroups.title,
    })
    .from(boards)
    .leftJoin(standaloneBoardGroups, eq(standaloneBoardGroups.id, boards.standaloneGroupId))
    .where(inArray(boards.id, accessible.map((board) => board.id)));
  const rowsById = new Map(boardRows.map((row) => [row.board.id, row]));

  // `loadAccessibleBoards` is the navigation-order source of truth. Map full board rows back onto
  // that ordered projection so clients retain the established Board response while gaining the
  // hierarchy labels needed by grouped pickers.
  return accessible.flatMap((target): BoardTransferTarget[] => {
    const row = rowsById.get(target.id);
    if (!row) return [];
    return [{
      ...row.board,
      organisationId: target.clientId,
      organisationName: target.clientName,
      organisationExternal: target.clientId !== auth.cid,
      workspaceName: target.workspaceName,
      workspaceIcon: target.workspaceIcon,
      workspaceAccentColor: target.workspaceAccentColor,
      workspaceKind: target.workspaceKind,
      standaloneGroupTitle: row.standaloneGroupTitle,
    }];
  });
}

export async function loadCompletedCards({
  auth,
  ctx,
  boardId,
  query,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  query: Omit<CompletedCardsQuery, "boardId">;
}): Promise<CompletedCardsResponse> {
  const cursor = decodeCompletedCardsCursor(query.cursor);

  const rows = await db
    .select()
    .from(cardSummaryView)
    .where(and(
      eq(cardSummaryView.boardId, boardId),
      ctx.assignedItemsOnly ? assignedCardVisibility(auth.sub, cardSummaryView.id) : undefined,
      isNotNull(cardSummaryView.completedAt),
      isNull(cardSummaryView.archivedAt),
      query.from ? gte(cardSummaryView.completedAt, new Date(query.from)) : undefined,
      query.to ? lte(cardSummaryView.completedAt, new Date(query.to)) : undefined,
      query.listId ? eq(cardSummaryView.listId, query.listId) : undefined,
      query.q ? completedCardSearchPredicate(query.q) : undefined,
      cursor
        ? or(
            lt(cardSummaryView.completedAt, cursor.completedAt),
            and(eq(cardSummaryView.completedAt, cursor.completedAt), gt(cardSummaryView.id, cursor.id)),
          )
        : undefined,
    ))
    .orderBy(desc(cardSummaryView.completedAt), asc(cardSummaryView.id))
    .limit(query.limit + 1);

  // The window the board hides completed cards after. Returned with every page so the panel can
  // state the rule without a second request; it is a single indexed lookup on one workspace row.
  const [workspace] = await db
    .select({ completedCardsActiveDays: workspaces.completedCardsActiveDays })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const page = rows.slice(0, query.limit);
  const nextCursor = rows.length > query.limit ? encodeCompletedCardsCursor(page.at(-1)!) : null;
  const response: CompletedCardsResponse = {
    cards: page.map((card) => toWireCardSummary(card, auth.cid)),
    nextCursor,
    completedCardsActiveDays: workspace?.completedCardsActiveDays ?? DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS,
  };
  return response;
}

export async function loadBoardMemberCandidates({ ctx }: { ctx: BoardAccessContext }) {
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
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      // Organisation owners/admins are inherited, pinned board users. Only ordinary members are
      // valid choices for an explicit standalone-board grant.
      .where(and(
        eq(clientMembers.clientId, ctx.clientId),
        eq(clientMembers.clientRole, "member"),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
        isNull(users.deletedAt),
      ))
      .orderBy(asc(clientMembers.addedAt));
    // A standalone board has no product-facing workspace roster. Its board permissions picker
    // therefore offers every active organisation member; the mutation route keeps any required
    // hidden membership as an implementation detail.
    return {
      scope: "organisation" as const,
      members: organisationMembers.map((member) => ({
        ...member,
        avatarUrl: withSignedMedia(member.clientId, { avatarUrl: member.avatarUrl }).avatarUrl,
      })),
    };
  }

  // The two rosters are independent; read them concurrently so opening the board members menu
  // waits on one round-trip here instead of two.
  const [explicitMembers, inheritedAdmins] = await Promise.all([
    db.select({
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
    .orderBy(asc(workspaceMembers.addedAt)),
    db.select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      lastOnlineAt: users.lastOnlineAt,
      clientId: users.clientId,
    })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .where(and(
      eq(clientMembers.clientId, ctx.clientId),
      inArray(clientMembers.clientRole, ["owner", "admin"]),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
    ))
    .orderBy(asc(clientMembers.addedAt)),
  ]);
  const explicitUserIds = new Set(explicitMembers.map((member) => member.userId));
  return {
    scope: "workspace" as const,
    members: [...explicitMembers, ...inheritedAdmins.filter((member) => !explicitUserIds.has(member.userId))]
      .map((member) => ({
        ...member,
        avatarUrl: withSignedMedia(member.clientId, { avatarUrl: member.avatarUrl }).avatarUrl,
      })),
  };
}

export async function listBoardMembers({ auth, boardId }: { auth: AuthClaims; boardId: string }) {
  const rows = await db
    .select({
      boardId: boardMembers.boardId,
      userId: boardMembers.userId,
      role: boardMembers.role,
      assignedItemsOnly: boardMembers.assignedItemsOnly,
      // Pinned rows inherit workspace or organisation authority; clients render them as fixed.
      pinned: boardMembers.pinned,
      addedAt: boardMembers.addedAt,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      lastOnlineAt: users.lastOnlineAt,
      clientId: users.clientId,
      orgRole: clientMembers.clientRole,
    })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .leftJoin(clientMembers, and(
      eq(clientMembers.clientId, auth.cid),
      eq(clientMembers.userId, boardMembers.userId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .where(eq(boardMembers.boardId, boardId))
    .orderBy(asc(boardMembers.addedAt));
  return rows.map((row) => ({
    ...row,
    role: row.orgRole === "owner" || row.orgRole === "admin" ? "editor" as const : row.role,
    pinned: row.pinned || row.orgRole === "owner" || row.orgRole === "admin",
    isOrganisationMember: row.orgRole !== null,
    avatarUrl: withSignedMedia(row.clientId, { avatarUrl: row.avatarUrl }).avatarUrl,
  }));
}
