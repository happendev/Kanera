import "../../test/setup.integration.js";
import type { BoardExportArchive } from "@kanera/shared/dto";
import {
  activityEvents,
  boardInvitations,
  boardInvitationGrants,
  boardMembers,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  checklistTemplates,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cardWatchers,
  cards,
  clientGuestSeats,
  clients,
  commentReactions,
  comments,
  customFields,
  emailQueue,
  eventOutbox,
  lists,
  notifications,
  planActions,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { setStripeClientForTests } from "../../lib/billing.js";
import { buildIntegrationServer } from "../../test/integration.js";

type SignupResponse = {
  accessToken: string;
  user: { id: string; clientId: string };
};

type WorkspaceResponse = {
  id: string;
};

type BoardCardSummaryResponse = {
  id: string;
  labelIds: string[];
  assigneeIds: string[];
  customFieldValues: { fieldId: string; valueText: string | null }[];
  commentCount: number;
  attachmentCount: number;
  checklistDoneCount: number;
  checklistTotalCount: number;
  hasDescription: boolean;
  dueDateLocalDate: string | null;
  dueDateSlot: string | null;
  completedAt: string | null;
  coverUrl: string | null;
};

type BoardResponse = {
  cards: BoardCardSummaryResponse[];
  members?: { userId: string; role: string; source: string }[];
  viewerRole?: string;
  viewerSource?: string;
  viewerCanAccessWorkspace?: boolean;
  viewerIsWorkspaceAdmin?: boolean;
  customFieldValuesComplete?: boolean;
  checklistTemplates?: { id: string; title: string }[];
};

type CustomFieldValuesResponse = {
  customFieldValues: { cardId: string; fieldId: string; valueText: string | null }[];
};

void test("standalone boards enforce one board, mirror renames, support guests, and delete their hidden workspace", async () => {
  const app = await buildIntegrationServer();
  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Standalone Board Host", email: "standalone-board-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();
  const ownerAuth = { authorization: `Bearer ${ownerToken}` };
  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: {
      kind: "board",
      name: "Standalone",
      initialBoard: { name: "Standalone" },
      lists: [{ name: "Todo" }, { name: "Done" }],
    },
  });
  assert.equal(created.statusCode, 201);
  const standalone = created.json<{ id: string; initialBoard: { id: string } }>();

  const [organisationMember] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "standalone-org-member@example.com",
      passwordHash: "hash",
      displayName: "Organisation Member",
      clientRole: "member",
    })
    .returning();
  assert.ok(organisationMember);
  const candidates = await app.inject({
    method: "GET",
    url: `/boards/${standalone.initialBoard.id}/member-candidates`,
    headers: ownerAuth,
  });
  assert.equal(candidates.statusCode, 200);
  const candidateBody = candidates.json<{ scope: string; members: { userId: string }[] }>();
  assert.equal(candidateBody.scope, "organisation");
  assert.ok(candidateBody.members.some((member) => member.userId === organisationMember.id));

  const addedOrganisationMember = await app.inject({
    method: "POST",
    url: `/boards/${standalone.initialBoard.id}/members`,
    headers: ownerAuth,
    payload: { userId: organisationMember.id, role: "editor" },
  });
  assert.equal(addedOrganisationMember.statusCode, 201);
  assert.equal(
    await db.$count(workspaceMembers, and(eq(workspaceMembers.workspaceId, standalone.id), eq(workspaceMembers.userId, organisationMember.id))),
    1,
    "standalone board permission materializes the hidden membership needed for home discovery",
  );
  const organisationMemberAuth = {
    authorization: `Bearer ${app.jwt.sign({ sub: organisationMember.id, cid: owner.clientId, role: "member" })}`,
  };
  const organisationMemberHome = await app.inject({ method: "GET", url: "/home/boards", headers: organisationMemberAuth });
  assert.equal(organisationMemberHome.statusCode, 200);
  const organisationMemberGroup = organisationMemberHome
    .json<{ groups: { workspace: { id: string; kind: string }; boards: { id: string }[] }[] }>()
    .groups.find((group) => group.workspace.id === standalone.id);
  assert.ok(organisationMemberGroup);
  assert.equal(organisationMemberGroup.workspace.kind, "board");
  assert.deepEqual(organisationMemberGroup.boards.map((board) => board.id), [standalone.initialBoard.id]);
  const organisationMemberMe = await app.inject({ method: "GET", url: "/me", headers: organisationMemberAuth });
  assert.equal(organisationMemberMe.statusCode, 200);
  assert.equal(organisationMemberMe.json<{ hasWorkspace: boolean }>().hasWorkspace, false);

  const secondBoard = await app.inject({
    method: "POST",
    url: `/workspaces/${standalone.id}/boards`,
    headers: ownerAuth,
    payload: { name: "Not allowed" },
  });
  assert.equal(secondBoard.statusCode, 400);
  assert.match(secondBoard.json<{ message: string }>().message, /standalone/i);

  const lightweight = await app.inject({ method: "GET", url: `/boards/${standalone.initialBoard.id}`, headers: ownerAuth });
  assert.equal(lightweight.statusCode, 200);
  assert.equal(lightweight.json<{ workspaceId: string }>().workspaceId, standalone.id);

  const renamed = await app.inject({
    method: "PATCH",
    url: `/boards/${standalone.initialBoard.id}`,
    headers: ownerAuth,
    payload: { name: "Renamed from board", icon: "flag", iconColor: "orange" },
  });
  assert.equal(renamed.statusCode, 200);
  const [mirroredWorkspace] = await db
    .select({ name: workspaces.name, icon: workspaces.icon, accentColor: workspaces.accentColor })
    .from(workspaces)
    .where(eq(workspaces.id, standalone.id))
    .limit(1);
  assert.equal(mirroredWorkspace?.name, "Renamed from board");
  assert.equal(mirroredWorkspace?.icon, "flag");
  assert.equal(mirroredWorkspace?.accentColor, "orange");

  const importForm = new FormData();
  importForm.append("file", new Blob([JSON.stringify({
    id: "trello-board",
    name: "Standalone import",
    lists: [{ id: "trello-list", name: "Todo", closed: false, pos: 1000 }],
    cards: [],
  })], { type: "application/json" }), "trello.json");
  const importAnalyzed = await app.inject({
    method: "POST",
    url: `/workspaces/${standalone.id}/imports/trello/analyze`,
    headers: ownerAuth,
    payload: importForm,
  });
  assert.equal(importAnalyzed.statusCode, 201);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Standalone Guest Org", email: "standalone-board-guest@example.com", password: "Abc12345", displayName: "Guest" },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();
  await db.insert(boardMembers).values({ boardId: standalone.initialBoard.id, userId: guest.id, role: "editor" });

  const guestOpen = await app.inject({
    method: "POST",
    url: `/boards/${standalone.initialBoard.id}/open`,
    headers: { authorization: `Bearer ${guestToken}` },
    payload: {},
  });
  assert.equal(guestOpen.statusCode, 200);
  assert.equal(guestOpen.json<{ workspaceKind: string }>().workspaceKind, "board");
  const guestHome = await app.inject({ method: "GET", url: "/home/boards", headers: { authorization: `Bearer ${guestToken}` } });
  assert.equal(guestHome.statusCode, 200);
  const guestGroup = guestHome.json<{ guestGroups: { workspace: { id: string; kind: string }; boards: { id: string }[] }[] }>()
    .guestGroups.find((group) => group.workspace.id === standalone.id);
  assert.ok(guestGroup);
  assert.equal(guestGroup.workspace.kind, "board");
  assert.deepEqual(guestGroup.boards.map((board) => board.id), [standalone.initialBoard.id]);

  const removedOrganisationMember = await app.inject({
    method: "DELETE",
    url: `/boards/${standalone.initialBoard.id}/members/${organisationMember.id}`,
    headers: ownerAuth,
  });
  assert.equal(removedOrganisationMember.statusCode, 204);
  assert.equal(
    await db.$count(workspaceMembers, and(eq(workspaceMembers.workspaceId, standalone.id), eq(workspaceMembers.userId, organisationMember.id))),
    0,
    "removing standalone board permission removes its hidden membership",
  );

  const deleted = await app.inject({ method: "DELETE", url: `/boards/${standalone.initialBoard.id}`, headers: ownerAuth });
  assert.equal(deleted.statusCode, 204);
  assert.equal(await db.$count(boards, eq(boards.id, standalone.initialBoard.id)), 0);
  assert.equal(await db.$count(workspaces, eq(workspaces.id, standalone.id)), 0);
});

