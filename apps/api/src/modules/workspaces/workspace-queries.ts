import type { AgentDirectoryQuery } from "@kanera/shared/dto";
import { boardInvitationGrants, boardInvitations, boardMembers, boards, cardLabels, clientGuestSeats, clientMembers, clients, lists, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { isOrgAdmin, orgRoleRanksAdmin, type assertWorkspaceAccess } from "../../lib/access.js";
import { effectiveMcpPolicy } from "../../lib/mcp-policy.js";
import { loadAutomations } from "../../lib/automations.js";
import { loadChecklistTemplates } from "../../lib/checklist-templates.js";
import { loadWorkspaceCustomFields } from "../../lib/custom-fields.js";
import { notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { getAutomationExecutionsRemaining } from "../../lib/tier-limits.js";
import { toWireWorkspace } from "./route-support.js";

type WorkspaceRole = Awaited<ReturnType<typeof assertWorkspaceAccess>>["role"];

export async function listWorkspaces({ auth, directory }: { auth: AuthClaims; directory: AgentDirectoryQuery }) {
  const page = <T>(rows: T[]) => directory.limit === undefined
    ? rows
    : rows.slice(directory.offset, directory.offset + directory.limit);
  // Personal credentials are not pinned to a workspace: list every workspace the owner can reach
  // across every active organisation and expose the effective role in each one.
  if (auth.apiKeyKind === "personal") {
    const rows = await db
      .select({
        id: workspaces.id,
        clientId: workspaces.clientId,
        name: workspaces.name,
        cardKeyPrefix: workspaces.cardKeyPrefix,
        kind: workspaces.kind,
        icon: workspaces.icon,
        accentColor: workspaces.accentColor,
        completedCardsActiveDays: workspaces.completedCardsActiveDays,
        inactiveCardsDays: workspaces.inactiveCardsDays,
        inProgressAlertDays: workspaces.inProgressAlertDays,
        timeZone: workspaces.timeZone,
        boardLinkingEnabled: workspaces.boardLinkingEnabled,
        notesEnabled: workspaces.notesEnabled,
        dependenciesEnabled: workspaces.dependenciesEnabled,
        timelineEnabled: workspaces.timelineEnabled,
        inProgressEnabled: workspaces.inProgressEnabled,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        clientRole: clientMembers.clientRole,
        workspaceRole: workspaceMembers.role,
        mcpPolicy: clients.mcpPolicy,
      })
      .from(workspaces)
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .innerJoin(clientMembers, and(
        eq(clientMembers.clientId, workspaces.clientId),
        eq(clientMembers.userId, auth.sub),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
      ))
      .leftJoin(workspaceMembers, and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, auth.sub),
      ))
      .where(and(
        ne(workspaces.kind, "board"),
        isNull(workspaces.archivedAt),
        isNull(clients.suspendedAt),
        isNull(clients.deletedAt),
        or(inArray(clientMembers.clientRole, ["owner", "admin"]), isNotNull(workspaceMembers.userId)),
      ))
      .orderBy(asc(workspaces.createdAt));
    // Personal credentials work on every plan, so Free organisations' workspaces are listed too.
    // Organisations whose MCP policy is off are hidden from agent credentials altogether.
    return page(rows
      .filter((row) => effectiveMcpPolicy(row.mcpPolicy) !== "off")
      .map(({ clientRole, workspaceRole, mcpPolicy: _mcpPolicy, ...workspace }) => ({
        ...workspace,
        role: orgRoleRanksAdmin(clientRole) ? "admin" as const : workspaceRole!,
      })));
  }

  if (auth.authKind === "apiKey") {
    const workspaceId = auth.apiKeyWorkspaceId!;
    return page(await db
      .select({
        id: workspaces.id,
        clientId: workspaces.clientId,
        name: workspaces.name,
        cardKeyPrefix: workspaces.cardKeyPrefix,
        kind: workspaces.kind,
        icon: workspaces.icon,
        accentColor: workspaces.accentColor,
        completedCardsActiveDays: workspaces.completedCardsActiveDays,
        inactiveCardsDays: workspaces.inactiveCardsDays,
        inProgressAlertDays: workspaces.inProgressAlertDays,
        timeZone: workspaces.timeZone,
        boardLinkingEnabled: workspaces.boardLinkingEnabled,
        notesEnabled: workspaces.notesEnabled,
        dependenciesEnabled: workspaces.dependenciesEnabled,
        timelineEnabled: workspaces.timelineEnabled,
        inProgressEnabled: workspaces.inProgressEnabled,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        role: sql<"admin" | "member">`${auth.apiKeyScope === "admin" ? "admin" : "member"}::text`.as("role"),
      })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.clientId, auth.cid), isNull(workspaces.archivedAt))));
  }

  if (isOrgAdmin(auth)) {
    return page(await db
      .select({
        id: workspaces.id,
        clientId: workspaces.clientId,
        name: workspaces.name,
        cardKeyPrefix: workspaces.cardKeyPrefix,
        kind: workspaces.kind,
        icon: workspaces.icon,
        accentColor: workspaces.accentColor,
        completedCardsActiveDays: workspaces.completedCardsActiveDays,
        inactiveCardsDays: workspaces.inactiveCardsDays,
        inProgressAlertDays: workspaces.inProgressAlertDays,
        timeZone: workspaces.timeZone,
        boardLinkingEnabled: workspaces.boardLinkingEnabled,
        notesEnabled: workspaces.notesEnabled,
        dependenciesEnabled: workspaces.dependenciesEnabled,
        timelineEnabled: workspaces.timelineEnabled,
        inProgressEnabled: workspaces.inProgressEnabled,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        role: sql<"admin">`'admin'::text`.as("role"),
      })
      .from(workspaces)
      // Archived workspaces (e.g. downgrade-archived) are hidden from listings.
      .where(and(eq(workspaces.clientId, auth.cid), ne(workspaces.kind, "board"), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.createdAt)));
  }
  const rows = await db
    .select({
      id: workspaces.id,
      clientId: workspaces.clientId,
      name: workspaces.name,
      cardKeyPrefix: workspaces.cardKeyPrefix,
      kind: workspaces.kind,
      icon: workspaces.icon,
      accentColor: workspaces.accentColor,
      completedCardsActiveDays: workspaces.completedCardsActiveDays,
      inactiveCardsDays: workspaces.inactiveCardsDays,
      inProgressAlertDays: workspaces.inProgressAlertDays,
      timeZone: workspaces.timeZone,
      boardLinkingEnabled: workspaces.boardLinkingEnabled,
      notesEnabled: workspaces.notesEnabled,
      dependenciesEnabled: workspaces.dependenciesEnabled,
      timelineEnabled: workspaces.timelineEnabled,
      inProgressEnabled: workspaces.inProgressEnabled,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    // Archived workspaces (e.g. downgrade-archived) are hidden from listings. Membership rows
    // span every organisation the identity has joined, so scope to the active organisation —
    // workspaces in other organisations belong behind the organisation switcher.
    .where(and(
      eq(workspaceMembers.userId, auth.sub),
      eq(workspaces.clientId, auth.cid),
      ne(workspaces.kind, "board"),
      isNull(workspaces.archivedAt),
    ))
    .orderBy(asc(workspaces.createdAt));
  return page(rows);
}

export async function loadWorkspaceSettings({ auth, workspaceId: id, role }: { auth: AuthClaims; workspaceId: string; role: WorkspaceRole }) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (!workspace) throw notFound();
  // Keep each settings stage small: helper loaders also fetch child rows, and launching
  // every projection together makes one settings request occupy many connections at once.
  const [workspaceLists, workspaceLabels, [organisation]] = await Promise.all([
    db.select().from(lists).where(and(eq(lists.workspaceId, id), isNull(lists.archivedAt))).orderBy(asc(lists.position)),
    db.select().from(cardLabels).where(eq(cardLabels.workspaceId, id)).orderBy(asc(cardLabels.position)),
    db.select({ inProgressEnabled: clients.inProgressEnabled, dependenciesEnabled: clients.dependenciesEnabled, timelineEnabled: clients.timelineEnabled }).from(clients).where(eq(clients.id, workspace.clientId)),
  ]);
  const [workspaceFields, checklistTemplates, automations] = await Promise.all([
    loadWorkspaceCustomFields(id),
    loadChecklistTemplates(id),
    loadAutomations(id),
  ]);
  // Workspace settings is available to workspace admins as well as organisation admins. Return
  // the small organisation-wide usage value here so that surface does not load the much heavier
  // home agenda endpoint merely to decide whether its allowance callout should be shown.
  const automationExecutionsRemaining = role === "admin" ? await getAutomationExecutionsRemaining(auth.cid) : null;
  // Settings show a workspace switch as off and locked while its organisation has the feature off.
  const organisationFeatures = { dependencies: organisation!.dependenciesEnabled, timeline: organisation!.timelineEnabled, inProgress: organisation!.inProgressEnabled };
  return { organisationInProgressEnabled: organisation!.inProgressEnabled, organisationFeatures, workspace: toWireWorkspace(workspace), role, lists: workspaceLists, customFields: workspaceFields, cardLabels: workspaceLabels, checklistTemplates, automations, automationExecutionsRemaining };
}

