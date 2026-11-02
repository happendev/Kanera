import { dto } from "@kanera/shared";
import type { SavedWorkView, WorkViewDefinition } from "@kanera/shared/dto";
import { boardMembers, cardLabels, clientMembers, customFields, lists, users, workViewShares, workViews } from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { applyWorkScope, loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";

type SavedViewSanitizationCatalog = {
  listIds: Set<string>;
  labelIds: Set<string>;
  fieldIds: Set<string>;
  numericFieldIds: Set<string>;
  members: Array<{ boardId: string; userId: string }>;
};

async function loadSavedViewSanitizationCatalog(
  accessibleBoards: AccessibleBoard[],
): Promise<SavedViewSanitizationCatalog> {
  const workspaceIds = [...new Set(accessibleBoards.map((board) => board.workspaceId))];
  const boardIds = accessibleBoards.map((board) => board.id);
  const [listRows, labelRows, fieldRows, members] = await Promise.all([
    workspaceIds.length
      ? db.select({ id: lists.id }).from(lists).where(inArray(lists.workspaceId, workspaceIds))
      : Promise.resolve([]),
    workspaceIds.length
      ? db.select({ id: cardLabels.id }).from(cardLabels).where(inArray(cardLabels.workspaceId, workspaceIds))
      : Promise.resolve([]),
    workspaceIds.length
      ? db.select({
          id: customFields.id,
          type: customFields.type,
          archivedAt: customFields.archivedAt,
        }).from(customFields).where(inArray(customFields.workspaceId, workspaceIds))
      : Promise.resolve([]),
    boardIds.length
      ? db.select({ boardId: boardMembers.boardId, userId: boardMembers.userId })
          .from(boardMembers)
          .where(inArray(boardMembers.boardId, boardIds))
      : Promise.resolve([]),
  ]);
  return {
    listIds: new Set(listRows.map((row) => row.id)),
    labelIds: new Set(labelRows.map((row) => row.id)),
    fieldIds: new Set(fieldRows.filter((row) => !row.archivedAt).map((row) => row.id)),
    numericFieldIds: new Set(fieldRows.filter((row) => row.type === "number" && !row.archivedAt).map((row) => row.id)),
    members,
  };
}

function sanitizedDefinition(
  definition: WorkViewDefinition,
  accessibleBoards: AccessibleBoard[],
  viewerUserId: string,
  catalog: SavedViewSanitizationCatalog,
): WorkViewDefinition {
  const accessibleBoardIds = new Set(accessibleBoards.map((board) => board.id));
  const accessibleWorkspaceIds = new Set(accessibleBoards.map((board) => board.workspaceId));
  const accessibleOrganisationIds = new Set(accessibleBoards.map((board) => board.clientId));
  const selectedBoardIds = applyWorkScope(accessibleBoards, definition.scope).map((board) => board.id);
  const selectedBoardIdSet = new Set(selectedBoardIds);
  const { listIds, labelIds, fieldIds, numericFieldIds } = catalog;
  const visibleAssigneeIds = new Set(
    catalog.members.filter((row) => selectedBoardIdSet.has(row.boardId)).map((row) => row.userId),
  );
  visibleAssigneeIds.add(viewerUserId);
  const validCollapsedSectionIds = (() => {
    switch (definition.groupBy) {
      case "organisation": return accessibleOrganisationIds;
      case "workspace": return accessibleWorkspaceIds;
      case "board": return accessibleBoardIds;
      case "assignee": return new Set([...visibleAssigneeIds, "unassigned"]);
      case "list": return listIds;
      case "completion": return new Set(["active", "completed"]);
      case "dueDate": return new Set(["0-overdue", "1-today", "2-upcoming", "3-later", "5-undated"]);
      case "none": return new Set(["all"]);
    }
  })();
  const builtinTableColumns = new Set([
    "status", "board", "assignees", "due", "labels", "checklist", "description", "created", "updated",
  ]);
  const validTableColumn = (id: string) =>
    builtinTableColumns.has(id) || (id.startsWith("cf:") && fieldIds.has(id.slice(3)));
  const tableSplit = definition.table.aggregateSplitBy;
  const validTableSplit = !tableSplit.startsWith("cf:") || fieldIds.has(tableSplit.slice(3));
  const validCollapsedTableGroupKeys = (() => {
    switch (definition.groupBy) {
      case "organisation": return new Set([...accessibleOrganisationIds, "__none__"].map((id) => `organisation:${id}`));
      case "workspace": return new Set([...accessibleWorkspaceIds, "__none__"].map((id) => `workspace:${id}`));
      case "board": return new Set([...accessibleBoardIds, "__none__"].map((id) => `board:${id}`));
      case "assignee": return new Set([...visibleAssigneeIds, "__none__"].map((id) => `assignee:${id}`));
      case "list": return new Set([...listIds].map((id) => `list:${id}`));
      case "dueDate": return new Set(["overdue", "today", "tomorrow", "thisWeek", "later", "noDate"].map((id) => `due:${id}`));
      case "completion": return new Set(["completion:open", "completion:done"]);
      case "none": return new Set(["all"]);
    }
  })();
  return dto.workViewDefinitionSchema.parse({
    ...definition,
    scope: {
      ...definition.scope,
      organisationIds: definition.scope.organisationIds.filter((id) => accessibleOrganisationIds.has(id)),
      workspaceIds: definition.scope.workspaceIds.filter((id) => accessibleWorkspaceIds.has(id)),
      boardIds: definition.scope.boardIds.filter((id) => accessibleBoardIds.has(id)),
    },
    filters: {
      ...definition.filters,
      assigneeIds: definition.filters.assigneeIds.filter((id) => visibleAssigneeIds.has(id)),
      listIds: definition.filters.listIds.filter((id) => listIds.has(id)),
      labelIds: definition.filters.labelIds.filter((id) => labelIds.has(id)),
      customFieldConditions: definition.filters.customFieldConditions.filter((condition) =>
        accessibleWorkspaceIds.has(condition.workspaceId) && fieldIds.has(condition.fieldId)
      ),
    },
    table: {
      ...definition.table,
      columnVisibility: Object.fromEntries(
        Object.entries(definition.table.columnVisibility).filter(([id]) => validTableColumn(id)),
      ),
      columnOrder: definition.table.columnOrder.filter(validTableColumn),
      columnWidths: Object.fromEntries(
        Object.entries(definition.table.columnWidths).filter(([id]) => id === "title" || validTableColumn(id)),
      ),
      aggregates: Object.fromEntries(
        Object.entries(definition.table.aggregates).filter(([fieldId]) => fieldId === "inProgress" || numericFieldIds.has(fieldId)),
      ),
      aggregateSplitBy: validTableSplit ? tableSplit : "none",
      collapsedGroupKeys: definition.table.collapsedGroupKeys.filter((key) => validCollapsedTableGroupKeys.has(key)),
    },
    collapsedWorkspaceIds: definition.collapsedWorkspaceIds.filter((id) => accessibleWorkspaceIds.has(id)),
    collapsedSectionIds: definition.collapsedSectionIds.filter((id) => validCollapsedSectionIds.has(id)),
  });
}

export async function shapeSavedViews(rows: Array<typeof workViews.$inferSelect & { ownerName: string }>, userId: string, accessibleBoards: AccessibleBoard[]): Promise<SavedWorkView[]> {
  if (rows.length === 0) return [];
  // Sanitization metadata is invariant across the returned views. Load it once instead of issuing
  // four catalog statements per saved view as the list grows.
  const [shareRows, catalog] = await Promise.all([
    db.select().from(workViewShares).where(inArray(workViewShares.viewId, rows.map((row) => row.id))),
    loadSavedViewSanitizationCatalog(accessibleBoards),
  ]);
  const sharesByView = new Map<string, string[]>();
  for (const share of shareRows) {
    const ids = sharesByView.get(share.viewId) ?? [];
    ids.push(share.userId);
    sharesByView.set(share.viewId, ids);
  }
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    name: row.name,
    lens: row.lens,
    visibility: row.visibility,
    definitionVersion: row.definitionVersion,
    definition: sanitizedDefinition(dto.workViewDefinitionSchema.parse(row.definition), accessibleBoards, userId, catalog),
    editable: row.ownerId === userId,
    sharedUserIds: sharesByView.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

async function accessibleSavedViewRows(userId: string, clientId: string) {
  return db
    .selectDistinct({
      id: workViews.id,
      clientId: workViews.clientId,
      ownerId: workViews.ownerId,
      name: workViews.name,
      lens: workViews.lens,
      visibility: workViews.visibility,
      definitionVersion: workViews.definitionVersion,
      definition: workViews.definition,
      createdAt: workViews.createdAt,
      updatedAt: workViews.updatedAt,
      ownerName: users.displayName,
    })
    .from(workViews)
    .innerJoin(users, eq(users.id, workViews.ownerId))
    .leftJoin(workViewShares, and(eq(workViewShares.viewId, workViews.id), eq(workViewShares.userId, userId)))
    .where(and(
      eq(workViews.clientId, clientId),
      or(
        eq(workViews.ownerId, userId),
        eq(workViews.visibility, "organisation"),
        isNotNull(workViewShares.userId),
      ),
    ))
    .orderBy(desc(workViews.updatedAt));
}

/** Every saved view the viewer may open in their active organisation, shaped for the client. */
export async function loadSavedViews(auth: AuthClaims): Promise<SavedWorkView[]> {
  const [rows, accessibleBoards] = await Promise.all([
    accessibleSavedViewRows(auth.sub, auth.cid),
    loadAccessibleBoards(auth),
  ]);
  return shapeSavedViews(rows, auth.sub, accessibleBoards);
}

/** `GET /work-views/share-candidates`: the active members of the viewer's organisation. */
export async function loadShareCandidates(clientId: string) {
  const rows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      homeClientId: users.clientId,
    })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .where(and(
      eq(clientMembers.clientId, clientId),
      isNull(clientMembers.removedAt),
      isNull(clientMembers.suspendedAt),
      isNull(users.deletedAt),
    ))
    .orderBy(asc(users.displayName), asc(users.id));

  // Sharing is organisation-scoped rather than board-scoped. Keep this roster separate from
  // the work catalog so board-visible people and assignment candidates cannot be conflated.
  return rows.map(({ homeClientId, ...user }) => ({
    ...user,
    avatarUrl: signedAvatarUrl(homeClientId, user.avatarUrl),
  }));
}