void test("board payload enriches card summaries from the card summary view", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({
      listId: list!.id,
      boardId: board!.id,
      title: "Hydrate board",
      description: "Detailed task",
      position: "1000.0000000000",
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "morning",
      createdById: user.id,
    })
    .returning();
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: workspace.id, name: "Blocked", color: "rose", position: "1000.0000000000" })
    .returning();
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: workspace.id, name: "Priority", type: "text", position: "1000.0000000000" })
    .returning();
  await db.insert(cardAssignees).values({ cardId: card!.id, userId: user.id });
  await db.insert(cardLabelAssignments).values({ cardId: card!.id, labelId: label!.id });
  await db.insert(cardCustomFieldValues).values({ cardId: card!.id, fieldId: field!.id, valueText: "High" });
  await db.insert(comments).values({ cardId: card!.id, authorId: user.id, body: "Heads up" });
  const [checklist] = await db.insert(cardChecklists).values({ cardId: card!.id, title: "Steps", position: "1000.0000000000" }).returning();
  assert.ok(checklist);
  await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "Done", position: "1000.0000000000", completedAt: new Date("2026-05-23T10:00:00.000Z"), completedById: user.id });
  await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "Todo", position: "2000.0000000000" });
  const [cover] = await db
    .insert(cardAttachments)
    .values({
      cardId: card!.id,
      clientId: user.clientId,
      uploadedById: user.id,
      fileName: "cover.png",
      mimeType: "image/png",
      byteSize: 1234,
      fileKey: "covers/cover.png",
      url: "/media/covers/cover.png",
      coverImageFileKey: "covers/cover-small.png",
      coverImageUrl: "/media/covers/cover-small.png",
    })
    .returning();
  await db.update(cards).set({ coverAttachmentId: cover!.id }).where(eq(cards.id, card!.id));

  const res = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<BoardResponse>();
  // Organisation owners/admins have board-management rights across every workspace in their org,
  // even when their authority is implicit rather than a workspace_members row.
  assert.equal(body.viewerIsWorkspaceAdmin, true);
  const enriched = body.cards.find((c) => c.id === card!.id);
  assert.ok(enriched);
  assert.deepEqual(enriched.labelIds, [label!.id]);
  assert.deepEqual(enriched.assigneeIds, [user.id]);
  assert.equal(enriched.customFieldValues.length, 1);
  const fieldValue = enriched.customFieldValues[0];
  assert.ok(fieldValue);
  assert.equal(fieldValue.fieldId, field!.id);
  assert.equal(fieldValue.valueText, "High");
  assert.equal(enriched.commentCount, 1);
  assert.equal(enriched.attachmentCount, 1);
  assert.equal(enriched.checklistDoneCount, 1);
  assert.equal(enriched.checklistTotalCount, 2);
  assert.equal(enriched.hasDescription, true);
  assert.equal(enriched.dueDateLocalDate, "2026-05-20");
  assert.equal(enriched.dueDateSlot, "morning");
  assert.equal(typeof enriched.coverUrl, "string");
  assert.ok(enriched.coverUrl);
  assert.ok(enriched.coverUrl.length > 0);

  const lightweightGet = await app.inject({
    method: "GET",
    url: `/boards/${board!.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(lightweightGet.statusCode, 200);
  assert.equal(lightweightGet.json<{ id: string }>().id, board!.id);

  const oldVisit = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/visit`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(oldVisit.statusCode, 404);
});

