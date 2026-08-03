import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardMembers, boards, clientMembers, clients, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import "../../test/integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { assertBoardAccess, assertWorkspaceAccess } from "../../lib/access.js";

void test("one identity resolves independent roles and access in two organisations", async () => {
  const [orgA, orgB] = await db.insert(clients).values([{ name: "Organisation A" }, { name: "Organisation B" }]).returning();
  const [user] = await insertTestUsers(db, {
    clientId: orgA!.id,
    clientRole: "admin",
    email: "multi-org-member@example.com",
    passwordHash: "hash",
    displayName: "Multi Org Member",
  }).returning();
  await db.insert(clientMembers).values({ clientId: orgB!.id, userId: user!.id, clientRole: "member" });

  const [workspaceA, workspaceB] = await db.insert(workspaces).values([
    { clientId: orgA!.id, name: "A workspace" },
    { clientId: orgB!.id, name: "B workspace" },
  ]).returning();
  const [boardA, boardB] = await db.insert(boards).values([
    { workspaceId: workspaceA!.id, name: "A board", position: "1000.0000000000" },
    { workspaceId: workspaceB!.id, name: "B board", position: "1000.0000000000" },
  ]).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspaceB!.id, userId: user!.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: boardB!.id, userId: user!.id, role: "observer" });

  const claimsA = { sub: user!.id, cid: orgA!.id, role: "admin" as const };
  const claimsB = { sub: user!.id, cid: orgB!.id, role: "member" as const };
  assert.equal((await assertWorkspaceAccess(claimsA, workspaceA!.id, "admin")).role, "admin");
  assert.equal((await assertBoardAccess(claimsA, boardA!.id, "editor")).role, "editor");
  assert.equal((await assertWorkspaceAccess(claimsB, workspaceB!.id)).role, "member");
  assert.equal((await assertBoardAccess(claimsB, boardB!.id)).role, "observer");
});
