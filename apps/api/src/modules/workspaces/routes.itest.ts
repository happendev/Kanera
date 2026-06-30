import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import { boardInvitationGrants, boardInvitations, boardMembers, boardWatchers, boards, cardAssignees, cardMentions, cardWatchers, cards, clientGuestSeats, clients, customFields, directRealtimeOutbox, lists, notifications, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import { DEFAULT_WORKSPACE_CUSTOM_FIELDS } from "@kanera/shared/default-workspace-custom-fields";
import { DEFAULT_WORKSPACE_LABELS } from "@kanera/shared/default-workspace-labels";
import { DEFAULT_WORKSPACE_LIST_NAMES } from "@kanera/shared/default-workspace-lists";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { setStripeClientForTests } from "../../lib/billing.js";
import { buildIntegrationServer } from "../../test/integration.js";

const position = (index: number) => `${(index + 1) * 1000}.0000000000`;
type SignupResponse = { accessToken: string; user: { id: string; clientId: string; hasWorkspace: boolean } };
type WorkspaceResponse = { id: string; clientId: string };
type WorkspaceGuestsResponse = {
  acceptedGuests: { userId: string }[];
  boards: { id: string }[];
  pendingInvites?: { id: string; boards?: { boardId: string }[] }[];
};
type GuestInviteResponse = { status: "added" | "invited"; token?: string; invite?: { id: string; boards?: { boardId: string }[] } };
type DueSlot = "anyTime" | "morning" | "afternoon" | "endOfWorkDay";

function utcLocalDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

void test("POST /workspaces creates workspace-scoped defaults and owner membership", async () => {
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
  assert.equal(user.hasWorkspace, false);

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [ownerMembership] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspace.id));
  assert.equal(ownerMembership?.userId, user.id);
  assert.equal(ownerMembership?.role, "owner");

  const workspaceResponse = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(workspaceResponse.statusCode, 200);
  const body = workspaceResponse.json();

  assert.deepEqual(
    body.lists.map((list: { name: string; position: string }) => [list.name, list.position]),
    DEFAULT_WORKSPACE_LIST_NAMES.map((name, index) => [name, position(index)]),
  );
  assert.deepEqual(
    body.customFields.map((field: { name: string; icon: string; type: string; position: string }) => [
      field.name,
      field.icon,
      field.type,
      field.position,
    ]),
    DEFAULT_WORKSPACE_CUSTOM_FIELDS.map((field, index) => [field.name, field.icon, field.type, position(index)]),
  );
  assert.deepEqual(
    body.cardLabels.map((label: { name: string; color: string; position: string }) => [
      label.name,
      label.color,
      label.position,
    ]),
    DEFAULT_WORKSPACE_LABELS.map((label, index) => [label.name, label.color, position(index)]),
  );

  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id));
  const workspaceFields = await db.select().from(customFields).where(eq(customFields.workspaceId, workspace.id));
  assert.equal(workspaceLists.length, DEFAULT_WORKSPACE_LIST_NAMES.length);
  assert.equal(workspaceFields.length, DEFAULT_WORKSPACE_CUSTOM_FIELDS.length);
});