void test("deleting a live free-plan board reactivates the oldest downgrade-archived board", async () => {
  const previous = {
    mode: env.KANERA_DEPLOYMENT_MODE,
    maxBoards: env.HOSTED_FREE_MAX_BOARDS,
  };
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_MAX_BOARDS = 2;
  try {
    const app = await buildIntegrationServer();
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Board Restore Org", email: "board-restore-owner@example.com", password: "Abc12345", displayName: "Owner" },
    });
    assert.equal(signup.statusCode, 200);
    const { accessToken, user } = signup.json<SignupResponse>();
    await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, user.clientId));

    const wsCreated = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Delivery" },
    });
    assert.equal(wsCreated.statusCode, 201);
    const workspace = wsCreated.json<WorkspaceResponse>();

    const [liveA, liveB, archivedA, archivedB] = await db.insert(boards).values([
      { workspaceId: workspace.id, name: "Live A", position: "1000.0000000000", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { workspaceId: workspace.id, name: "Live B", position: "2000.0000000000", createdAt: new Date("2026-01-02T00:00:00.000Z") },
      { workspaceId: workspace.id, name: "Archived A", position: "3000.0000000000", archivedAt: new Date("2026-01-10T00:00:00.000Z"), createdAt: new Date("2026-01-03T00:00:00.000Z") },
      { workspaceId: workspace.id, name: "Archived B", position: "4000.0000000000", archivedAt: new Date("2026-01-11T00:00:00.000Z"), createdAt: new Date("2026-01-04T00:00:00.000Z") },
    ]).returning();
    await db.insert(planActions).values([
      { clientId: user.clientId, kind: "board_archived", payload: { boardId: archivedA!.id } },
      { clientId: user.clientId, kind: "board_archived", payload: { boardId: archivedB!.id } },
    ]);

    const blockedOpen = await app.inject({
      method: "POST",
      url: `/boards/${archivedA!.id}/open`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    assert.equal(blockedOpen.statusCode, 404);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/boards/${liveA!.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(deleted.statusCode, 204);

    const [restored] = await db.select({ archivedAt: boards.archivedAt }).from(boards).where(eq(boards.id, archivedA!.id)).limit(1);
    const [stillArchived] = await db.select({ archivedAt: boards.archivedAt }).from(boards).where(eq(boards.id, archivedB!.id)).limit(1);
    assert.equal(restored?.archivedAt, null, "oldest archived board is reactivated into the freed slot");
    assert.notEqual(stillArchived?.archivedAt, null, "only one board is restored because only one slot was freed");
    assert.equal(await db.$count(planActions, and(eq(planActions.clientId, user.clientId), eq(planActions.kind, "board_archived"))), 1);
    assert.equal(await db.$count(boards, and(eq(boards.workspaceId, workspace.id), isNull(boards.archivedAt))), 2);

    const reopened = await app.inject({
      method: "POST",
      url: `/boards/${archivedA!.id}/open`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json<{ board: { id: string } }>().board.id, archivedA!.id);
    assert.ok(liveB);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previous.mode;
    env.HOSTED_FREE_MAX_BOARDS = previous.maxBoards;
  }
});

void test("board open omits non-showOnCard custom-field values, which load from the dedicated endpoint", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme Hidden CF", email: "hidden-cf-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: board!.id, title: "Hidden field card", position: "1000.0000000000", createdById: user.id })
    .returning();
  // One field shown on cards, one hidden. Only the shown value belongs in the open payload.
  const [shownField] = await db
    .insert(customFields)
    .values({ workspaceId: workspace.id, name: "Priority", type: "text", position: "1000.0000000000", showOnCard: true })
    .returning();
  const [hiddenField] = await db
    .insert(customFields)
    .values({ workspaceId: workspace.id, name: "Internal", type: "text", position: "2000.0000000000", showOnCard: false })
    .returning();
  await db.insert(cardCustomFieldValues).values({ cardId: card!.id, fieldId: shownField!.id, valueText: "High" });
  await db.insert(cardCustomFieldValues).values({ cardId: card!.id, fieldId: hiddenField!.id, valueText: "Secret" });
  const [unselectedCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: board!.id, title: "Unselected card", position: "2000.0000000000", createdById: user.id })
    .returning();
  await db.insert(cardCustomFieldValues).values({ cardId: unselectedCard!.id, fieldId: hiddenField!.id, valueText: "Do not return" });

  const open = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(open.statusCode, 200);
  const body = open.json<BoardResponse>();
  assert.equal(body.customFieldValuesComplete, false);
  const enriched = body.cards.find((c) => c.id === card!.id);
  assert.ok(enriched);
  assert.equal(enriched.customFieldValues!.length, 1);
  assert.equal(enriched.customFieldValues![0]!.fieldId, shownField!.id);
  // Default/null fields are stripped from the compacted open payload.
  assert.equal("archivedAt" in enriched, false);
  assert.equal("dueDateLocalDate" in enriched, false);
  assert.equal("coverUrl" in enriched, false);

  // The full set, including the hidden field, comes from the on-demand endpoint.
  const full = await app.inject({
    method: "GET",
    url: `/boards/${board!.id}/custom-field-values`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(full.statusCode, 200);
  const fullBody = full.json<CustomFieldValuesResponse>();
  const hiddenValue = fullBody.customFieldValues.find((v) => v.fieldId === hiddenField!.id);
  assert.ok(hiddenValue);
  assert.equal(hiddenValue.valueText, "Secret");
  assert.equal(fullBody.customFieldValues.filter((v) => v.cardId === card!.id).length, 2);

  const selected = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/custom-field-values/query`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { cardIds: [card!.id] },
  });
  assert.equal(selected.statusCode, 200);
  const selectedBody = selected.json<CustomFieldValuesResponse>();
  assert.equal(selectedBody.customFieldValues.length, 2);
  assert.ok(selectedBody.customFieldValues.every((value) => value.cardId === card!.id));
});

void test("board export returns a complete all-card archive with signed attachments", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme Export", email: "export-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [archivedList] = await db.insert(lists).values({ workspaceId: workspace.id, name: "Archived list", position: "2000.0000000000", archivedAt: new Date() }).returning();
  assert.ok(archivedList);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" }).returning();
  assert.ok(board);
  const [activeCard] = await db.insert(cards).values({ listId: list!.id, boardId: board.id, title: "Active", description: "Details", position: "1000.0000000000", createdById: user.id }).returning();
  const [completedCard] = await db.insert(cards).values({ listId: list!.id, boardId: board.id, title: "Completed", position: "2000.0000000000", completedAt: new Date("2026-05-22T10:00:00.000Z"), createdById: user.id }).returning();
  const [archivedCard] = await db.insert(cards).values({ listId: archivedList.id, boardId: board.id, title: "Archived", position: "3000.0000000000", archivedAt: new Date("2026-05-22T11:00:00.000Z"), createdById: user.id }).returning();
  assert.ok(activeCard);
  assert.ok(completedCard);
  assert.ok(archivedCard);
  const [label] = await db.insert(cardLabels).values({ workspaceId: workspace.id, name: "Blocked", color: "rose", position: "1000.0000000000" }).returning();
  const [field] = await db.insert(customFields).values({ workspaceId: workspace.id, name: "Hours", type: "number", position: "1000.0000000000", showOnCard: false }).returning();
  assert.ok(label);
  assert.ok(field);
  await db.insert(cardAssignees).values({ cardId: activeCard.id, userId: user.id });
  await db.insert(cardLabelAssignments).values({ cardId: activeCard.id, labelId: label.id });
  await db.insert(cardCustomFieldValues).values({ cardId: activeCard.id, fieldId: field.id, valueNumber: "4.5" });
  const [checklist] = await db.insert(cardChecklists).values({ cardId: activeCard.id, title: "Steps", position: "1000.0000000000" }).returning();
  assert.ok(checklist);
  await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "Review", position: "1000.0000000000", completedAt: new Date("2026-05-23T10:00:00.000Z"), completedById: user.id });
  const [comment] = await db.insert(comments).values({ cardId: activeCard.id, authorId: user.id, body: "Looks good" }).returning();
  assert.ok(comment);
  await db.insert(commentReactions).values({ commentId: comment.id, userId: user.id, reactionType: "thumbs_up" });
  await db.insert(cardWatchers).values({ cardId: activeCard.id, userId: user.id });
  await db.insert(cardAttachments).values({
    cardId: activeCard.id,
    clientId: user.clientId,
    uploadedById: user.id,
    fileName: "proof.png",
    mimeType: "image/png",
    byteSize: 42,
    fileKey: "cards/proof.png",
    url: "/api/media/cards/proof.png",
    thumbnailFileKey: "cards/proof_thumb.jpg",
    thumbnailUrl: "/api/media/cards/proof_thumb.jpg",
    coverImageFileKey: "cards/proof_cover.jpg",
    coverImageUrl: "/api/media/cards/proof_cover.jpg",
  });

  const res = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/export`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<BoardExportArchive>();
  assert.equal(body.format, "kanera.board.export");
  assert.deepEqual(new Set(body.cards.map((card) => card.id)), new Set([activeCard.id, completedCard.id, archivedCard.id]));
  assert.ok(body.lists.some((row) => row.id === archivedList.id));
  assert.equal(body.cardAssignees.length, 1);
  assert.equal(body.cardLabelAssignments.length, 1);
  assert.equal(body.cardCustomFieldValues[0]?.valueNumber, "4.5");
  assert.equal(body.checklists[0]?.items.length, 1);
  assert.equal(body.comments[0]?.body, "Looks good");
  assert.equal(body.commentReactions[0]?.reactionType, "thumbs_up");
  assert.equal(body.cardWatchers[0]?.userId, user.id);
  assert.equal(body.attachments.length, 1);
  assert.match(body.attachments[0]!.url, /^https?:\/\/.+\/api\/media\/.+\?t=.+&e=\d+&fn=proof\.png$/);
  assert.match(body.attachments[0]!.thumbnailUrl ?? "", /^https?:\/\/.+\/api\/media\/.+\?t=.+&e=\d+$/);
  assert.match(body.attachments[0]!.coverImageUrl ?? "", /^https?:\/\/.+\/api\/media\/.+\?t=.+&e=\d+$/);
});

