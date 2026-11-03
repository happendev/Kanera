import type { PendingBoardInvitationSummary } from "@kanera/shared/dto";
import { DUE_DATE_SLOT_RANK, type CardDueDateSlot } from "@kanera/shared/due-date-slots";
import { boardGroups, boardInvitationGrants, boardInvitations, boardMembers, boards, cardAssignees, cards, clientMembers, clients, planActions, standaloneBoardGroups, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertWorkspaceAccess, isOrgAdmin } from "../../lib/access.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { loadAssignedChecklistItems } from "../../lib/assigned-checklist-items.js";
import { addDays, isDueDateOverdue, localDateInTimezone } from "../../lib/due-date.js";
import { notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { toWireWorkspace } from "./route-support.js";

export async function loadHomeBoardDirectory({ auth }: { auth: AuthClaims }) {
  if (auth.authKind === "apiKey" && auth.apiKeyKind !== "personal") {
    const workspaceId = auth.apiKeyWorkspaceId!;
    await assertWorkspaceAccess(auth, workspaceId);
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!workspace) throw notFound("workspace not found");
    const workspaceBoards = await db
      .select()
      .from(boards)
      .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)))
      .orderBy(asc(boards.position));
    const workspaceBoardGroups = await db
      .select()
      .from(boardGroups)
      .where(eq(boardGroups.workspaceId, workspaceId))
      .orderBy(asc(boardGroups.position));
    const members = await db
      .select({
        userId: workspaceMembers.userId,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
        lastOnlineAt: users.lastOnlineAt,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    return {
      groups: [{
        workspace: {
          ...toWireWorkspace(workspace),
          role: auth.apiKeyScope === "admin" ? "admin" : "member",
        },
        boardGroups: workspaceBoardGroups,
        boards: workspaceBoards.map((board) => ({
          ...board,
          // Workspace API keys do not use the web capture UI, but keeping the home contract
          // complete makes permission-aware consumers behave consistently.
          viewerRole: auth.apiKeyScope === "read" ? "observer" as const : "editor" as const,
          myCards: 0,
          myOverdue: 0,
        })),
        members: members.map(({ homeClientId, ...member }) => withSignedMedia(homeClientId, member)),
      }],
      standaloneBoardGroups: workspace.kind === "board" && workspaceBoards[0]?.standaloneGroupId
        ? await db.select().from(standaloneBoardGroups).where(eq(standaloneBoardGroups.id, workspaceBoards[0].standaloneGroupId))
        : [],
      dueSoon: [],
      pendingBoardInvitations: [],
    };
  }

  const orgAdmin = isOrgAdmin(auth);
  const credentialReadOnly = auth.authKind === "apiKey" && auth.apiKeyScope === "read";
  const userId = auth.sub;
  // A downgrade archive remains an access boundary, but it is not a user archive. Keep those
  // boards in the navigation directory with an explicit disabled marker so retained data never
  // appears to have vanished. Ordinary archived boards have no plan_action and remain hidden.
  const disabledByPlan = sql<boolean>`exists (
    select 1
    from ${planActions}
    where ${planActions.clientId} = ${workspaces.clientId}
      and ${planActions.kind} = 'board_archived'
      and (${planActions.payload}->>'boardId')::uuid = ${boards.id}
  )`;
  const navigableOrPlanDisabled = or(isNull(boards.archivedAt), disabledByPlan);
  type BoardWithStats = {
    id: string;
    workspaceId: string;
    name: string;
    icon: string | null;
    iconColor: string | null;
    backgroundGradient: string | null;
    groupId: string | null;
    standaloneGroupId: string | null;
    position: string;
    viewerRole: "editor" | "observer";
    disabledByPlan: boolean;
    myCards: number;
    myOverdue: number;
  };
  type Member = { userId: string; displayName: string; avatarUrl: string | null; lastOnlineAt: Date | null; role: "admin" | "member" };
  type BoardGroup = { id: string; workspaceId: string; title: string; position: string; createdAt: Date; updatedAt: Date };
  type HomeGroup = { workspace: unknown; boardGroups: BoardGroup[]; boards: BoardWithStats[]; members: Member[] };
  type GuestHomeGroup = {
    workspace: unknown;
    clientName: string;
    boardGroups: BoardGroup[];
    boards: BoardWithStats[];
  };

  async function loadOrganisationGroups() {
    const rows = orgAdmin
      ? await db
        .select({
          workspace: workspaces,
          role: sql<"admin">`'admin'::text`.as("role"),
          board: boards,
          explicitMemberId: sql<string | null>`null::uuid`.as("explicit_member_id"),
          explicitBoardRole: sql<"editor" | "observer" | null>`null::text`.as("explicit_board_role"),
        })
        .from(workspaces)
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .leftJoin(boards, and(eq(boards.workspaceId, workspaces.id), navigableOrPlanDisabled))
        .where(and(
          eq(workspaces.clientId, auth.cid),
          isNull(clients.suspendedAt),
          isNull(clients.deletedAt),
        ))
        .orderBy(asc(workspaces.createdAt), asc(boards.position))
      : await db
        .select({
          workspace: workspaces,
          role: workspaceMembers.role,
          board: boards,
          explicitMemberId: boardMembers.userId,
          explicitBoardRole: boardMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .leftJoin(boards, and(eq(boards.workspaceId, workspaces.id), navigableOrPlanDisabled))
        .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, userId)))
        .where(and(
          eq(workspaceMembers.userId, userId),
          // Membership rows span every organisation the identity has joined. The home directory
          // must stay scoped to the active organisation like the admin branch above: leaking
          // another organisation's workspace here makes the shell prefetch it, hit WRONG_ORG, and
          // auto-switch the user out of the organisation they just selected.
          eq(workspaces.clientId, auth.cid),
          isNull(clients.suspendedAt),
          isNull(clients.deletedAt),
        ))
        .orderBy(asc(workspaces.createdAt), asc(boards.position));

    const grouped = new Map<string, HomeGroup>();
    const boardIds: string[] = [];
    for (const row of rows) {
      const workspace = { ...toWireWorkspace(row.workspace), role: row.role };
      if (!grouped.has(row.workspace.id)) grouped.set(row.workspace.id, { workspace, boardGroups: [], boards: [], members: [] });
      // Board membership is the access model: a workspace member sees a board on their home/sidebar
      // only if they hold an explicit board_member row (org admins see every board implicitly).
      if (row.board && (orgAdmin || row.explicitMemberId)) {
        const boardDisabledByPlan = row.board.archivedAt !== null;
        grouped.get(row.workspace.id)!.boards.push({
          id: row.board.id,
          workspaceId: row.board.workspaceId,
          name: row.board.name,
          icon: row.board.icon,
          iconColor: row.board.iconColor,
          backgroundGradient: row.board.backgroundGradient,
          groupId: row.board.groupId,
          standaloneGroupId: row.board.standaloneGroupId,
          position: row.board.position,
          // Card creation is board-scoped. Expose the effective role so capture and other clients
          // never advertise a write destination that the mutation endpoint will reject.
          viewerRole: credentialReadOnly ? "observer" : orgAdmin ? "editor" : row.explicitBoardRole!,
          disabledByPlan: boardDisabledByPlan,
          myCards: 0,
          myOverdue: 0,
        });
        // Disabled boards are directory-only: do not populate attention stats or any content
        // projection until an upgrade restores them.
        if (!boardDisabledByPlan) boardIds.push(row.board.id);
      }
    }

    const workspaceIds = [...grouped.keys()];

    if (workspaceIds.length > 0) {
      const [boardGroupRows, memberRows, statsRows] = await Promise.all([
        db
          .select()
          .from(boardGroups)
          .where(inArray(boardGroups.workspaceId, workspaceIds))
          .orderBy(asc(boardGroups.position)),

        db
          .select({
            workspaceId: workspaceMembers.workspaceId,
            userId: workspaceMembers.userId,
            role: workspaceMembers.role,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            homeClientId: users.clientId,
            lastOnlineAt: users.lastOnlineAt,
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(inArray(workspaceMembers.workspaceId, workspaceIds))
          .orderBy(asc(users.displayName)),

        // Per-board stats: cards assigned to current user and overdue.
        boardIds.length > 0
          ? db
            .select({
              boardId: cards.boardId,
              completedAt: cards.completedAt,
              dueDateLocalDate: cards.dueDateLocalDate,
              dueDateSlot: cards.dueDateSlot,
              dueDateTimezone: cards.dueDateTimezone,
            })
            .from(cardAssignees)
            .innerJoin(cards, and(eq(cards.id, cardAssignees.cardId), isNull(cards.archivedAt)))
            .where(and(eq(cardAssignees.userId, userId), inArray(cards.boardId, boardIds)))
          : Promise.resolve([]),
      ]);

      for (const row of boardGroupRows) {
        grouped.get(row.workspaceId)?.boardGroups.push(row);
      }

      for (const row of memberRows) {
        const group = grouped.get(row.workspaceId);
        if (!group) continue;
        const shaped = withSignedMedia(row.homeClientId, {
          userId: row.userId,
          displayName: row.displayName,
          avatarUrl: row.avatarUrl,
          lastOnlineAt: row.lastOnlineAt,
          role: row.role,
        });
        group.members.push(shaped);
      }

      const statsMap = new Map<string, { myCards: number; myOverdue: number }>();
      for (const row of statsRows) {
        const stats = statsMap.get(row.boardId) ?? { myCards: 0, myOverdue: 0 };
        stats.myCards += 1;
        if (!row.completedAt && isDueDateOverdue(row)) stats.myOverdue += 1;
        statsMap.set(row.boardId, stats);
      }
      for (const group of grouped.values()) {
        for (const board of group.boards) {
          const stats = statsMap.get(board.id);
          if (stats) {
            board.myCards = stats.myCards;
            board.myOverdue = stats.myOverdue;
          }
        }
      }
    }

    return [...grouped.values()];
  }

  async function loadGuestGroups() {
    // Guest boards are explicit board grants in organisations the identity has not joined. Full
    // memberships in other organisations belong behind the organisation switcher; presenting
    // their board rows here would leak one organisation's navigation into another as "guest" work.
    const guestGrouped = new Map<string, GuestHomeGroup>();
    const guestBoardIds: string[] = [];

    {
      const guestRows = await db
        .select({
          workspace: workspaces,
          clientName: clients.name,
          board: boards,
          boardRole: boardMembers.role,
        })
        .from(boardMembers)
        .innerJoin(boards, and(eq(boards.id, boardMembers.boardId), isNull(boards.archivedAt)))
        .innerJoin(
          workspaces,
          and(eq(workspaces.id, boards.workspaceId), ne(workspaces.clientId, auth.cid)),
        )
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .leftJoin(clientMembers, and(
          eq(clientMembers.clientId, workspaces.clientId),
          eq(clientMembers.userId, userId),
        ))
        // Retained suspended/removed memberships also block the guest fallback, matching the
        // canonical accessible-board resolver and preventing revoked organisation access from
        // reappearing through an old board_members row. Permanent organisation deletion removes
        // membership before its background graph purge, so the host row must remain an explicit
        // access boundary during that window rather than making the old grant look like a guest.
        .where(and(
          eq(boardMembers.userId, userId),
          isNull(clientMembers.userId),
          isNull(clients.suspendedAt),
          isNull(clients.deletedAt),
        ))
        .orderBy(asc(workspaces.createdAt), asc(boards.position));

      for (const row of guestRows) {
        const workspace = { ...toWireWorkspace(row.workspace), role: row.boardRole };
        if (!guestGrouped.has(row.workspace.id)) {
          guestGrouped.set(row.workspace.id, {
            workspace,
            clientName: row.clientName,
            boardGroups: [],
            boards: [],
          });
        }
        guestGrouped.get(row.workspace.id)!.boards.push({
          id: row.board.id,
          workspaceId: row.board.workspaceId,
          name: row.board.name,
          icon: row.board.icon,
          iconColor: row.board.iconColor,
          backgroundGradient: row.board.backgroundGradient,
          groupId: row.board.groupId,
          standaloneGroupId: row.board.standaloneGroupId,
          position: row.board.position,
          viewerRole: credentialReadOnly ? "observer" : row.boardRole,
          disabledByPlan: false,
          myCards: 0,
          myOverdue: 0,
        });
        guestBoardIds.push(row.board.id);
      }

      if (guestBoardIds.length > 0) {
        const guestWorkspaceIds = [...guestGrouped.keys()];
        const [guestBoardGroupRows, guestStatsRows] = await Promise.all([
          db
            .select()
            .from(boardGroups)
            .where(inArray(boardGroups.workspaceId, guestWorkspaceIds))
            .orderBy(asc(boardGroups.position)),
          db
            .select({
              boardId: cards.boardId,
              completedAt: cards.completedAt,
              dueDateLocalDate: cards.dueDateLocalDate,
              dueDateSlot: cards.dueDateSlot,
              dueDateTimezone: cards.dueDateTimezone,
            })
            .from(cardAssignees)
            .innerJoin(cards, and(eq(cards.id, cardAssignees.cardId), isNull(cards.archivedAt)))
            .where(and(eq(cardAssignees.userId, userId), inArray(cards.boardId, guestBoardIds))),
        ]);

        for (const row of guestBoardGroupRows) {
          guestGrouped.get(row.workspaceId)?.boardGroups.push(row);
        }

        const guestStatsMap = new Map<string, { myCards: number; myOverdue: number }>();
        for (const row of guestStatsRows) {
          const stats = guestStatsMap.get(row.boardId) ?? { myCards: 0, myOverdue: 0 };
          stats.myCards += 1;
          if (!row.completedAt && isDueDateOverdue(row)) stats.myOverdue += 1;
          guestStatsMap.set(row.boardId, stats);
        }
        for (const group of guestGrouped.values()) {
          for (const board of group.boards) {
            const stats = guestStatsMap.get(board.id);
            if (stats) {
              board.myCards = stats.myCards;
              board.myOverdue = stats.myOverdue;
            }
          }
        }
      }
    }

    return [...guestGrouped.values()];
  }

  async function loadInvitations() {
    let pendingBoardInvitations: PendingBoardInvitationSummary[] = [];
    // Pending invitations are personal recipient state tied to the human's mailbox. Workspace API
    // keys act on behalf of an integration, not a person, so they must neither see nor redeem them.
    if (auth.authKind !== "apiKey") {
      const invitationRows = await db
        .select({
          id: boardInvitations.id,
          orgName: clients.name,
          invitedByName: users.displayName,
          expiresAt: boardInvitations.expiresAt,
          boardId: boardInvitations.boardId,
          boardName: boards.name,
          boardArchivedAt: boards.archivedAt,
          workspaceName: workspaces.name,
          role: boardInvitations.role,
          assignedItemsOnly: boardInvitations.assignedItemsOnly,
        })
        .from(boardInvitations)
        .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .innerJoin(users, eq(users.id, boardInvitations.invitedById))
        .leftJoin(clientMembers, and(
          eq(clientMembers.clientId, workspaces.clientId),
          eq(clientMembers.userId, userId),
        ))
        .where(and(
          // Scalar subquery instead of a separate viewer read: this handler runs on every shell
          // load, so the match stays a single round trip. "user" is joined above for invitedByName,
          // hence the raw aliased subquery.
          sql`lower(${boardInvitations.email}) = (select lower(u.email) from "user" u where u.id = ${userId})`,
          isNull(boardInvitations.revokedAt),
          isNull(boardInvitations.acceptedAt),
          sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
          // Any retained host membership blocks the guest fallback, matching guestGroups above.
          isNull(clientMembers.userId),
          isNull(clients.suspendedAt),
          isNull(clients.deletedAt),
        ))
        .orderBy(asc(boardInvitations.createdAt));

      if (invitationRows.length > 0) {
        const grantRows = await db
          .select({
            invitationId: boardInvitationGrants.invitationId,
            boardId: boardInvitationGrants.boardId,
            boardName: boards.name,
            workspaceName: workspaces.name,
            role: boardInvitationGrants.role,
            assignedItemsOnly: boardInvitationGrants.assignedItemsOnly,
          })
          .from(boardInvitationGrants)
          .innerJoin(boards, and(eq(boards.id, boardInvitationGrants.boardId), isNull(boards.archivedAt)))
          .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
          .where(inArray(boardInvitationGrants.invitationId, invitationRows.map((row) => row.id)))
          .orderBy(asc(boards.position));
        const grantsByInvitation = new Map<string, PendingBoardInvitationSummary["boards"]>();
        for (const grant of grantRows) {
          const grants = grantsByInvitation.get(grant.invitationId) ?? [];
          grants.push({
            boardId: grant.boardId,
            boardName: grant.boardName,
            workspaceName: grant.workspaceName,
            role: grant.role,
            assignedItemsOnly: grant.assignedItemsOnly,
          });
          grantsByInvitation.set(grant.invitationId, grants);
        }
        pendingBoardInvitations = invitationRows
          .map((invitation) => ({
            id: invitation.id,
            orgName: invitation.orgName,
            invitedByName: invitation.invitedByName,
            expiresAt: invitation.expiresAt?.toISOString() ?? null,
            // The primary-board fallback applies the same archived filter as grant rows, matching
            // loadBoardInvitationGrants: an invitation whose every board is archived must not
            // render an Accept button that redemption would refuse.
            boards: grantsByInvitation.get(invitation.id)
              ?? (invitation.boardArchivedAt ? [] : [{
                boardId: invitation.boardId,
                boardName: invitation.boardName,
                workspaceName: invitation.workspaceName,
                role: invitation.role,
                assignedItemsOnly: invitation.assignedItemsOnly,
              }]),
          }))
          .filter((invitation) => invitation.boards.length > 0);
      }
    }

    return pendingBoardInvitations;
  }

  async function loadDirectory() {
    // Each directory loader already overlaps its enrichment queries. Stage the loaders so
    // their nested groups do not multiply the connection demand of a sidebar refresh.
    const groups = await loadOrganisationGroups();
    const guestGroups = await loadGuestGroups();
    const referencedStandaloneGroupIds = [...new Set(
      [...groups, ...guestGroups].flatMap((group) => group.boards.map((board) => board.standaloneGroupId).filter((id): id is string => !!id)),
    )];
    // Organisation admins manage empty groups; all other viewers receive only metadata that is
    // referenced by a board already proven visible above, preventing sibling-group disclosure.
    const standaloneBoardGroupRows = orgAdmin
      ? await db.select().from(standaloneBoardGroups).where(or(
          eq(standaloneBoardGroups.clientId, auth.cid),
          referencedStandaloneGroupIds.length ? inArray(standaloneBoardGroups.id, referencedStandaloneGroupIds) : undefined,
        )).orderBy(asc(standaloneBoardGroups.title))
      : referencedStandaloneGroupIds.length
        ? await db.select().from(standaloneBoardGroups).where(inArray(standaloneBoardGroups.id, referencedStandaloneGroupIds)).orderBy(asc(standaloneBoardGroups.title))
        : [];

    return { groups, guestGroups, standaloneBoardGroups: standaloneBoardGroupRows };
  }

  async function loadDueItems() {
    type DueSoonCard = {
      // "card" rows carry the card id in `id`; "checklistItem" rows carry the item id in `id`
      // (unique track key) and the parent card id in `cardId` for deep-linking.
      kind: "card" | "checklistItem";
      id: string;
      cardId?: string;
      cardTitle?: string;
      itemText?: string;
      boardId: string;
      workspaceId: string;
      title: string;
      boardName: string;
      boardIcon: string | null;
      dueDateLocalDate: string;
      dueDateSlot: CardDueDateSlot | null;
      dueDateTimezone: string | null;
    };
    // Home's due projection uses the same canonical active-board resolver as global work and
    // search, so guest, standalone, archived, and assigned-items-only sources cannot drift.
    const accessibleBoards = await loadAccessibleBoards(auth);
    const accessibleDueBoardIds = accessibleBoards.map((board) => board.id);
    let dueSoon: DueSoonCard[] = [];
    let overdueChecklistItems = 0;
    if (accessibleDueBoardIds.length > 0) {
      const [userRow] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
      const today = localDateInTimezone(new Date(), userRow?.timezone ?? "UTC");
      const tomorrow = addDays(today, 1);
      const [dueRows, assignedChecklistItems] = await Promise.all([
        db
          .select({
            id: cards.id,
            boardId: cards.boardId,
            workspaceId: boards.workspaceId,
            title: cards.title,
            boardName: boards.name,
            boardIcon: boards.icon,
            dueDateLocalDate: cards.dueDateLocalDate,
            dueDateSlot: cards.dueDateSlot,
            dueDateTimezone: cards.dueDateTimezone,
          })
          .from(cardAssignees)
          .innerJoin(cards, and(eq(cards.id, cardAssignees.cardId), isNull(cards.archivedAt), isNull(cards.completedAt)))
          .innerJoin(boards, eq(boards.id, cards.boardId))
          .where(and(
            eq(cardAssignees.userId, userId),
            inArray(cards.boardId, accessibleDueBoardIds),
            inArray(cards.dueDateLocalDate, [today, tomorrow]),
          )),
        // All assigned, due-dated, active checklist items on accessible boards. We derive both
        // the due-soon (today/tomorrow) entries and the overdue chip count from this one query.
        loadAssignedChecklistItems(db, { assigneeIds: [userId], boardIds: accessibleDueBoardIds }),
      ]);

      const cardDueSoon: DueSoonCard[] = dueRows.flatMap((row) =>
        row.dueDateLocalDate ? [{ kind: "card" as const, ...row, dueDateLocalDate: row.dueDateLocalDate }] : [],
      );
      const checklistDueSoon: DueSoonCard[] = assignedChecklistItems.flatMap((item) =>
        item.dueDateLocalDate && (item.dueDateLocalDate === today || item.dueDateLocalDate === tomorrow)
          ? [{
              kind: "checklistItem" as const,
              id: item.itemId,
              cardId: item.cardId,
              cardTitle: item.cardTitle,
              itemText: item.text,
              boardId: item.boardId,
              workspaceId: item.workspaceId,
              title: item.text,
              boardName: item.boardName,
              boardIcon: item.boardIcon,
              dueDateLocalDate: item.dueDateLocalDate,
              dueDateSlot: item.dueDateSlot,
              dueDateTimezone: item.dueDateTimezone,
            }]
          : [],
      );
      // Overdue checklist items feed the dedicated chip count, not the due-soon list (which,
      // like cards, only shows today/tomorrow). isDueDateOverdue is the single source of truth.
      overdueChecklistItems = assignedChecklistItems.filter((item) => isDueDateOverdue(item)).length;

      dueSoon = [...cardDueSoon, ...checklistDueSoon];
      dueSoon.sort((a, b) =>
        a.dueDateLocalDate.localeCompare(b.dueDateLocalDate) ||
        (DUE_DATE_SLOT_RANK[a.dueDateSlot ?? "anyTime"] - DUE_DATE_SLOT_RANK[b.dueDateSlot ?? "anyTime"]) ||
        a.boardName.localeCompare(b.boardName) ||
        a.title.localeCompare(b.title)
      );
    }

    return { dueSoon, overdueChecklistItems };
  }

  // Keep the two longest projections overlapping, but stage invitations separately.
  // The directory stages its own loaders so these branches cannot multiply into the
  // much wider query burst of running every independent loader together.
  const [directory, due] = await Promise.all([
    loadDirectory(),
    loadDueItems(),
  ]);
  const pendingBoardInvitations = await loadInvitations();
  return { ...directory, ...due, pendingBoardInvitations };
}
