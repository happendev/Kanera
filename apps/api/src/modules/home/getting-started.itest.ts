import "../../test/setup.integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import type { HomeGettingStartedResponse } from "@kanera/shared/dto";
import { activityEvents, automations, boardMembers, boards, clients, inviteTokens, lists, notes, oauthClients, oauthGrants, scratchpadNotes, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

/**
 * Isolated rather than E2E: each step is derived from a different table, and the role filter and
 * "derived, never marked" rule are what break silently. E2E covers the card itself and the palette.
 */
async function seed() {
  const app = await buildIntegrationServer();
  const [client] = await db.insert(clients).values({ name: "Checklist org" }).returning();
  const [admin, member] = await insertTestUsers(db, [
    { clientId: client!.id, email: "admin@checklist.test", passwordHash: "x", displayName: "Admin", clientRole: "admin" },
    { clientId: client!.id, email: "member@checklist.test", passwordHash: "x", displayName: "Member", clientRole: "member" },
  ]).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Delivery" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Roadmap", position: "1000.0000000000" }).returning();
  const [list] = await db.insert(lists).values({ workspaceId: workspace!.id, name: "Doing", position: "1000.0000000000" }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace!.id, userId: admin!.id, role: "admin" },
    { workspaceId: workspace!.id, userId: member!.id, role: "member" },
  ]);
  await db.insert(boardMembers).values([
    { boardId: board!.id, userId: admin!.id, role: "editor" },
    { boardId: board!.id, userId: member!.id, role: "editor" },
  ]);
  return {
    app,
    client: client!,
    admin: admin!,
    member: member!,
    workspace: workspace!,
    board: board!,
    list: list!,
    adminToken: app.jwt.sign({ sub: admin!.id, cid: client!.id, role: "admin" }),
    memberToken: app.jwt.sign({ sub: member!.id, cid: client!.id, role: "member" }),
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function load(f: Fixture, token: string): Promise<HomeGettingStartedResponse> {
  const response = await f.app.inject({ method: "GET", url: "/home/getting-started", headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<HomeGettingStartedResponse>();
}

/** Push depends on the deployment's VAPID key, so the assertions here leave it out. */
function stepState(body: HomeGettingStartedResponse): Record<string, boolean> {
  return Object.fromEntries(body.steps.filter((step) => step.key !== "enablePush").map((step) => [step.key, step.done]));
}

test("members get only the personal steps; admins get the team steps and the workspace to do them in", async () => {
  const f = await seed();
  try {
    const member = await load(f, f.memberToken);
    assert.deepEqual(Object.keys(stepState(member)), [
      "createCard", "assignCard", "comment", "mention", "addDependency", "completeCard",
      "quickEdit", "useFilter", "commandPalette", "viewWorkDone", "scratchpad", "saveNote", "connectAgent", "useAgent",
    ]);
    assert.equal(member.notesWorkspaceId, f.workspace.id);
    assert.equal(member.teamTarget, null);

    const admin = await load(f, f.adminToken);
    // The second organisation member already counts as an invited team.
    assert.deepEqual(stepState(admin), {
      createCard: false,
      assignCard: false,
      comment: false,
      mention: false,
      addDependency: false,
      completeCard: false,
      quickEdit: false,
      useFilter: false,
      commandPalette: false,
      viewWorkDone: false,
      scratchpad: false,
      saveNote: false,
      inviteTeam: true,
      secondBoard: false,
      createAutomation: false,
      connectAgent: false,
      useAgent: false,
    });
    assert.deepEqual(admin.teamTarget, { workspaceId: f.workspace.id });
  } finally {
    await f.app.close();
  }
});

test("steps tick themselves off from the rows each step creates", async () => {
  const f = await seed();
  try {
    // A template recipe is written in the workspace's own creation transaction, so it carries the
    // workspace's created_at. It is not something the admin built.
    await db.insert(automations).values({ workspaceId: f.workspace.id, position: "500.0000000000", triggerType: "card_marked_complete", createdAt: f.workspace.createdAt });
    assert.equal(stepState(await load(f, f.adminToken)).createAutomation, false);

    await db.insert(boards).values({ workspaceId: f.workspace.id, name: "Hiring", position: "2000.0000000000" });
    await db.insert(automations).values({ workspaceId: f.workspace.id, position: "1000.0000000000", triggerType: "card_marked_complete", enabled: false });
    await db.insert(oauthClients).values({ clientId: "checklist-cli", kind: "public", name: "Kanera CLI", grantTypes: ["authorization_code"] }).onConflictDoNothing();
    await db.insert(oauthGrants).values({ clientId: "checklist-cli", userId: f.admin.id, orgClientId: f.client.id, scopes: ["read"], resource: "https://mcp.example.test/mcp" });

    assert.deepEqual(stepState(await load(f, f.adminToken)), {
      createCard: false,
      assignCard: false,
      comment: false,
      mention: false,
      addDependency: false,
      completeCard: false,
      quickEdit: false,
      useFilter: false,
      commandPalette: false,
      viewWorkDone: false,
      scratchpad: false,
      saveNote: false,
      inviteTeam: true,
      secondBoard: true,
      createAutomation: true,
      connectAgent: true,
      useAgent: false,
    });
    // The agent connection is personal: the member has not connected one.
    assert.equal(stepState(await load(f, f.memberToken)).connectAgent, false);

    // Connecting is not using: the next step waits for a change the agent made for this person.
    const [grant] = await db.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.userId, f.admin.id));
    await db.insert(activityEvents).values({
      workspaceId: f.workspace.id, boardId: f.board.id, actorId: f.admin.id, actorKind: "agent", agentGrantId: grant!.id, agentName: "Claude",
      entityType: "card", entityId: f.board.id, action: "moved",
    });
    assert.equal(stepState(await load(f, f.adminToken)).useAgent, true);
    assert.equal(stepState(await load(f, f.memberToken)).useAgent, false);
    // Agent work implies a connection, even once the grant behind it is revoked.
    await db.update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.id, grant!.id));
    assert.equal(stepState(await load(f, f.adminToken)).connectAgent, true);
  } finally {
    await f.app.close();
  }
});