void test("board open derives the viewer role from the board_member grant", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Role",
      email: "role-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [ownerRow] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.id, owner.id)).limit(1);
  assert.ok(ownerRow);
  const [member] = await db
    .insert(users)
    .values({
      clientId: ownerRow.clientId,
      email: "workspace-observer@example.com",
      passwordHash: "hash",
      displayName: "Workspace Observer",
      clientRole: "member",
    })
    .returning();
  assert.ok(member);

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  // Board membership is the sole access model: the board_member role is authoritative even when the
  // workspace role differs (here a plain workspace member but a board editor).
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: board.id, userId: member.id, role: "editor" });

  const memberToken = app.jwt.sign({ sub: member.id, cid: ownerRow.clientId, role: "member" });
  const open = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/open`,
    headers: { authorization: `Bearer ${memberToken}` },
    payload: {},
  });
  assert.equal(open.statusCode, 200);
  const body = open.json<BoardResponse>();
  assert.equal(body.viewerRole, "editor");
  const memberPayload = body.members?.find((m) => m.userId === member.id);
  assert.ok(memberPayload);
  assert.equal(memberPayload.role, "editor");
  assert.equal(memberPayload.source, "board");
});

void test("board observers cannot mutate cards or move lists", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Observer Guard",
      email: "observer-guard-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [ownerRow] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.id, owner.id)).limit(1);
  assert.ok(ownerRow);
  const [observer] = await db
    .insert(users)
    .values({
      clientId: ownerRow.clientId,
      email: "guarded-observer@example.com",
      passwordHash: "hash",
      displayName: "Guarded Observer",
      clientRole: "member",
    })
    .returning();
  assert.ok(observer);

  const [firstList] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(firstList);
  const [secondList] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Later", position: "2000.0000000000" })
    .returning();
  assert.ok(secondList);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({
      listId: firstList.id,
      boardId: board.id,
      title: "Do not edit",
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);
  // A plain workspace member who is a board observer: board membership gates card/comment mutations
  // (observer is read-only) and workspace-scoped list moves require workspace admin, so a member is
  // blocked there too — this actor must be blocked on all of them.
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: observer.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: board.id, userId: observer.id, role: "observer" });

  const observerToken = app.jwt.sign({ sub: observer.id, cid: ownerRow.clientId, role: "member" });
  const headers = { authorization: `Bearer ${observerToken}` };

  const editCard = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}`,
    headers,
    payload: { title: "Edited by observer" },
  });
  assert.equal(editCard.statusCode, 403);

  const moveCard = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers,
    payload: { listId: secondList.id, beforeCardId: null },
  });
  assert.equal(moveCard.statusCode, 403);

  const moveList = await app.inject({
    method: "POST",
    url: `/lists/${firstList.id}/move`,
    headers,
    payload: { beforeListId: null },
  });
  assert.equal(moveList.statusCode, 403);

  const bulkMoveCards = await app.inject({
    method: "POST",
    url: `/lists/${firstList.id}/cards/move`,
    headers,
    payload: { targetListId: secondList.id },
  });
  assert.equal(bulkMoveCards.statusCode, 403);

  const exportBoard = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/export`,
    headers,
  });
  assert.equal(exportBoard.statusCode, 403);

  const [unchangedCard] = await db.select().from(cards).where(eq(cards.id, card.id)).limit(1);
  assert.equal(unchangedCard?.title, "Do not edit");
  assert.equal(unchangedCard?.listId, firstList.id);
  const [unchangedList] = await db.select().from(lists).where(eq(lists.id, firstList.id)).limit(1);
  assert.equal(unchangedList?.position, firstList.position);
});

void test("a workspace admin adds a same-org member, changes their role, and cannot change a pinned admin's board role", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme Access", email: "access-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const wsCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  // Create the board through the API. The creator is a workspace admin, so board creation
  // materializes a pinned editor row for them (workspace admins are on every board).
  const boardCreated = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/boards`,
    headers: auth,
    payload: { name: "Roadmap" },
  });
  assert.equal(boardCreated.statusCode, 201);
  const board = boardCreated.json<{ id: string }>();
  const [ownerMember] = await db.select().from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, owner.id)));
  assert.equal(ownerMember?.role, "editor", "creator is seeded as a board editor");
  assert.equal(ownerMember?.pinned, true, "workspace admin's board row is pinned");

  // A same-org workspace member (not an org admin) who is not yet on the board.
  const [ownerRow] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.id, owner.id)).limit(1);
  assert.ok(ownerRow);
  const [member] = await db
    .insert(users)
    .values({ clientId: ownerRow.clientId, email: "access-member@example.com", passwordHash: "hash", displayName: "Member", clientRole: "member" })
    .returning();
  assert.ok(member);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "member" });

  // POST /boards/:id/members now accepts same-org users (previously rejected).
  const added = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/members`,
    headers: auth,
    payload: { userId: member.id, role: "editor" },
  });
  assert.equal(added.statusCode, 201);

  // PATCH changes the member's board role (editor -> observer) and emits board:member:updated.
  const patched = await app.inject({
    method: "PATCH",
    url: `/boards/${board.id}/members/${member.id}`,
    headers: auth,
    payload: { role: "observer" },
  });
  assert.equal(patched.statusCode, 200);
  const [updatedMember] = await db.select().from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, member.id)));
  assert.equal(updatedMember?.role, "observer");
  // The board:member:updated emit is fire-and-forget, so poll the durable outbox for it.
  let sawUpdatedEvent = false;
  for (let attempt = 0; attempt < 20 && !sawUpdatedEvent; attempt++) {
    const rows = await db.select().from(eventOutbox).where(and(eq(eventOutbox.boardId, board.id), eq(eventOutbox.eventType, "board:member:updated")));
    sawUpdatedEvent = rows.length >= 1;
    if (!sawUpdatedEvent) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(sawUpdatedEvent, "board:member:updated is published to the outbox");

  // PATCH on a user with no board_member row is a 404.
  const missing = await app.inject({
    method: "PATCH",
    url: `/boards/${board.id}/members/00000000-0000-0000-0000-0000000009f9`,
    headers: auth,
    payload: { role: "editor" },
  });
  assert.equal(missing.statusCode, 404);

  // The creator's row is pinned because they are a workspace admin; a pinned row's board role
  // cannot be changed board-by-board, so downgrading them to observer is rejected.
  const demoteOwner = await app.inject({
    method: "PATCH",
    url: `/boards/${board.id}/members/${owner.id}`,
    headers: auth,
    payload: { role: "observer" },
  });
  assert.equal(demoteOwner.statusCode, 400);
  const [stillOwner] = await db.select().from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, owner.id)));
  assert.equal(stillOwner?.role, "editor");
  assert.equal(stillOwner?.pinned, true);

  const [boardList] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(boardList);
  const [assignedCard] = await db.insert(cards).values({ boardId: board.id, listId: boardList.id, title: "Assigned before removal", position: "1000.0000000000", createdById: owner.id }).returning();
  assert.ok(assignedCard);
  await db.insert(cardAssignees).values({ cardId: assignedCard.id, userId: member.id });
  const [checklist] = await db.insert(cardChecklists).values({ cardId: assignedCard.id, title: "Release", position: "1000.0000000000" }).returning();
  assert.ok(checklist);
  const [checklistItem] = await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "Member task", position: "1000.0000000000", assigneeId: member.id }).returning();
  assert.ok(checklistItem);
  const [notification] = await db.insert(notifications).values({
    userId: member.id,
    cardId: assignedCard.id,
    listId: boardList.id,
    boardId: board.id,
    workspaceId: workspace.id,
    reason: "assigned",
  }).returning();
  assert.ok(notification);

  const removed = await app.inject({
    method: "DELETE",
    url: `/boards/${board.id}/members/${member.id}`,
    headers: auth,
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, assignedCard.id), eq(cardAssignees.userId, member.id))), 0);
  const [unassignedChecklistItem] = await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, checklistItem.id));
  assert.equal(unassignedChecklistItem?.assigneeId, null);
  assert.equal(await db.$count(notifications, eq(notifications.id, notification.id)), 0);
  const cleanupActivities = await db
    .select({ action: activityEvents.action })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, assignedCard.id), inArray(activityEvents.action, ["assignees:set", "checklistItem:assignee:set"])));
  assert.deepEqual(new Set(cleanupActivities.map((row) => row.action)), new Set(["assignees:set", "checklistItem:assignee:set"]));

  const readded = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/members`,
    headers: auth,
    payload: { userId: member.id, role: "editor" },
  });
  assert.equal(readded.statusCode, 201);
  assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, assignedCard.id), eq(cardAssignees.userId, member.id))), 0, "removed assignments do not return with membership");
  const [stillUnassignedChecklistItem] = await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, checklistItem.id));
  assert.equal(stillUnassignedChecklistItem?.assigneeId, null, "removed checklist assignments do not return with membership");
});

void test("cross-org board guests open workspace boards through explicit membership", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Host Org",
      email: "guest-host-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Shared Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Org",
      email: "external-board-guest@external.test",
      password: "Abc12345",
      displayName: "External Guest",
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();
  assert.notEqual(guest.clientId, owner.clientId);

  await db.insert(boardMembers).values({ boardId: board.id, userId: guest.id, role: "editor" });
  const [template] = await db.insert(checklistTemplates).values({
    workspaceId: workspace.id,
    title: "Guest-visible template",
    position: "1000.0000000000",
  }).returning();
  const [editorTarget, observerTarget, inaccessibleTarget] = await db.insert(boards).values([
    { workspaceId: workspace.id, name: "Editor target", position: "2000.0000000000" },
    { workspaceId: workspace.id, name: "Observer target", position: "3000.0000000000" },
    { workspaceId: workspace.id, name: "Private target", position: "4000.0000000000" },
  ]).returning();
  assert.ok(template && editorTarget && observerTarget && inaccessibleTarget);
  await db.insert(boardMembers).values([
    { boardId: editorTarget.id, userId: guest.id, role: "editor" },
    { boardId: observerTarget.id, userId: guest.id, role: "observer" },
  ]);

  const open = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/open`,
    headers: { authorization: `Bearer ${guestToken}` },
    payload: {},
  });
  assert.equal(open.statusCode, 200);
  const body = open.json<BoardResponse>();
  assert.equal(body.viewerRole, "editor");
  assert.equal(body.viewerSource, "board");
  assert.equal(body.viewerCanAccessWorkspace, false);
  assert.deepEqual(body.checklistTemplates?.map((row) => row.title), ["Guest-visible template"]);
  const guestMember = body.members?.find((m) => m.userId === guest.id);
  assert.ok(guestMember);
  assert.equal(guestMember.source, "board");

  const hostWorkspaces = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/members`,
    headers: { authorization: `Bearer ${guestToken}` },
  });
  assert.equal(hostWorkspaces.statusCode, 403);

  const targets = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/transfer-targets`,
    headers: { authorization: `Bearer ${guestToken}` },
  });
  assert.equal(targets.statusCode, 200);
  assert.deepEqual(
    targets.json<{ id: string }[]>().map((target) => target.id),
    [editorTarget.id],
  );

});

void test("cross-org board guests cannot invite other guests even with a board editor role", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Invite Host",
      email: "guest-invite-host-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Guest Managed Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Invite External",
      email: "guest-invite-stale-admin@external.test",
      password: "Abc12345",
      displayName: "Stale Admin Guest",
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();

  // Even the highest board role (editor) does not confer board-management authority: inviting is a
  // workspace-admin action, and a cross-org guest is never a workspace admin, so the route must fail
  // closed here.
  await db.insert(boardMembers).values({ boardId: board.id, userId: guest.id, role: "editor" });

  const invite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${guestToken}` },
    payload: { boardId: board.id, email: "guest-invite-target@external.test", role: "editor" },
  });
  assert.equal(invite.statusCode, 403);

  const invites = await db.select().from(boardInvitations).where(eq(boardInvitations.boardId, board.id));
  assert.equal(invites.length, 0);
});