void test("adding a workspace member emits directly to the newly added user", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Workspace Add Realtime Org",
      email: "workspace-add-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Realtime Workspace" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [member] = await db
    .insert(users)
    .values({
      clientId: user.clientId,
      email: "workspace-add-member@example.com",
      passwordHash: "hash",
      displayName: "Member",
      clientRole: "member",
    })
    .returning();
  assert.ok(member);

  const add = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/members`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { userId: member.id, role: "editor" },
  });
  assert.equal(add.statusCode, 200);

  let directRows: { userId: string | null; eventType: string; payload: unknown }[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    directRows = await db
      .select({ userId: directRealtimeOutbox.userId, eventType: directRealtimeOutbox.eventType, payload: directRealtimeOutbox.payload })
      .from(directRealtimeOutbox)
      .where(and(eq(directRealtimeOutbox.scope, "user"), eq(directRealtimeOutbox.userId, member.id), eq(directRealtimeOutbox.eventType, "workspace:member:added")));
    if (directRows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(directRows.length, 1);
  const payload = directRows[0]!.payload as { workspaceId: string; member: { workspaceId: string; userId: string; role: string; email: string; displayName: string } };
  assert.equal(payload.workspaceId, workspace.id);
  assert.equal(payload.member.workspaceId, workspace.id);
  assert.equal(payload.member.userId, member.id);
  assert.equal(payload.member.role, "editor");
  assert.equal(payload.member.email, "workspace-add-member@example.com");
  assert.equal(payload.member.displayName, "Member");
});

void test("removing a workspace member clears live board access, assignments, watches, mentions, and workspace notifications", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Workspace Remove Cleanup Org",
      email: "workspace-remove-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Cleanup Workspace" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [member] = await db
    .insert(users)
    .values({
      clientId: user.clientId,
      email: "workspace-remove-member@example.com",
      passwordHash: "hash",
      displayName: "Member",
      clientRole: "member",
    })
    .returning();
  assert.ok(member);
  const [boardRow] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Private Board", position: "1000.0000000000", visibility: "private" }).returning();
  const [list] = await db.insert(lists).values({ workspaceId: workspace.id, name: "Todo", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({ boardId: boardRow!.id, listId: list!.id, title: "Assigned", position: "1000.0000000000", createdById: user.id }).returning();
  const [otherWorkspace] = await db.insert(workspaces).values({ clientId: user.clientId, name: "Other Workspace" }).returning();
  const [otherBoard] = await db.insert(boards).values({ workspaceId: otherWorkspace!.id, name: "Other Board", position: "1000.0000000000" }).returning();
  const [otherList] = await db.insert(lists).values({ workspaceId: otherWorkspace!.id, name: "Todo", position: "1000.0000000000" }).returning();
  const [otherCard] = await db.insert(cards).values({ boardId: otherBoard!.id, listId: otherList!.id, title: "Still visible", position: "1000.0000000000", createdById: user.id }).returning();

  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "editor" });
  await db.insert(workspaceMembers).values({ workspaceId: otherWorkspace!.id, userId: member.id, role: "editor" });
  await db.insert(boardMembers).values({ boardId: boardRow!.id, userId: member.id, role: "editor" });
  await db.insert(boardWatchers).values({ boardId: boardRow!.id, userId: member.id });
  await db.insert(cardAssignees).values({ cardId: card!.id, userId: member.id });
  await db.insert(cardWatchers).values({ cardId: card!.id, userId: member.id });
  await db.insert(cardMentions).values({ cardId: card!.id, userId: member.id, source: "description" });
  const [removedWorkspaceNotification] = await db.insert(notifications).values({
    userId: member.id,
    cardId: card!.id,
    listId: list!.id,
    boardId: boardRow!.id,
    workspaceId: workspace.id,
    reason: "assigned",
  }).returning();
  const [retainedWorkspaceNotification] = await db.insert(notifications).values({
    userId: member.id,
    cardId: otherCard!.id,
    listId: otherList!.id,
    boardId: otherBoard!.id,
    workspaceId: otherWorkspace!.id,
    reason: "assigned",
  }).returning();

  const removed = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(await db.$count(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, member.id))), 0);
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, boardRow!.id), eq(boardMembers.userId, member.id))), 0);
  assert.equal(await db.$count(boardWatchers, and(eq(boardWatchers.boardId, boardRow!.id), eq(boardWatchers.userId, member.id))), 0);
  assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, card!.id), eq(cardAssignees.userId, member.id))), 0);
  assert.equal(await db.$count(cardWatchers, and(eq(cardWatchers.cardId, card!.id), eq(cardWatchers.userId, member.id))), 0);
  assert.equal(await db.$count(cardMentions, and(eq(cardMentions.cardId, card!.id), eq(cardMentions.userId, member.id))), 0);
  assert.equal(await db.$count(notifications, eq(notifications.id, removedWorkspaceNotification!.id)), 0);
  assert.equal(await db.$count(notifications, eq(notifications.id, retainedWorkspaceNotification!.id)), 1);
  let notificationReadRows: { payload: unknown }[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    notificationReadRows = await db
      .select({ payload: directRealtimeOutbox.payload })
      .from(directRealtimeOutbox)
      .where(and(eq(directRealtimeOutbox.scope, "user"), eq(directRealtimeOutbox.userId, member.id), eq(directRealtimeOutbox.eventType, "notification:read")));
    if (notificationReadRows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(notificationReadRows.some((row) => {
    const payload = row.payload as { notificationIds?: string[] };
    return payload.notificationIds?.includes(removedWorkspaceNotification!.id) === true
      && payload.notificationIds.includes(retainedWorkspaceNotification!.id) === false;
  }));

  const readded = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/members`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { userId: member.id, role: "editor" },
  });
  assert.equal(readded.statusCode, 200);
  assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, card!.id), eq(cardAssignees.userId, member.id))), 0);
});

