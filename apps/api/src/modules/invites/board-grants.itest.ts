import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { boardMembers, boards, inviteBoardGrants, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

type App = Awaited<ReturnType<typeof buildIntegrationServer>>;
type Session = { accessToken: string; user: { id: string; clientId: string; email: string } };
type HomeBoards = { groups: Array<{ workspace: { id: string }; boards: Array<{ id: string; viewerRole: string }> }> };

async function signup(app: App, email: string, payload: Record<string, unknown> = {}): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password: "Abc12345", displayName: email.split("@")[0], ...payload },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Session>();
}

function auth(session: Session) {
  return { authorization: `Bearer ${session.accessToken}` };
}

async function standaloneBoard(clientId: string, name: string) {
  const [workspace] = await db.insert(workspaces).values({ clientId, name, kind: "board" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name, position: "1000.0000000000" }).returning();
  return { workspace: workspace!, board: board! };
}

async function workspaceBoard(clientId: string, name: string) {
  const [workspace] = await db.insert(workspaces).values({ clientId, name: `${name} workspace` }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name, position: "1000.0000000000" }).returning();
  return { workspace: workspace!, board: board! };
}

async function homeBoardIds(app: App, session: Session) {
  const response = await app.inject({ method: "GET", url: "/home/boards", headers: auth(session) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<HomeBoards>().groups.flatMap((group) => group.boards.map((board) => ({ id: board.id, viewerRole: board.viewerRole })));
}

void test("an organisation-only invite with no workspaces or boards is valid", async () => {
  const app = await buildIntegrationServer();
  const owner = await signup(app, "org-only-owner@example.com", { orgName: "Org only" });
  const created = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: auth(owner),
    payload: { orgRole: "member", workspaces: [] },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json<{ boards: unknown[] }>().boards, []);
  const invitee = await signup(app, "org-only-invitee@example.com", { inviteToken: created.json<{ token: string }>().token });
  assert.equal(invitee.user.clientId, owner.user.clientId);
});

void test("a standalone-board owner invites someone onto that board, and signup makes them a board member", async () => {
  const app = await buildIntegrationServer();
  const owner = await signup(app, "solo-owner@example.com", { orgName: "Solo" });
  const { workspace, board } = await standaloneBoard(owner.user.clientId, "Launch plan");

  const created = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: auth(owner),
    payload: { orgRole: "member", boards: [{ boardId: board.id }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { token, boards: grantedBoards } = created.json<{ token: string; boards: Array<{ boardId: string; role: string }> }>();
  // The role defaults to editor, the most common reason to invite someone onto a board.
  assert.deepEqual(grantedBoards, [{ boardId: board.id, role: "editor" }]);

  const listed = await app.inject({ method: "GET", url: "/clients/me/invites", headers: auth(owner) });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json<Array<{ boards: unknown[] }>>()[0]!.boards, [{ boardId: board.id, boardName: "Launch plan", role: "editor" }]);

  const invitee = await signup(app, "solo-invitee@example.com", { inviteToken: token });
  const [member] = await db.select().from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, invitee.user.id)));
  assert.equal(member?.role, "editor");
  assert.equal(member?.pinned, false, "an invite grant is an ordinary membership an admin can change or remove");
  // The hidden standalone workspace row is what Home discovery reads for organisation members.
  assert.equal(await db.$count(workspaceMembers, and(
    eq(workspaceMembers.workspaceId, workspace.id),
    eq(workspaceMembers.userId, invitee.user.id),
    eq(workspaceMembers.role, "member"),
  )), 1);
  assert.deepEqual(await homeBoardIds(app, invitee), [{ id: board.id, viewerRole: "editor" }]);
  const opened = await app.inject({ method: "GET", url: `/boards/${board.id}`, headers: auth(invitee) });
  assert.equal(opened.statusCode, 200, opened.body);
});

void test("an existing account accepting an invite receives its board grants", async () => {
  const app = await buildIntegrationServer();
  const host = await signup(app, "grant-host@example.com", { orgName: "Grant host" });
  const existing = await signup(app, "grant-existing@example.com", { orgName: "Existing home" });
  const { workspace, board } = await workspaceBoard(host.user.clientId, "Roadmap");
  const { board: otherBoard } = await workspaceBoard(host.user.clientId, "Not granted");

  const created = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: auth(host),
    payload: { orgRole: "member", workspaces: [], boards: [{ boardId: board.id, role: "observer" }] },
  });
  assert.equal(created.statusCode, 201, created.body);

  const accepted = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: auth(existing),
    payload: { token: created.json<{ token: string }>().token },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const session = accepted.json<Session>();

  const [member] = await db.select().from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, existing.user.id)));
  assert.equal(member?.role, "observer");
  // A board in a workspace makes its members workspace members too (the board members menu only
  // offers workspace members), but workspace membership still grants no other board.
  assert.equal(await db.$count(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, existing.user.id))), 1);
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, otherBoard.id), eq(boardMembers.userId, existing.user.id))), 0);
  assert.deepEqual(await homeBoardIds(app, session), [{ id: board.id, viewerRole: "observer" }]);
});

void test("an invite cannot grant another organisation's board, an archived board, or boards to an admin", async () => {
  const app = await buildIntegrationServer();
  const host = await signup(app, "tenancy-host@example.com", { orgName: "Tenancy host" });
  const other = await signup(app, "tenancy-other@example.com", { orgName: "Tenancy other" });
  const { board: foreignBoard } = await standaloneBoard(other.user.clientId, "Foreign");
  const { board: ownBoard } = await standaloneBoard(host.user.clientId, "Own");
  const [archived] = await db.insert(boards).values({ workspaceId: ownBoard.workspaceId, name: "Archived", position: "2000.0000000000", archivedAt: new Date() }).returning();

  for (const payload of [
    { orgRole: "member", boards: [{ boardId: foreignBoard.id }] },
    { orgRole: "member", boards: [{ boardId: ownBoard.id }, { boardId: foreignBoard.id }] },
    { orgRole: "member", boards: [{ boardId: archived!.id }] },
    { orgRole: "member", boards: [{ boardId: ownBoard.id }, { boardId: ownBoard.id, role: "observer" }] },
    { orgRole: "admin", boards: [{ boardId: ownBoard.id }] },
  ]) {
    const response = await app.inject({ method: "POST", url: "/clients/me/invites", headers: auth(host), payload });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} → ${response.body}`);
  }
  assert.equal(await db.$count(inviteBoardGrants), 0);
});

void test("a board deleted after the invite was created is skipped on acceptance", async () => {
  const app = await buildIntegrationServer();
  const host = await signup(app, "deleted-host@example.com", { orgName: "Deleted host" });
  const { board: kept } = await standaloneBoard(host.user.clientId, "Kept");
  const { board: removed } = await standaloneBoard(host.user.clientId, "Removed");
  const created = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: auth(host),
    payload: { orgRole: "member", boards: [{ boardId: kept.id }, { boardId: removed.id }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  await db.delete(boards).where(eq(boards.id, removed.id));

  const invitee = await signup(app, "deleted-invitee@example.com", { inviteToken: created.json<{ token: string }>().token });
  assert.deepEqual(await homeBoardIds(app, invitee), [{ id: kept.id, viewerRole: "editor" }]);
});