void test("a board invitation link is bound to the invited email address", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Reusable Board Invite Host",
      email: "reusable-board-invite-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Shared Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const invite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: board.id, email: "shared-link-placeholder@external.test", role: "editor" },
  });
  assert.equal(invite.statusCode, 201);
  const { invite: createdInvite } = invite.json<{ invite: { id: string } }>();
  const invitationId = createdInvite.id;

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Wrong Guest Org",
      email: "wrong-guest@external.test",
      password: "Abc12345",
      displayName: "Wrong Guest",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<SignupResponse>();

  const accept = await app.inject({
    method: "POST",
    url: `/board-invitations/${invitationId}/accept`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(accept.statusCode, 403);

  const members = await db.select().from(boardMembers).where(eq(boardMembers.boardId, board.id));
  assert.equal(members.length, 0);
});

void test("same-org users cannot accept board guest invitation links", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Same Org Board Invite Host",
      email: "same-org-board-invite-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Shared Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const invite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: board.id, email: "same-org-placeholder@external.test", role: "editor" },
  });
  assert.equal(invite.statusCode, 201);
  const { invite: createdInvite } = invite.json<{ invite: { id: string } }>();
  const invitationId = createdInvite.id;

  const [sameOrgUser] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "same-org-placeholder@external.test",
      passwordHash: "hash",
      displayName: "Same Org Member",
      clientRole: "member",
    })
    .returning();
  assert.ok(sameOrgUser);
  const sameOrgToken = app.jwt.sign({ sub: sameOrgUser.id, cid: owner.clientId, role: "member" });

  const accept = await app.inject({
    method: "POST",
    url: `/board-invitations/${invitationId}/accept`,
    headers: { authorization: `Bearer ${sameOrgToken}` },
  });
  assert.equal(accept.statusCode, 400);

  const memberships = await db.select().from(boardMembers).where(eq(boardMembers.userId, sameOrgUser.id));
  assert.equal(memberships.length, 0);
});

void test("accepted board guest invitation notifies host organisation owners and marks invite accepted", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Board Notify Host",
      email: "board-notify-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken } = ownerSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Client Launch", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const invite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: board.id, email: "board-notify-guest@external.test", role: "observer" },
  });
  assert.equal(invite.statusCode, 201);
  const { invite: createdInvite } = invite.json<{ invite: { id: string } }>();
  const invitationId = createdInvite.id;

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Board Notify Guest Org",
      email: "board-notify-guest@external.test",
      password: "Abc12345",
      displayName: "Guest User",
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { accessToken: guestToken } = guestSignup.json<SignupResponse>();

  const accept = await app.inject({
    method: "POST",
    url: `/board-invitations/${invitationId}/accept`,
    headers: { authorization: `Bearer ${guestToken}` },
  });
  assert.equal(accept.statusCode, 200);

  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "invite_accepted"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toEmail, "board-notify-owner@example.com");
  assert.deepEqual(rows[0]!.data, {
    context: "board",
    displayName: "Host Owner",
    acceptedByName: "Guest User",
    acceptedByEmail: "board-notify-guest@external.test",
    orgName: "Board Notify Host",
    boardName: "Client Launch",
    boardRole: "observer",
    boardUrl: `http://web.test/b/${board.id}`,
  });

  const [acceptedInvite] = await db
    .select({ acceptedAt: boardInvitations.acceptedAt })
    .from(boardInvitations)
    .where(eq(boardInvitations.id, invitationId));
  assert.ok(acceptedInvite?.acceptedAt);

  const pending = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/guests`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(pending.statusCode, 200);
  assert.deepEqual(pending.json<{ pendingInvites: unknown[] }>().pendingInvites, []);
});

void test("signup through board invite token notifies host organisation owners", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Board Signup Notify Host",
      email: "board-signup-notify-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken } = ownerSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Launch Room", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [secondBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Partner Room", position: "2000.0000000000" })
    .returning();
  assert.ok(secondBoard);

  const invite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: board.id, email: "board-signup-notify-guest@external.test", role: "editor" },
  });
  assert.equal(invite.statusCode, 201);
  const firstInviteBody = invite.json<{ token: string; invite: { id: string } }>();
  const invitationId = firstInviteBody.invite.id;

  const secondInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: secondBoard.id, email: "board-signup-notify-guest@external.test", role: "observer" },
  });
  assert.equal(secondInvite.statusCode, 201, secondInvite.body);
  const secondInviteBody = secondInvite.json<{ token: string; invite: { id: string } }>();
  assert.equal(typeof secondInviteBody.token, "string");
  assert.equal(secondInviteBody.invite.id, invitationId);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Board Signup Notify Guest Org",
      email: "board-signup-notify-guest@external.test",
      password: "Abc12345",
      displayName: "New Guest",
      boardInviteToken: secondInviteBody.token,
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { user: guest } = guestSignup.json<SignupResponse>();

  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "invite_accepted"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.data, {
    context: "board",
    displayName: "Host Owner",
    acceptedByName: "New Guest",
    acceptedByEmail: "board-signup-notify-guest@external.test",
    orgName: "Board Signup Notify Host",
    boardName: "Launch Room",
    boardRole: "editor",
    boardUrl: `http://web.test/b/${board.id}`,
  });

  const [acceptedInvite] = await db
    .select({ acceptedAt: boardInvitations.acceptedAt })
    .from(boardInvitations)
    .where(eq(boardInvitations.id, invitationId));
  assert.ok(acceptedInvite?.acceptedAt);

  const memberships = await db.select().from(boardMembers).where(eq(boardMembers.userId, guest.id));
  assert.deepEqual(memberships.map((member) => [member.boardId, member.role]).sort(), [
    [board.id, "editor"],
    [secondBoard.id, "observer"],
  ].sort());
});

void test("directly adding an existing external user to a board does not send invite accepted email", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Direct Add Host",
      email: "direct-add-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken } = ownerSignup.json<SignupResponse>();

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Direct Add Guest Org",
      email: "direct-add-guest@external.test",
      password: "Abc12345",
      displayName: "Guest User",
    },
  });
  assert.equal(guestSignup.statusCode, 200);

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Direct Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const add = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: board.id, email: "direct-add-guest@external.test", role: "editor" },
  });
  assert.equal(add.statusCode, 201);
  assert.equal(add.json<{ status: string }>().status, "added");

  const acceptedRows = await db.select().from(emailQueue).where(eq(emailQueue.type, "invite_accepted"));
  assert.equal(acceptedRows.length, 0);
  const accessRows = await db.select().from(emailQueue).where(eq(emailQueue.type, "board_access_granted"));
  assert.equal(accessRows.length, 1);
  assert.equal(accessRows[0]?.toEmail, "direct-add-guest@external.test");
  assert.deepEqual(accessRows[0]?.data, {
    displayName: "Guest User",
    boardName: "Direct Board",
    orgName: "Direct Add Host",
    invitedByName: "Host Owner",
    role: "editor",
    boardUrl: `${env.WEB_ORIGIN}/b/${board.id}`,
  });

  const roleUpdate = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: board.id, email: "direct-add-guest@external.test", role: "observer" },
  });
  assert.equal(roleUpdate.statusCode, 409);
  assert.equal(await db.$count(emailQueue, eq(emailQueue.type, "board_access_granted")), 1);
});