void test("POST /workspaces can create an initial board for onboarding", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Starter Co",
      email: "starter@example.com",
      password: "Abc12345",
      displayName: "Starter",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: "Client Delivery",
      initialBoard: { name: "Acme", icon: "building" },
      lists: [
        { name: "Incoming", icon: "inbox" },
        { name: "Complete", icon: "circle-check" },
      ],
    },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json<WorkspaceResponse & { initialBoard: { id: string; name: string; icon: string | null; workspaceId: string; visibility: string } }>();

  assert.equal(body.initialBoard.name, "Acme");
  assert.equal(body.initialBoard.icon, "building");
  assert.equal(body.initialBoard.workspaceId, body.id);
  assert.equal(body.initialBoard.visibility, "workspace");

  const [row] = await db.select().from(boards).where(eq(boards.id, body.initialBoard.id));
  assert.equal(row?.name, "Acme");
  assert.equal(row?.workspaceId, body.id);

  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, body.id));
  assert.deepEqual(
    workspaceLists.map((list) => [list.name, list.icon]),
    [
      ["Incoming", "inbox"],
      ["Complete", "circle-check"],
    ],
  );
});

void test("GET /home/boards overdue stats ignore completed cards", async () => {
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

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Public", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  const [completedOverdue] = await db
    .insert(cards)
    .values({
      listId: list!.id,
      boardId: board!.id,
      title: "Done late",
      position: "1000.0000000000",
      createdById: user.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      completedAt: new Date("2026-05-21T10:00:00.000Z"),
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: completedOverdue!.id, userId: user.id });

  const home = await app.inject({
    method: "GET",
    url: "/home/boards",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(home.statusCode, 200);
  const homeBody = home.json<{ groups: { boards: { id: string; myOverdue: number }[] }[] }>();
  const homeBoard = homeBody.groups[0]?.boards.find((b) => b.id === board!.id);
  assert.ok(homeBoard);
  assert.equal(homeBoard.myOverdue, 0);
});

void test("GET /home/boards includes assigned cards due today and tomorrow in due-soon order", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Due Soon",
      email: "due-soon-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Alpha Board", icon: "rocket", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(board);

  const today = utcLocalDate(new Date());
  const [yearString, monthString, dayString] = today.split("-");
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);
  const tomorrowDate = new Date(Date.UTC(year, month - 1, day + 1));
  const tomorrow = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrowDate.getUTCDate()).padStart(2, "0")}`;
  const laterDate = new Date(Date.UTC(year, month - 1, day + 2));
  const later = `${laterDate.getUTCFullYear()}-${String(laterDate.getUTCMonth() + 1).padStart(2, "0")}-${String(laterDate.getUTCDate()).padStart(2, "0")}`;

  async function insertCard(
    title: string,
    dueDateLocalDate: string,
    dueDateSlot: DueSlot | null,
    options: { assigned?: boolean; completed?: boolean; archived?: boolean; boardId?: string; listId?: string } = {},
  ) {
    const [card] = await db
      .insert(cards)
      .values({
        listId: options.listId ?? list!.id,
        boardId: options.boardId ?? board!.id,
        title,
        position: "1000.0000000000",
        createdById: user.id,
        dueDateLocalDate,
        dueDateSlot,
        dueDateTimezone: "UTC",
        completedAt: options.completed ? new Date() : null,
        archivedAt: options.archived ? new Date() : null,
      })
      .returning();
    assert.ok(card);
    if (options.assigned ?? true) await db.insert(cardAssignees).values({ cardId: card.id, userId: user.id });
    return card;
  }

  await insertCard("Today any time", today, "anyTime");
  await insertCard("Today morning", today, "morning");
  await insertCard("Tomorrow morning", tomorrow, "morning");
  await insertCard("Later", later, "morning");
  await insertCard("Unassigned", today, "morning", { assigned: false });
  await insertCard("Completed", today, "morning", { completed: true });
  await insertCard("Archived", today, "morning", { archived: true });

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Host Due Soon",
      email: "due-soon-host@example.com",
      password: "Abc12345",
      displayName: "Host",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken } = hostSignup.json<SignupResponse>();
  const hostWorkspaceResponse = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(hostWorkspaceResponse.statusCode, 201);
  const hostWorkspace = hostWorkspaceResponse.json<WorkspaceResponse>();
  const [hostList] = await db.select().from(lists).where(eq(lists.workspaceId, hostWorkspace.id)).limit(1);
  assert.ok(hostList);
  const [guestBoard] = await db
    .insert(boards)
    .values({ workspaceId: hostWorkspace.id, name: "Guest Board", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(guestBoard);
  await db.insert(boardMembers).values({ boardId: guestBoard.id, userId: user.id, role: "editor" });
  await insertCard("Guest tomorrow afternoon", tomorrow, "afternoon", { boardId: guestBoard.id, listId: hostList!.id });

  const [inaccessibleBoard] = await db
    .insert(boards)
    .values({ workspaceId: hostWorkspace.id, name: "Hidden Board", position: "2000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(inaccessibleBoard);
  await insertCard("Inaccessible", today, "morning", { boardId: inaccessibleBoard.id, listId: hostList!.id });

  const home = await app.inject({
    method: "GET",
    url: "/home/boards",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(home.statusCode, 200);
  const body = home.json<{ dueSoon: { title: string; boardName: string; boardIcon: string | null; dueDateLocalDate: string; dueDateSlot: string | null }[] }>();

  assert.deepEqual(body.dueSoon.map((card) => card.title), [
    "Today morning",
    "Today any time",
    "Tomorrow morning",
    "Guest tomorrow afternoon",
  ]);
  assert.deepEqual(body.dueSoon.map((card) => card.boardName), [
    "Alpha Board",
    "Alpha Board",
    "Alpha Board",
    "Guest Board",
  ]);
  assert.deepEqual(body.dueSoon.map((card) => card.boardIcon), [
    "rocket",
    "rocket",
    "rocket",
    null,
  ]);
  assert.deepEqual(body.dueSoon.map((card) => [card.dueDateLocalDate, card.dueDateSlot]), [
    [today, "morning"],
    [today, "anyTime"],
    [tomorrow, "morning"],
    [tomorrow, "afternoon"],
  ]);
});

void test("workspace guest management lists, invites, revokes, and removes external board guests", async () => {
  const app = await buildIntegrationServer();

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Host Guests",
      email: "host-guests-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken, user: hostUser } = hostSignup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Guest Board", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(board);

  const externalSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "External Org",
      email: "external-guest-settings@external.test",
      password: "Abc12345",
      displayName: "External Guest",
    },
  });
  assert.equal(externalSignup.statusCode, 200);
  const { user: externalUser } = externalSignup.json<SignupResponse>();

  const sameOrgUser = await db
    .insert(users)
    .values({
      clientId: hostUser.clientId,
      email: "same-org-board-member@example.com",
      passwordHash: "hash",
      displayName: "Same Org",
      clientRole: "member",
    })
    .returning();
  assert.ok(sameOrgUser[0]);
  await db.insert(boardMembers).values([
    { boardId: board.id, userId: externalUser.id, role: "editor" },
    { boardId: board.id, userId: sameOrgUser[0]!.id, role: "editor" },
  ]);

  const initial = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/guests`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(initial.statusCode, 200);
  const initialBody = initial.json<WorkspaceGuestsResponse>();
  assert.equal(initialBody.acceptedGuests.length, 1);
  assert.equal(initialBody.acceptedGuests[0]?.userId, externalUser.id);
  assert.equal(initialBody.boards.some((b) => b.id === board.id), true);

  const adminInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "admin-board-guest@example.com", role: "admin" },
  });
  assert.equal(adminInvite.statusCode, 400);

  const ownerDomainInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "contractor@example.com", role: "editor" },
  });
  assert.equal(ownerDomainInvite.statusCode, 400);
  assert.match(ownerDomainInvite.json<{ message: string }>().message, /owner email domain/);

  const pending = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "pending-board-guest@external.test", role: "observer" },
  });
  assert.equal(pending.statusCode, 201);
  const pendingBody = pending.json<GuestInviteResponse>();
  assert.equal(pendingBody.status, "invited");
  assert.equal(typeof pendingBody.token, "string");
  const [invite] = await db.select().from(boardInvitations).where(eq(boardInvitations.email, "pending-board-guest@external.test")).limit(1);
  assert.ok(invite);

  const duplicatePending = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "pending-board-guest@external.test", role: "observer" },
  });
  assert.equal(duplicatePending.statusCode, 409);
  const pendingInviteRows = await db.select().from(boardInvitations).where(eq(boardInvitations.email, "pending-board-guest@external.test"));
  assert.equal(pendingInviteRows.length, 1);

  const revoke = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/invitations/${invite.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(revoke.statusCode, 204);

  const remove = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/${board.id}/${externalUser.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(remove.statusCode, 200);
  assert.equal(remove.json<{ paidGuestSeatRemoved: boolean }>().paidGuestSeatRemoved, false);

  const after = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/guests`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json<WorkspaceGuestsResponse>().acceptedGuests.length, 0);
});

void test("workspace guest invitations reuse one pending invite per email and acceptance grants all boards", async () => {
  const app = await buildIntegrationServer();

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Bundled Guest Host",
      email: "bundled-guest-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken } = hostSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const workspaceBoards = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "Board A", position: "1000.0000000000", visibility: "workspace" },
      { workspaceId: workspace.id, name: "Board B", position: "2000.0000000000", visibility: "workspace" },
    ])
    .returning();
  assert.equal(workspaceBoards.length, 2);

  const firstInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[0]!.id, email: "bundled-guest@external.test", role: "observer" },
  });
  assert.equal(firstInvite.statusCode, 201, firstInvite.body);
  const firstInviteBody = firstInvite.json<GuestInviteResponse>();
  assert.equal(firstInviteBody.status, "invited");
  assert.equal(typeof firstInviteBody.token, "string");

  const secondInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[1]!.id, email: "bundled-guest@external.test", role: "editor" },
  });
  assert.equal(secondInvite.statusCode, 201, secondInvite.body);
  const secondInviteBody = secondInvite.json<GuestInviteResponse>();
  assert.equal(secondInviteBody.status, "invited");
  assert.equal(secondInviteBody.token, undefined);
  assert.equal(secondInviteBody.invite?.id, firstInviteBody.invite?.id);

  const inviteRows = await db.select().from(boardInvitations).where(eq(boardInvitations.email, "bundled-guest@external.test"));
  assert.equal(inviteRows.length, 1);
  const grantRows = await db.select().from(boardInvitationGrants).where(eq(boardInvitationGrants.invitationId, inviteRows[0]!.id));
  assert.deepEqual(grantRows.map((grant) => grant.boardId).sort(), workspaceBoards.map((board) => board.id).sort());

  const duplicate = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[1]!.id, email: "bundled-guest@external.test", role: "editor" },
  });
  assert.equal(duplicate.statusCode, 409);

  const pending = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/guests`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(pending.statusCode, 200);
  const pendingBody = pending.json<WorkspaceGuestsResponse>();
  assert.equal(pendingBody.pendingInvites?.length, 1);
  assert.equal(pendingBody.pendingInvites?.[0]?.boards?.length, 2);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Bundled Guest External",
      email: "bundled-guest@external.test",
      password: "Abc12345",
      displayName: "Bundled Guest",
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();

  const accept = await app.inject({
    method: "POST",
    url: `/board-invitations/${firstInviteBody.invite!.id}/accept`,
    headers: { authorization: `Bearer ${guestToken}` },
  });
  assert.equal(accept.statusCode, 200, accept.body);

  const memberships = await db.select().from(boardMembers).where(eq(boardMembers.userId, guest.id));
  assert.deepEqual(memberships.map((member) => [member.boardId, member.role]).sort(), [
    [workspaceBoards[0]!.id, "observer"],
    [workspaceBoards[1]!.id, "editor"],
  ].sort());
});

