import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardMembers, boards } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";

// Failure this catches: a direct grant looked the user up by id across every organisation, so a
// known id attached a stranger to a board without an invitation and returned their profile.
void test("a direct board grant needs an existing relationship with the organisation", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { orgName: "Host Org", email: "grant-host@example.com", displayName: "Host" });
  const stranger = await signupOwner(app, { orgName: "Elsewhere", email: "grant-stranger@example.com", displayName: "Stranger" });
  const auth = { authorization: `Bearer ${owner.accessToken}` };
  const workspace = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(workspace.statusCode, 201, workspace.body);
  const [first, second] = await db.insert(boards).values([
    { workspaceId: workspace.json<{ id: string }>().id, name: "First", position: "1000.0000000000" },
    { workspaceId: workspace.json<{ id: string }>().id, name: "Second", position: "2000.0000000000" },
  ]).returning();

  const refused = await app.inject({ method: "POST", url: `/boards/${first!.id}/members`, headers: auth, payload: { userId: stranger.user.id, role: "observer" } });
  assert.equal(refused.statusCode, 404, refused.body);
  assert.doesNotMatch(refused.body, /Stranger/);

  // Once they are a guest on one of the organisation's boards (through an accepted invitation),
  // an admin may grant them further boards directly.
  await db.insert(boardMembers).values({ boardId: second!.id, userId: stranger.user.id, role: "observer" });
  const granted = await app.inject({ method: "POST", url: `/boards/${first!.id}/members`, headers: auth, payload: { userId: stranger.user.id, role: "observer" } });
  assert.equal(granted.statusCode, 201, granted.body);
});