export async function listWorkspaceMembers({ workspaceId: id, clientId, directory }: { workspaceId: string; clientId: string; directory: AgentDirectoryQuery }) {
  // Both rosters are independent; deduplicate only once both have arrived.
  const [rows, inheritedAdmins] = await Promise.all([
    db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        addedAt: workspaceMembers.addedAt,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
        lastOnlineAt: users.lastOnlineAt,
        orgRole: clientMembers.clientRole,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .innerJoin(clientMembers, and(
        eq(clientMembers.clientId, clientId),
        eq(clientMembers.userId, workspaceMembers.userId),
      ))
      .where(and(
        eq(workspaceMembers.workspaceId, id),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
        isNull(users.deletedAt),
      ))
      .orderBy(asc(workspaceMembers.addedAt)),
    db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
        lastOnlineAt: users.lastOnlineAt,
        orgRole: clientMembers.clientRole,
        addedAt: clientMembers.addedAt,
      })
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      .where(and(
        eq(clientMembers.clientId, clientId),
        inArray(clientMembers.clientRole, ["owner", "admin"]),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
        isNull(users.deletedAt),
      )),
  ]);
  const explicitUserIds = new Set(rows.map((row) => row.userId));
  const effectiveRows = [
    ...rows,
    ...inheritedAdmins
      .filter((user) => !explicitUserIds.has(user.userId))
      .map((user) => ({ ...user, workspaceId: id, role: "admin" as const })),
  ];
  const wireRows = effectiveRows.map(({ homeClientId, ...row }) => withSignedMedia(homeClientId, {
    ...row,
    // Organisation owners/admins inherit workspace-admin authority and cannot be downgraded
    // inside an individual workspace, regardless of the historical workspace row value.
    role: row.orgRole === "owner" || row.orgRole === "admin" ? "admin" as const : row.role,
  }));
  return directory.limit === undefined
    ? wireRows
    : wireRows.slice(directory.offset, directory.offset + directory.limit);
}