void test("cross-org board guest needs a paid guest seat for a third board in the same host org", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  const app = await buildIntegrationServer();
  try {

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Accept Limit Host",
      email: "guest-accept-limit-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const workspaceBoards = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "Shared One", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "Shared Two", position: "2000.0000000000" },
      { workspaceId: workspace.id, name: "Shared Three", position: "3000.0000000000" },
    ])
    .returning();
  assert.equal(workspaceBoards.length, 3);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Accept Limit External",
      email: "guest-accept-limit-external@external.test",
      password: "Abc12345",
      displayName: "External Guest",
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();

  await db.insert(boardMembers).values([
    { boardId: workspaceBoards[0]!.id, userId: guest.id, role: "editor" },
    { boardId: workspaceBoards[1]!.id, userId: guest.id, role: "observer" },
  ]);

  // Fill the host org's purchased seat pool (just the owner) so crossing the free guest-board cap has
  // no seat to consume — block-until-buy.
  await db.update(clients).set({ billingStatus: "active", seatLimit: 1 }).where(eq(clients.id, owner.clientId));

  const invite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { boardId: workspaceBoards[2]!.id, email: "guest-accept-limit-external@external.test", role: "editor" },
  });
  assert.equal(invite.statusCode, 402);
  assert.equal(invite.json<{ code: string }>().code, "SEAT_LIMIT_REACHED");

  const [thirdBoardInvitation] = await db
    .insert(boardInvitations)
    .values({
      clientId: owner.clientId,
      boardId: workspaceBoards[2]!.id,
      email: "guest-accept-limit-external@external.test",
      role: "editor",
      tokenHash: "accept-limit-seeded-token",
      invitedById: guest.id,
    })
    .returning();
  assert.ok(thirdBoardInvitation);
  await db.insert(boardInvitationGrants).values({
    invitationId: thirdBoardInvitation.id,
    boardId: workspaceBoards[2]!.id,
    role: "editor",
  });

  // Acceptance past the free cap needs a pooled seat, but the pool is full (1/1) → block-until-buy 402,
  // with no membership and no seat created (the guest is not silently added to a board the host has not
  // bought capacity for).
  const accept = await app.inject({
    method: "POST",
    url: `/board-invitations/${thirdBoardInvitation.id}/accept`,
    headers: { authorization: `Bearer ${guestToken}` },
  });
  assert.equal(accept.statusCode, 402);
  assert.equal(accept.json<{ code: string }>().code, "SEAT_LIMIT_REACHED");

  const thirdBoardMembership = await db
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, workspaceBoards[2]!.id), eq(boardMembers.userId, guest.id)));
  assert.equal(thirdBoardMembership.length, 0);

  const seatRows = await db
    .select({ userId: clientGuestSeats.userId })
    .from(clientGuestSeats)
    .where(eq(clientGuestSeats.userId, guest.id));
  assert.equal(seatRows.length, 0);

  // Buy another seat (1 → 2): now acceptance succeeds and consumes the pooled seat.
  await db.update(clients).set({ seatLimit: 2 }).where(eq(clients.id, owner.clientId));
  const acceptAfterBuy = await app.inject({
    method: "POST",
    url: `/board-invitations/${thirdBoardInvitation.id}/accept`,
    headers: { authorization: `Bearer ${guestToken}` },
  });
  assert.equal(acceptAfterBuy.statusCode, 200);
  assert.equal(
    await db.$count(boardMembers, and(eq(boardMembers.boardId, workspaceBoards[2]!.id), eq(boardMembers.userId, guest.id))),
    1,
  );
  assert.equal(await db.$count(clientGuestSeats, eq(clientGuestSeats.userId, guest.id)), 1);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("bundled board invite acceptance crossing the free guest board cap consumes one pooled seat (block-until-buy when full)", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  const app = await buildIntegrationServer();
  try {
    const ownerSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Bundled Paid Guest Host",
        email: "bundled-paid-guest-owner@example.com",
        password: "Abc12345",
        displayName: "Host Owner",
      },
    });
    assert.equal(ownerSignup.statusCode, 200);
    const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();

    const wsCreated = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Host Workspace" },
    });
    assert.equal(wsCreated.statusCode, 201);
    const workspace = wsCreated.json<WorkspaceResponse>();

    const workspaceBoards = await db
      .insert(boards)
      .values([
        { workspaceId: workspace.id, name: "Shared One", position: "1000.0000000000" },
        { workspaceId: workspace.id, name: "Shared Two", position: "2000.0000000000" },
        { workspaceId: workspace.id, name: "Shared Three", position: "3000.0000000000" },
      ])
      .returning();
    assert.equal(workspaceBoards.length, 3);

    const invite = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/guests/invitations`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { boardId: workspaceBoards[0]!.id, email: "bundled-paid-guest@external.test", role: "editor" },
    });
    assert.equal(invite.statusCode, 201, invite.body);
    const invitationId = invite.json<{ invite: { id: string } }>().invite.id;

    for (const board of workspaceBoards.slice(1)) {
      const addBoard = await app.inject({
        method: "POST",
        url: `/workspaces/${workspace.id}/guests/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { boardId: board.id, email: "bundled-paid-guest@external.test", role: "observer" },
      });
      assert.equal(addBoard.statusCode, 201, addBoard.body);
      assert.equal(addBoard.json<{ invite: { id: string } }>().invite.id, invitationId);
      assert.equal(typeof addBoard.json<{ token?: string }>().token, "string");
    }

    const guestSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Bundled Paid Guest External",
        email: "bundled-paid-guest@external.test",
        password: "Abc12345",
        displayName: "External Guest",
      },
    });
    assert.equal(guestSignup.statusCode, 200);
    const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();

    // Pool full (seat_limit 1, just the owner): accepting a bundle that crosses the free cap is blocked
    // entirely — no board lands and no seat is created.
    await db.update(clients).set({ billingStatus: "active", seatLimit: 1 }).where(eq(clients.id, owner.clientId));
    const blocked = await app.inject({
      method: "POST",
      url: `/board-invitations/${invitationId}/accept`,
      headers: { authorization: `Bearer ${guestToken}` },
    });
    assert.equal(blocked.statusCode, 402);
    assert.equal(blocked.json<{ code: string }>().code, "SEAT_LIMIT_REACHED");
    assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, guest.id)), 0);
    assert.equal(await db.$count(clientGuestSeats, eq(clientGuestSeats.userId, guest.id)), 0);

    // Buy a seat (1 → 2): the whole 3-board bundle now lands on a single pooled guest seat.
    await db.update(clients).set({ seatLimit: 2 }).where(eq(clients.id, owner.clientId));
    const accept = await app.inject({
      method: "POST",
      url: `/board-invitations/${invitationId}/accept`,
      headers: { authorization: `Bearer ${guestToken}` },
    });
    assert.equal(accept.statusCode, 200, accept.body);
    assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, guest.id)), 3);
    assert.equal(await db.$count(clientGuestSeats, eq(clientGuestSeats.userId, guest.id)), 1);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("trial host accepting a bundled guest invite beyond the free guest cap records a guest seat without pool blocking", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  const app = await buildIntegrationServer();
  try {
    const ownerSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Trial Paid Guest Host",
        email: "trial-paid-guest-owner@example.com",
        password: "Abc12345",
        displayName: "Host Owner",
      },
    });
    assert.equal(ownerSignup.statusCode, 200);
    const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();
    await db.update(clients).set({ seatLimit: 1 }).where(eq(clients.id, owner.clientId));

    const wsCreated = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Trial Host Workspace" },
    });
    assert.equal(wsCreated.statusCode, 201);
    const workspace = wsCreated.json<WorkspaceResponse>();

    const workspaceBoards = await db
      .insert(boards)
      .values([
        { workspaceId: workspace.id, name: "Trial Shared One", position: "1000.0000000000" },
        { workspaceId: workspace.id, name: "Trial Shared Two", position: "2000.0000000000" },
        { workspaceId: workspace.id, name: "Trial Shared Three", position: "3000.0000000000" },
      ])
      .returning();
    assert.equal(workspaceBoards.length, 3);

    const invite = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/guests/invitations`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { boardId: workspaceBoards[0]!.id, email: "trial-paid-guest@external.test", role: "editor" },
    });
    assert.equal(invite.statusCode, 201, invite.body);
    const invitationId = invite.json<{ invite: { id: string } }>().invite.id;

    for (const board of workspaceBoards.slice(1)) {
      const addBoard = await app.inject({
        method: "POST",
        url: `/workspaces/${workspace.id}/guests/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { boardId: board.id, email: "trial-paid-guest@external.test", role: "observer" },
      });
      assert.equal(addBoard.statusCode, 201, addBoard.body);
      assert.equal(addBoard.json<{ invite: { id: string } }>().invite.id, invitationId);
    }

    const guestSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Trial Paid Guest External",
        email: "trial-paid-guest@external.test",
        password: "Abc12345",
        displayName: "External Guest",
      },
    });
    assert.equal(guestSignup.statusCode, 200);
    const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();

    const accept = await app.inject({
      method: "POST",
      url: `/board-invitations/${invitationId}/accept`,
      headers: { authorization: `Bearer ${guestToken}` },
    });
    assert.equal(accept.statusCode, 200, accept.body);
    assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, guest.id)), 3);
    assert.equal(await db.$count(clientGuestSeats, eq(clientGuestSeats.userId, guest.id)), 1);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("crossing the free guest cap consumes a pooled seat without charging Stripe", async () => {
  const previous = {
    mode: env.KANERA_DEPLOYMENT_MODE,
    secret: env.STRIPE_SECRET_KEY,
  };
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_fake";
  let updateCount = 0;
  setStripeClientForTests({
    subscriptionItems: {
      retrieve: async () => ({ id: "si_guest_seat", quantity: 1 }),
      update: async () => {
        updateCount += 1;
        return { id: "si_guest_seat" };
      },
    },
  } as never);
  const app = await buildIntegrationServer();
  try {
    const ownerSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Paid Guest Seat Host",
        email: "paid-guest-seat-owner@example.com",
        password: "Abc12345",
        displayName: "Host Owner",
      },
    });
    assert.equal(ownerSignup.statusCode, 200);
    const { accessToken: ownerToken, user: owner } = ownerSignup.json<SignupResponse>();
    // Active org with room in its purchased pool (5 seats; only the owner is assigned).
    await db
      .update(clients)
      .set({ billingStatus: "active", stripeSubscriptionItemId: "si_guest_seat", seatLimit: 5 })
      .where(eq(clients.id, owner.clientId));

    const wsCreated = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Host Workspace" },
    });
    assert.equal(wsCreated.statusCode, 201);
    const workspace = wsCreated.json<WorkspaceResponse>();

    const workspaceBoards = await db
      .insert(boards)
      .values([
        { workspaceId: workspace.id, name: "Shared One", position: "1000.0000000000" },
        { workspaceId: workspace.id, name: "Shared Two", position: "2000.0000000000" },
        { workspaceId: workspace.id, name: "Shared Three", position: "3000.0000000000" },
      ])
      .returning();

    const guestSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Paid Guest Seat External",
        email: "paid-guest-seat-external@external.test",
        password: "Abc12345",
        displayName: "External Guest",
      },
    });
    assert.equal(guestSignup.statusCode, 200);
    const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();

    await db.insert(boardMembers).values([
      { boardId: workspaceBoards[0]!.id, userId: guest.id, role: "editor" },
      { boardId: workspaceBoards[1]!.id, userId: guest.id, role: "observer" },
    ]);
    const [thirdBoardInvitation] = await db
      .insert(boardInvitations)
      .values({
        clientId: owner.clientId,
        boardId: workspaceBoards[2]!.id,
        email: "paid-guest-seat-external@external.test",
        role: "editor",
        tokenHash: "paid-guest-seat-token",
        invitedById: owner.id,
      })
      .returning();
    assert.ok(thirdBoardInvitation);
    await db.insert(boardInvitationGrants).values({
      invitationId: thirdBoardInvitation.id,
      boardId: workspaceBoards[2]!.id,
      role: "editor",
    });

    const accept = await app.inject({
      method: "POST",
      url: `/board-invitations/${thirdBoardInvitation.id}/accept`,
      headers: { authorization: `Bearer ${guestToken}` },
    });
    assert.equal(accept.statusCode, 200, accept.body);
    // The pooled seat is consumed from pre-purchased capacity: no Stripe quantity change and no
    // per-guest billing email (capacity is charged separately via the buy-seats flow).
    assert.equal(updateCount, 0);
    assert.equal(await db.$count(clientGuestSeats, eq(clientGuestSeats.userId, guest.id)), 1);
    const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "seat_billed"));
    assert.equal(rows.length, 0);
  } finally {
    setStripeClientForTests(null);
    env.KANERA_DEPLOYMENT_MODE = previous.mode;
    env.STRIPE_SECRET_KEY = previous.secret;
  }
});