void test("workspace guest management limits one external guest to two accepted boards in the host org", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousStripeSecret = env.STRIPE_SECRET_KEY;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_fake";
  const app = await buildIntegrationServer();
  try {

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Limit Host",
      email: "guest-limit-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken } = hostSignup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Limited Workspace" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();
  // Host org is active with a purchased pool of exactly 1 seat (the owner), so the pool is full.
  await db
    .update(clients)
    .set({ billingStatus: "active", stripeSubscriptionItemId: "si_guest_limit", seatLimit: 1 })
    .where(eq(clients.id, workspace.clientId));
  // Guest assignment/removal must never touch Stripe under the pre-purchased pool model — capacity is
  // bought separately via setSeatCapacity. Any call here is a regression.
  setStripeClientForTests({
    subscriptionItems: {
      retrieve: async () => { throw new Error("Stripe should not be called during guest assignment"); },
      update: async () => { throw new Error("Stripe should not be called during guest assignment"); },
    },
  } as unknown as Stripe);

  const workspaceBoards = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "Guest One", position: "1000.0000000000", visibility: "workspace" },
      { workspaceId: workspace.id, name: "Guest Two", position: "2000.0000000000", visibility: "workspace" },
      { workspaceId: workspace.id, name: "Guest Three", position: "3000.0000000000", visibility: "workspace" },
      { workspaceId: workspace.id, name: "Guest Four", position: "4000.0000000000", visibility: "workspace" },
    ])
    .returning();
  assert.equal(workspaceBoards.length, 4);

  const externalSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Limit External",
      email: "guest-limit-external@external.test",
      password: "Abc12345",
      displayName: "External Guest",
    },
  });
  assert.equal(externalSignup.statusCode, 200);
  const { user: externalUser } = externalSignup.json<SignupResponse>();

  await db.insert(boardMembers).values([
    { boardId: workspaceBoards[0]!.id, userId: externalUser.id, role: "editor" },
    { boardId: workspaceBoards[1]!.id, userId: externalUser.id, role: "observer" },
  ]);

  // Free cap is 2 boards. Adding a 3rd crosses it and needs a pool seat, but the pool is full (1/1) →
  // block-until-buy 402 SEAT_LIMIT_REACHED, and nothing is assigned.
  const poolFull = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[2]!.id, email: "guest-limit-external@external.test", role: "editor" },
  });
  assert.equal(poolFull.statusCode, 402);
  assert.equal(poolFull.json<{ code: string }>().code, "SEAT_LIMIT_REACHED");
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 0);
  assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, externalUser.id)), 2);

  // Admin buys another seat (capacity 1 → 2). Now there is room for the guest's pooled seat. Simulated
  // with a direct seat_limit bump (the buy flow itself is covered by the billing tests).
  await db.update(clients).set({ seatLimit: 2 }).where(eq(clients.id, workspace.clientId));

  const thirdBoard = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[2]!.id, email: "guest-limit-external@external.test", role: "editor" },
  });
  assert.equal(thirdBoard.statusCode, 201);
  const thirdBody = thirdBoard.json<{ status: string; guest?: { paidGuestSeat?: boolean } }>();
  assert.equal(thirdBody.status, "added");
  assert.equal(thirdBody.guest?.paidGuestSeat, true);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 1);
  assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, externalUser.id)), 3);

  const fourthBoard = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[3]!.id, email: "guest-limit-external@external.test", role: "observer" },
  });
  assert.equal(fourthBoard.statusCode, 201);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 1);

  const removeFourth = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/${workspaceBoards[3]!.id}/${externalUser.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(removeFourth.statusCode, 200);
  assert.equal(removeFourth.json<{ paidGuestSeatRemoved: boolean }>().paidGuestSeatRemoved, false);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 1);

  const removeThird = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/${workspaceBoards[2]!.id}/${externalUser.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(removeThird.statusCode, 200);
  assert.equal(removeThird.json<{ paidGuestSeatRemoved: boolean }>().paidGuestSeatRemoved, true);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 0);

  const pendingOne = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[0]!.id, email: "pending-limit@external.test", role: "editor" },
  });
  assert.equal(pendingOne.statusCode, 201);

  const pendingTwo = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[1]!.id, email: "pending-limit@external.test", role: "observer" },
  });
  assert.equal(pendingTwo.statusCode, 201);

  const pendingThird = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[2]!.id, email: "pending-limit@external.test", role: "editor" },
  });
  assert.equal(pendingThird.statusCode, 201);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.STRIPE_SECRET_KEY = previousStripeSecret;
    setStripeClientForTests(null);
  }
});