export async function listWorkspaceMemberCandidates({ clientId }: { clientId: string }) {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    // Organisation owners/admins already inherit this workspace and are shown in its roster;
    // only ordinary organisation members can be explicitly added through this picker.
    .where(and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.clientRole, "member"),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
    ))
    .orderBy(asc(clientMembers.addedAt));
}

export async function listWorkspaceGuests({ workspaceId: id, clientId }: { workspaceId: string; clientId: string }) {
  const [workspaceBoards, acceptedGuests, pendingInvites] = await Promise.all([
    db
      .select({
        id: boards.id,
        name: boards.name,
        icon: boards.icon,
        iconColor: boards.iconColor,
        position: boards.position,
      })
      .from(boards)
      .where(and(eq(boards.workspaceId, id), isNull(boards.archivedAt)))
      .orderBy(asc(boards.position)),
    db
      .select({
        boardId: boardMembers.boardId,
        boardName: boards.name,
        userId: boardMembers.userId,
        role: boardMembers.role,
        assignedItemsOnly: boardMembers.assignedItemsOnly,
        addedAt: boardMembers.addedAt,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
        lastOnlineAt: users.lastOnlineAt,
        clientId: users.clientId,
        paidGuestSeat: isNotNull(clientGuestSeats.userId),
      })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .leftJoin(clientGuestSeats, and(eq(clientGuestSeats.clientId, clientId), eq(clientGuestSeats.userId, boardMembers.userId)))
      .where(and(
        eq(boards.workspaceId, id),
        isNull(boards.archivedAt),
        notExists(db.select({ userId: clientMembers.userId }).from(clientMembers).where(and(
          eq(clientMembers.clientId, clientId),
          eq(clientMembers.userId, users.id),
        ))),
      ))
      .orderBy(asc(boards.position), asc(users.displayName)),
    db
      .select({
        id: boardInvitations.id,
        boardId: boardInvitationGrants.boardId,
        boardName: boards.name,
        email: boardInvitations.email,
        role: boardInvitationGrants.role,
        assignedItemsOnly: boardInvitationGrants.assignedItemsOnly,
        expiresAt: boardInvitations.expiresAt,
        createdAt: boardInvitations.createdAt,
      })
      .from(boardInvitations)
      .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
      .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
      .where(
        and(
          eq(boards.workspaceId, id),
          isNull(boards.archivedAt),
          isNull(boardInvitations.revokedAt),
          isNull(boardInvitations.acceptedAt),
          sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
        ),
      )
      .orderBy(asc(boards.position), asc(boardInvitations.createdAt)),
  ]);

  const pendingByInvite = new Map<string, typeof pendingInvites[number] & { boards: Array<{ boardId: string; boardName: string; role: string; assignedItemsOnly: boolean }> }>();
  for (const invite of pendingInvites) {
    const current = pendingByInvite.get(invite.id);
    if (current) {
      current.boards.push({ boardId: invite.boardId, boardName: invite.boardName, role: invite.role, assignedItemsOnly: invite.assignedItemsOnly });
    } else {
      pendingByInvite.set(invite.id, {
        ...invite,
        boards: [{ boardId: invite.boardId, boardName: invite.boardName, role: invite.role, assignedItemsOnly: invite.assignedItemsOnly }],
      });
    }
  }

  return {
    boards: workspaceBoards,
    acceptedGuests: acceptedGuests.map((guest) => ({
      ...guest,
      avatarUrl: withSignedMedia(guest.clientId, { avatarUrl: guest.avatarUrl }).avatarUrl,
    })),
    pendingInvites: [...pendingByInvite.values()],
  };
}