void test("self-hosted mode allows a cross-org guest to join more than two boards", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "self_hosted";
  const app = await buildIntegrationServer();
  try {
    const ownerSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Self Hosted Guest Limit Host",
        email: "self-hosted-guest-limit-owner@example.com",
        password: "Abc12345",
        displayName: "Host Owner",
      },
    });
    assert.equal(ownerSignup.statusCode, 200);
    const { accessToken: ownerToken } = ownerSignup.json<SignupResponse>();

    const wsCreated = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Host Workspace" },
    });
    assert.equal(wsCreated.statusCode, 201);
    const workspace = wsCreated.json<WorkspaceResponse>();

    const workspaceBoards = await db
      .insert(boards)
      .values([
        { workspaceId: workspace.id, name: "Shared One", position: "1000.0000000000" },
        { workspaceId: workspace.id, name: "Shared Two", position: "2000.0000000000" },
        { workspaceId: workspace.id, name: "Shared Three", position: "3000.0000000000" },
      ])
      .returning();
    assert.equal(workspaceBoards.length, 3);

    const guestSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Self Hosted Guest Limit External",
        email: "self-hosted-guest-limit-external@external.test",
        password: "Abc12345",
        displayName: "External Guest",
      },
    });
    assert.equal(guestSignup.statusCode, 200);
    const { user: guest } = guestSignup.json<SignupResponse>();

    await db.insert(boardMembers).values([
      { boardId: workspaceBoards[0]!.id, userId: guest.id, role: "editor" },
      { boardId: workspaceBoards[1]!.id, userId: guest.id, role: "observer" },
    ]);

    const invite = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/guests/invitations`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { boardId: workspaceBoards[2]!.id, email: "self-hosted-guest-limit-external@external.test", role: "editor" },
    });
    assert.equal(invite.statusCode, 201);

    const memberships = await db.select().from(boardMembers).where(eq(boardMembers.userId, guest.id));
    assert.equal(memberships.length, 3);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("cards cannot be assigned to observers", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Assignable",
      email: "assignable-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [ownerRow] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.id, owner.id)).limit(1);
  assert.ok(ownerRow);
  const [observer] = await db
    .insert(users)
    .values({
      clientId: ownerRow.clientId,
      email: "assignee-observer@example.com",
      passwordHash: "hash",
      displayName: "Assignee Observer",
      clientRole: "member",
    })
    .returning();
  assert.ok(observer);

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Guard assignment",
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);
  const [checklist] = await db.insert(cardChecklists).values({ cardId: card.id, title: "Steps", position: "1000.0000000000" }).returning();
  assert.ok(checklist);
  const [item] = await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "Review", position: "1000.0000000000" }).returning();
  assert.ok(item);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: observer.id, role: "member" });

  const headers = { authorization: `Bearer ${accessToken}` };
  const assignCard = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers,
    payload: { userIds: [observer.id] },
  });
  assert.equal(assignCard.statusCode, 400);

  const assignChecklistItem = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers,
    payload: { assigneeId: observer.id },
  });
  assert.equal(assignChecklistItem.statusCode, 400);

  const assignments = await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id));
  assert.equal(assignments.length, 0);
  const [unchangedItem] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.id, item.id)).limit(1);
  assert.equal(unchangedItem?.assigneeId, null);
});

void test("recent completed cards stay in board payloads while older completed cards require explicit include", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Complete",
      email: "complete-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({
      listId: list!.id,
      boardId: board!.id,
      title: "Finish me",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();

  const completed = await app.inject({
    method: "PATCH",
    url: `/cards/${card!.id}/completion`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);
  assert.ok(completed.json<{ completedAt: string | null }>().completedAt);

  const defaultRes = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(defaultRes.statusCode, 200);
  assert.equal(defaultRes.json<BoardResponse>().cards.some((c) => c.id === card!.id), true);

  await db.update(cards).set({ completedAt: new Date("2026-01-01T10:00:00.000Z") }).where(eq(cards.id, card!.id));

  const oldDefaultRes = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(oldDefaultRes.statusCode, 200);
  assert.equal(oldDefaultRes.json<BoardResponse>().cards.some((c) => c.id === card!.id), false);

  const includeRes = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open?includeCompleted=true`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(includeRes.statusCode, 200);
  const included = includeRes.json<BoardResponse>().cards.find((c) => c.id === card!.id);
  assert.ok(included);
  assert.ok(included.completedAt);

  const [activeCard] = await db
    .insert(cards)
    .values({
      listId: list!.id,
      boardId: board!.id,
      title: "Still active",
      position: "2000.0000000000",
      createdById: user.id,
    })
    .returning();

  const rangeRes = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open?completedFrom=2026-01-01&completedTo=2026-01-01`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(rangeRes.statusCode, 200);
  assert.equal(rangeRes.json<BoardResponse>().cards.some((c) => c.id === card!.id), true);
  assert.equal(rangeRes.json<BoardResponse>().cards.some((c) => c.id === activeCard!.id), true);

  const outsideRangeRes = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open?completedFrom=2026-01-02&completedTo=2026-01-03`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(outsideRangeRes.statusCode, 200);
  assert.equal(outsideRangeRes.json<BoardResponse>().cards.some((c) => c.id === card!.id), false);
  assert.equal(outsideRangeRes.json<BoardResponse>().cards.some((c) => c.id === activeCard!.id), true);

  await db.update(cards).set({ archivedAt: new Date("2026-01-04T10:00:00.000Z") }).where(eq(cards.id, card!.id));
  const archivedRangeRes = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open?archived=true&completedFrom=2026-01-01&completedTo=2026-01-01`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(archivedRangeRes.statusCode, 200);
  assert.equal(archivedRangeRes.json<BoardResponse>().cards.some((c) => c.id === card!.id), true);
  assert.equal(archivedRangeRes.json<BoardResponse>().cards.some((c) => c.id === activeCard!.id), false);

  // The archived view (no completed range) must surface every archived card regardless of how
  // long ago it was completed — the completed-age cutoff only governs the active board.
  const archivedNoRangeRes = await app.inject({
    method: "POST",
    url: `/boards/${board!.id}/open?archived=true`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(archivedNoRangeRes.statusCode, 200);
  assert.equal(archivedNoRangeRes.json<BoardResponse>().cards.some((c) => c.id === card!.id), true);
});

void test("board completed cards endpoint filters by date and list, paginates, and excludes archived cards", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "completed-history-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();
  const [todo] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(todo);
  const [done] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Done", position: "2000.0000000000" })
    .returning();
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();

  const completedAt = [
    new Date("2026-05-24T10:00:00.000Z"),
    new Date("2026-05-23T10:00:00.000Z"),
    new Date("2026-04-20T10:00:00.000Z"),
  ];
  const inserted = await db
    .insert(cards)
    .values([
      { listId: todo!.id, boardId: board!.id, title: "Newest", position: "1000.0000000000", completedAt: completedAt[0], createdById: user.id },
      { listId: done!.id, boardId: board!.id, title: "Middle", position: "2000.0000000000", completedAt: completedAt[1], createdById: user.id },
      { listId: todo!.id, boardId: board!.id, title: "Older", position: "3000.0000000000", completedAt: completedAt[2], createdById: user.id },
      { listId: todo!.id, boardId: board!.id, title: "Archived", position: "4000.0000000000", completedAt: completedAt[0], archivedAt: new Date("2026-05-25T10:00:00.000Z"), createdById: user.id },
      { listId: todo!.id, boardId: board!.id, title: "Open", position: "5000.0000000000", createdById: user.id },
    ])
    .returning();

  const firstPage = await app.inject({
    method: "GET",
    url: `/boards/${board!.id}/completed?limit=1`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(firstPage.statusCode, 200);
  const first = firstPage.json<{ cards: BoardCardSummaryResponse[]; nextCursor: string | null }>();
  assert.deepEqual(first.cards.map((card) => card.id), [inserted[0]!.id]);
  assert.ok(first.nextCursor);

  const secondPage = await app.inject({
    method: "GET",
    url: `/boards/${board!.id}/completed?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(secondPage.statusCode, 200);
  const second = secondPage.json<{ cards: BoardCardSummaryResponse[]; nextCursor: string | null }>();
  assert.deepEqual(second.cards.map((card) => card.id), [inserted[1]!.id, inserted[2]!.id]);
  assert.equal(second.nextCursor, null);

  const filtered = await app.inject({
    method: "GET",
    url: `/boards/${board!.id}/completed?from=2026-05-01T00%3A00%3A00.000Z&to=2026-05-23T23%3A59%3A59.999Z&listId=${done!.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(filtered.json<{ cards: BoardCardSummaryResponse[] }>().cards.map((card) => card.id), [inserted[1]!.id]);
});

void test("board open returns workspace boards and rejects unauthenticated requests", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Boards",
      email: "boards-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const firstOpen = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/open`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(firstOpen.statusCode, 200);

  const refreshOpen = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/open`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(refreshOpen.statusCode, 200);

  const secondOpen = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/open`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(secondOpen.statusCode, 200);

  const [deniedBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Private", position: "2000.0000000000" })
    .returning();
  assert.ok(deniedBoard);

  const denied = await app.inject({
    method: "POST",
    url: `/boards/${deniedBoard.id}/open`,
    payload: {},
  });
  assert.equal(denied.statusCode, 401);
});

void test("bulk list completion updates every non-archived card in the workspace list", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Bulk",
      email: "bulk-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [firstBoard, secondBoard] = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "A", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "B", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(firstBoard);
  assert.ok(secondBoard);
  const [firstCard, secondCard, archivedCard] = await db
    .insert(cards)
    .values([
      { listId: list!.id, boardId: firstBoard.id, title: "One", position: "1000.0000000000", createdById: user.id },
      { listId: list!.id, boardId: secondBoard.id, title: "Two", position: "1000.0000000000", createdById: user.id },
      { listId: list!.id, boardId: firstBoard.id, title: "Old", position: "2000.0000000000", archivedAt: new Date(), createdById: user.id },
    ])
    .returning();
  assert.ok(firstCard);
  assert.ok(secondCard);
  assert.ok(archivedCard);

  const res = await app.inject({
    method: "POST",
    url: `/boards/${firstBoard.id}/lists/${list!.id}/cards/completion`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { completed: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ updated: number }>().updated, 2);

  const rows = await db.select().from(cards);
  assert.ok(rows.find((c) => c.id === firstCard.id)?.completedAt);
  assert.ok(rows.find((c) => c.id === secondCard.id)?.completedAt);
  assert.equal(rows.find((c) => c.id === archivedCard.id)?.completedAt, null);
});

void test("bulk moving cards places the batch at the top of the target list", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Bulk Top Lists",
      email: "bulk-top-list-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const [todo] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(todo);
  const [doing] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Doing", position: "2000.0000000000" })
    .returning();
  assert.ok(doing);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [firstCard, secondCard, existingTarget] = await db
    .insert(cards)
    .values([
      { listId: todo.id, boardId: board.id, title: "One", position: "1000.0000000000", createdById: user.id },
      { listId: todo.id, boardId: board.id, title: "Two", position: "2000.0000000000", createdById: user.id },
      { listId: doing.id, boardId: board.id, title: "Already doing", position: "1000.0000000000", createdById: user.id },
    ])
    .returning();
  assert.ok(firstCard);
  assert.ok(secondCard);
  assert.ok(existingTarget);

  const moved = await app.inject({
    method: "POST",
    url: `/lists/${todo.id}/cards/move`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { targetListId: doing.id },
  });
  assert.equal(moved.statusCode, 200);

  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.listId, doing.id))
    .orderBy(asc(cards.position));
  assert.deepEqual(rows.map((row) => row.id), [firstCard.id, secondCard.id, existingTarget.id]);
});

void test("board deletion impact counts active, completed, and archived cards", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Board Impact",
      email: "owner-board-impact@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  const { accessToken, user } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspaceResponse = await app.inject({
    method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" },
  });
  const workspace = workspaceResponse.json<WorkspaceResponse>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  const [board] = await db.insert(boards).values({
    workspaceId: workspace.id, name: "Board", position: "1000.0000000000",
  }).returning();
  assert.ok(list && board);
  await db.insert(cards).values([
    { listId: list.id, boardId: board.id, title: "Active", position: "1000.0000000000", createdById: user.id },
    { listId: list.id, boardId: board.id, title: "Completed", position: "2000.0000000000", createdById: user.id, completedAt: new Date() },
    { listId: list.id, boardId: board.id, title: "Archived", position: "3000.0000000000", createdById: user.id, archivedAt: new Date() },
  ]);

  const impact = await app.inject({ method: "GET", url: `/boards/${board.id}/deletion-impact`, headers: auth });

  assert.equal(impact.statusCode, 200);
  assert.deepEqual(impact.json(), { cardCount: 3 });
});
