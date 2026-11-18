import "../../test/setup.integration.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { boardInvitationGrants, boardInvitations, boardMembers, inviteBoardGrants, inviteTokens, workspaceMembers } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

type MemberRow = { userId: string; pinned: boolean; accessSource: string | null };
type CandidateRow = { userId: string; isGuest: boolean };
type InviteRow = { id: string; kind: "guest" | "member"; email: string | null; role: string };

void test("board members menu data: admin reasons, guest candidates, and per-board invites", async () => {
  const app = await buildIntegrationServer();
  const { user: owner, auth: ownerAuth } = await signupOwner(app, { orgName: "Host", email: "menu-owner@example.com" });
  const { user: outsider } = await signupOwner(app, { orgName: "Client", email: "menu-guest@client.test", displayName: "Client Guest" });
  const ws = await app.inject({ method: "POST", url: "/workspaces", headers: ownerAuth, payload: { name: "Delivery" } });
  assert.equal(ws.statusCode, 201);
  const workspaceId = ws.json<{ id: string }>().id;
  const newBoard = async (name: string) => {
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/boards`, headers: ownerAuth, payload: { name } });
    assert.equal(res.statusCode, 201);
    return res.json<{ id: string }>().id;
  };
  const boardA = await newBoard("Alpha");
  const boardB = await newBoard("Beta");

  const [orgAdmin, wsAdmin, editor] = await insertTestUsers(db, [
    { clientId: owner.clientId, email: "menu-org-admin@example.com", passwordHash: "hash", displayName: "Org admin", clientRole: "admin" },
    { clientId: owner.clientId, email: "menu-ws-admin@example.com", passwordHash: "hash", displayName: "Workspace admin" },
    { clientId: owner.clientId, email: "menu-editor@example.com", passwordHash: "hash", displayName: "Editor" },
  ]).returning();
  assert.ok(orgAdmin && wsAdmin && editor);
  await db.insert(workspaceMembers).values([
    { workspaceId, userId: wsAdmin.id, role: "admin" },
    { workspaceId, userId: editor.id, role: "member" },
  ]);
  await db.insert(boardMembers).values([
    { boardId: boardA, userId: wsAdmin.id, role: "editor", pinned: true },
    { boardId: boardB, userId: wsAdmin.id, role: "editor", pinned: true },
    { boardId: boardA, userId: orgAdmin.id, role: "editor" },
    { boardId: boardA, userId: editor.id, role: "editor" },
    // The outsider already holds another board here, which makes them a known guest for Alpha.
    { boardId: boardB, userId: outsider.id, role: "observer" },
  ]);
  const wsAdminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: wsAdmin.id, cid: owner.clientId, role: "member" })}` };

  // Pinned rows say where their access comes from, so the menu can point at the right settings page.
  const members = await app.inject({ method: "GET", url: `/boards/${boardA}/members`, headers: ownerAuth });
  assert.equal(members.statusCode, 200);
  const sources = Object.fromEntries(members.json<MemberRow[]>().map((row) => [row.userId, row.accessSource]));
  assert.equal(sources[owner.id], "organisation_owner");
  assert.equal(sources[orgAdmin.id], "organisation_admin");
  assert.equal(sources[wsAdmin.id], "workspace_admin");
  assert.equal(sources[editor.id], null);

  // Existing guests of the organisation are offered by name, flagged so the client can preview the seat.
  const candidatesBefore = await app.inject({ method: "GET", url: `/boards/${boardA}/member-candidates`, headers: wsAdminAuth });
  assert.equal(candidatesBefore.statusCode, 200);
  const offered = candidatesBefore.json<{ members: CandidateRow[] }>().members;
  assert.deepEqual(offered.filter((row) => row.userId === outsider.id), [{ ...offered.find((row) => row.userId === outsider.id), isGuest: true }]);
  assert.equal(offered.find((row) => row.userId === editor.id)?.isGuest, false);
  const addGuest = await app.inject({ method: "POST", url: `/boards/${boardA}/members`, headers: wsAdminAuth, payload: { userId: outsider.id, role: "observer" } });
  assert.equal(addGuest.statusCode, 201);

  // A guest invitation for two boards, and an organisation invite link for Alpha.
  const inviteGuest = (boardId: string) => app.inject({
    method: "POST", url: `/workspaces/${workspaceId}/guests/invitations`, headers: wsAdminAuth,
    payload: { boardId, email: "new-client@client.test", role: "editor", assignedItemsOnly: false },
  });
  assert.equal((await inviteGuest(boardA)).statusCode, 201);
  assert.equal((await inviteGuest(boardB)).statusCode, 201);
  const link = await app.inject({
    method: "POST", url: "/clients/me/invites", headers: ownerAuth,
    payload: { orgRole: "member", workspaces: [], boards: [{ boardId: boardA, role: "observer" }], expiresInDays: 7 },
  });
  assert.equal(link.statusCode, 201);
  const linkId = link.json<{ id: string }>().id;

  const listed = await app.inject({ method: "GET", url: `/boards/${boardA}/invites`, headers: wsAdminAuth });
  assert.equal(listed.statusCode, 200);
  const invites = listed.json<InviteRow[]>();
  assert.deepEqual(invites.map(({ kind, email, role }) => ({ kind, email, role })), [
    { kind: "guest", email: "new-client@client.test", role: "editor" },
    { kind: "member", email: null, role: "observer" },
  ]);
  const guestInvite = invites.find((row) => row.kind === "guest")!;

  // Non-managers see neither the invites nor a way to withdraw them.
  const editorAuth = { authorization: `Bearer ${app.jwt.sign({ sub: editor.id, cid: owner.clientId, role: "member" })}` };
  assert.equal((await app.inject({ method: "GET", url: `/boards/${boardA}/invites`, headers: editorAuth })).statusCode, 403);

  // Withdrawing from Alpha keeps the guest's Beta invitation alive rather than revoking it outright.
  const withdrawGuest = await app.inject({ method: "DELETE", url: `/boards/${boardA}/invites/${guestInvite.id}?kind=guest`, headers: wsAdminAuth });
  assert.equal(withdrawGuest.statusCode, 204);
  const [stillOpen] = await db.select({ revokedAt: boardInvitations.revokedAt }).from(boardInvitations).where(eq(boardInvitations.id, guestInvite.id));
  assert.equal(stillOpen?.revokedAt, null);
  assert.deepEqual((await db.select({ boardId: boardInvitationGrants.boardId }).from(boardInvitationGrants).where(eq(boardInvitationGrants.invitationId, guestInvite.id))).map((row) => row.boardId), [boardB]);
  // Its last board revokes it, so redemption cannot fall back to the primary board.
  assert.equal((await app.inject({ method: "DELETE", url: `/boards/${boardB}/invites/${guestInvite.id}?kind=guest`, headers: wsAdminAuth })).statusCode, 204);
  const [revoked] = await db.select({ revokedAt: boardInvitations.revokedAt }).from(boardInvitations).where(eq(boardInvitations.id, guestInvite.id));
  assert.ok(revoked?.revokedAt);

  // Organisation invites stay an organisation-admin power; the owner can withdraw the link.
  assert.equal((await app.inject({ method: "DELETE", url: `/boards/${boardA}/invites/${linkId}?kind=member`, headers: wsAdminAuth })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: `/boards/${boardA}/invites/${linkId}?kind=invalid`, headers: ownerAuth })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/boards/${boardA}/invites/${linkId}?kind=member`, headers: ownerAuth })).statusCode, 204);
  const [linkRow] = await db.select({ revokedAt: inviteTokens.revokedAt }).from(inviteTokens).where(eq(inviteTokens.id, linkId));
  assert.ok(linkRow?.revokedAt, "an invite left with nothing to grant is revoked");
  assert.equal(await db.$count(inviteBoardGrants, eq(inviteBoardGrants.inviteId, linkId)), 0);
  // An invite id from another board is not reachable through this one.
  assert.equal((await app.inject({ method: "DELETE", url: `/boards/${boardB}/invites/${linkId}?kind=member`, headers: ownerAuth })).statusCode, 404);

  const after = await app.inject({ method: "GET", url: `/boards/${boardA}/invites`, headers: ownerAuth });
  assert.deepEqual(after.json<InviteRow[]>(), []);
  await app.close();
});