test("the basics tick from the cards, assignments and dependencies each person makes", async () => {
  const f = await seed();
  try {
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    // A template's starter card is logged in the workspace's creation transaction, so it shares
    // the workspace's created_at and is not the user's first card.
    await db.insert(activityEvents).values({
      workspaceId: f.workspace.id, clientId: f.client.id, boardId: f.board.id, actorId: f.admin.id,
      entityType: "card", entityId: f.board.id, action: "created", createdAt: f.workspace.createdAt,
    });
    assert.equal(stepState(await load(f, f.adminToken)).createCard, false);

    const first = await f.app.inject({ method: "POST", url: `/boards/${f.board.id}/lists/${f.list.id}/cards`, headers: as(f.memberToken), payload: { title: "First" } });
    assert.equal(first.statusCode, 201, first.body);
    let member = stepState(await load(f, f.memberToken));
    assert.equal(member.createCard, true);
    assert.equal(member.assignCard, false);
    // Personal: a teammate's card does not tick the admin's step.
    assert.equal(stepState(await load(f, f.adminToken)).createCard, false);

    // Assignees chosen in the composer are logged with the creation, not as an assignee change.
    const second = await f.app.inject({
      method: "POST", url: `/boards/${f.board.id}/lists/${f.list.id}/cards`, headers: as(f.memberToken),
      payload: { title: "Second", assigneeIds: [f.member.id] },
    });
    assert.equal(second.statusCode, 201, second.body);
    member = stepState(await load(f, f.memberToken));
    assert.equal(member.assignCard, true);
    assert.equal(member.addDependency, false);

    const firstId = first.json<{ id: string }>().id;
    const secondId = second.json<{ id: string }>().id;
    // Clearing assignees is not assigning; setting one is.
    const cleared = await f.app.inject({ method: "PUT", url: `/cards/${secondId}/assignees`, headers: as(f.adminToken), payload: { userIds: [] } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(stepState(await load(f, f.adminToken)).assignCard, false);
    const assigned = await f.app.inject({ method: "PUT", url: `/cards/${firstId}/assignees`, headers: as(f.adminToken), payload: { userIds: [f.member.id] } });
    assert.equal(assigned.statusCode, 200, assigned.body);
    assert.equal(stepState(await load(f, f.adminToken)).assignCard, true);

    const linked = await f.app.inject({ method: "POST", url: `/cards/${firstId}/relations`, headers: as(f.memberToken), payload: { targetCardId: secondId, direction: "blocks" } });
    assert.ok(linked.statusCode < 300, linked.body);
    assert.equal(stepState(await load(f, f.memberToken)).addDependency, true);
    assert.equal(stepState(await load(f, f.adminToken)).addDependency, false);

    const comment = await f.app.inject({ method: "POST", url: `/cards/${firstId}/comments`, headers: as(f.memberToken), payload: { body: "Looks good" } });
    assert.ok(comment.statusCode < 300, comment.body);
    member = stepState(await load(f, f.memberToken));
    assert.equal(member.comment, true);
    assert.equal(member.mention, false);
    const mention = await f.app.inject({
      method: "POST", url: `/cards/${firstId}/comments`, headers: as(f.memberToken),
      payload: { body: `Over to you @[Admin](kanera-user:${f.admin.id})` },
    });
    assert.ok(mention.statusCode < 300, mention.body);
    assert.equal(stepState(await load(f, f.memberToken)).mention, true);
    // Being mentioned is not mentioning.
    assert.equal(stepState(await load(f, f.adminToken)).mention, false);

    const completed = await f.app.inject({ method: "PATCH", url: `/cards/${firstId}/completion`, headers: as(f.memberToken), payload: { completed: true } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(stepState(await load(f, f.memberToken)).completeCard, true);
    assert.equal(stepState(await load(f, f.adminToken)).completeCard, false);
  } finally {
    await f.app.close();
  }
});

test("notes and scratchpad count only once something is written, and only where they are switched on", async () => {
  const f = await seed();
  try {
    // Both create blank rows the moment the page or note is added; a blank row is not use.
    await db.insert(scratchpadNotes).values({ userId: f.member.id, clientId: f.client.id, position: "1000.0000000000" });
    await db.insert(notes).values({ workspaceId: f.workspace.id, ownerId: f.member.id, lastEditedById: f.member.id, scope: "personal", position: "1000.0000000000" });
    let member = stepState(await load(f, f.memberToken));
    assert.equal(member.scratchpad, false);
    assert.equal(member.saveNote, false);

    await db.update(scratchpadNotes).set({ content: "Call the printer" }).where(eq(scratchpadNotes.userId, f.member.id));
    await db.update(notes).set({ title: "Launch plan" }).where(eq(notes.ownerId, f.member.id));
    member = stepState(await load(f, f.memberToken));
    assert.equal(member.scratchpad, true);
    assert.equal(member.saveNote, true);

    // Switched off: the admin, who has saved no note, loses the step; the scratchpad step follows
    // the Preferences toggle.
    await db.update(workspaces).set({ notesEnabled: false }).where(eq(workspaces.id, f.workspace.id));
    await db.update(users).set({ showScratchpad: false }).where(eq(users.id, f.admin.id));
    const admin = await load(f, f.adminToken);
    assert.equal(admin.notesWorkspaceId, null);
    assert.equal("saveNote" in stepState(admin), false);
    assert.equal("scratchpad" in stepState(admin), false);
  } finally {
    await f.app.close();
  }
});

test("the checklist retires itself for accounts older than 35 days", async () => {
  const f = await seed();
  try {
    await db.update(users).set({ createdAt: new Date(Date.now() - 36 * 86_400_000) }).where(eq(users.id, f.member.id));
    assert.equal((await load(f, f.memberToken)).dismissed, true);
    assert.equal((await load(f, f.adminToken)).dismissed, false);
  } finally {
    await f.app.close();
  }
});

test("a pending invite ticks the invite step before anyone accepts it", async () => {
  const f = await seed();
  try {
    // Alone in the organisation, the step is open.
    const [solo] = await db.insert(clients).values({ name: "Solo org" }).returning();
    const [owner] = await insertTestUsers(db, {
      clientId: solo!.id, email: "owner@solo.test", passwordHash: "x", displayName: "Owner", clientRole: "owner",
    }).returning();
    const token = f.app.jwt.sign({ sub: owner!.id, cid: solo!.id, role: "owner" });
    assert.equal(stepState(await load(f, token)).inviteTeam, false);

    await db.insert(inviteTokens).values({ clientId: solo!.id, tokenHash: "checklist-invite", email: "new@solo.test", createdById: owner!.id });
    assert.equal(stepState(await load(f, token)).inviteTeam, true);
  } finally {
    await f.app.close();
  }
});

test("the palette stamp and dismissal are one-way and personal, and hiding toggles", async () => {
  const f = await seed();
  try {
    const patch = (payload: Record<string, unknown>) => f.app.inject({
      method: "PATCH",
      url: "/home/getting-started",
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload,
    });

    const stamped = await patch({ used: "commandPalette" });
    assert.equal(stamped.statusCode, 200, stamped.body);
    assert.equal(stepState(stamped.json<HomeGettingStartedResponse>()).commandPalette, true);
    const [first] = await db.select({ used: users.gettingStartedUsed }).from(users).where(eq(users.id, f.admin.id));
    await patch({ used: "commandPalette" });
    await patch({ used: "quickEdit" });
    const [second] = await db.select({ used: users.gettingStartedUsed }).from(users).where(eq(users.id, f.admin.id));
    // The first stamp is kept, and a second step adds to the map rather than replacing it.
    assert.equal(second!.used.commandPalette, first!.used.commandPalette);
    assert.ok(second!.used.quickEdit);
    // Only steps with no trace of their own can be stamped.
    assert.equal((await patch({ used: "createCard" })).statusCode, 400);

    // There is no way to un-dismiss or un-use: anything but `true` is rejected.
    assert.equal((await patch({ dismissed: false })).statusCode, 400);

    // Hiding moves the checklist to the account menu and keeps its progress; it can come back.
    const hidden = (await patch({ hidden: true })).json<HomeGettingStartedResponse>();
    assert.equal(hidden.hidden, true);
    assert.equal(stepState(hidden).commandPalette, true);
    assert.equal((await patch({ hidden: false })).json<HomeGettingStartedResponse>().hidden, false);

    const closed = await patch({ dismissed: true });
    assert.deepEqual(closed.json(), { dismissed: true, hidden: false, steps: [], teamTarget: null, notesWorkspaceId: null });
    assert.equal((await load(f, f.memberToken)).dismissed, false);
  } finally {
    await f.app.close();
  }
});
